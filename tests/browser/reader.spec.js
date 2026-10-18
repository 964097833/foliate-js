import { chromium } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { test, expect, ready, openBook, position, translated, configureTranslation, monitorContext } from './fixtures.js'

const fault = process.env.FOLIATE_TEST_FAULT

test('browser regressions and asynchronous error gate', async ({ page, fixture }, testInfo) => {
    await page.goto(new URL('/tests/tests.html', fixture.url).href)
    await expect(page.locator('#test-status')).toHaveAttribute('data-state', 'passed')
    await expect(page.locator('#test-status')).toHaveAttribute('data-assertions', /^\d+$/)
    expect(Number(await page.locator('#test-status').getAttribute('data-assertions'))).toBeGreaterThan(0)
    await testInfo.attach('browser-assertions', {
        body: await page.locator('#test-status').textContent(), contentType: 'text/plain',
    })
    if (['assertion', 'runtime', 'rejection'].includes(fault)) {
        await page.evaluate(kind => {
            if (kind === 'assertion') console.assert(false, 'Injected acceptance failure')
            if (kind === 'runtime') setTimeout(() => { throw new Error('Injected runtime failure') }, 0)
            if (kind === 'rejection') Promise.reject(new Error('Injected rejection failure'))
        }, fault)
        // A late fault must change the result after the suite has already passed.
        await expect(page.locator('#test-status')).toHaveAttribute('data-state', 'failed')
    }
    if (fault === 'timeout')
        await expect(page.locator('#never-completes')).toBeVisible({ timeout: 1000 })
    expect(await page.locator('#test-status').getAttribute('data-state')).toBe('passed')
})

test('original reading, next page and table of contents', async ({ page, fixture }) => {
    await page.goto(fixture.url)
    await openBook(page, fixture.book)
    const before = await position(page)
    await page.locator('#right-button').click()
    await expect.poll(async () => (await position(page)).cfi).not.toBe(before.cfi)
    await page.locator('#side-bar-button').click()
    await page.locator('#toc-view').getByText('Chapter Two', { exact: true }).click()
    await expect.poll(() => page.evaluate(() =>
        globalThis.reader.view.renderer.getContents()[0]?.doc.querySelector('h1')?.textContent)).toBe('Chapter Two')
    const chapter = (await position(page)).cfi
    await page.reload()
    await ready(page)
    await expect.poll(async () => (await position(page)).cfi).toBe(chapter)
    if (['runtime', 'rejection'].includes(fault)) {
        const exception = page.waitForEvent('pageerror')
        await page.evaluate(kind => {
            if (kind === 'runtime') setTimeout(() => { throw new Error('Injected runtime failure') }, 0)
            else Promise.reject(new Error('Injected rejection failure'))
        }, fault)
        await exception
    }

})

for (const flow of ['paginated', 'scrolled']) test(`${flow}: translation, reload and book return`, async ({ page, fixture }, testInfo) => {
    await page.goto(fixture.url)
    await openBook(page, fixture.book)
    await configureTranslation(page, fixture)
    await page.locator('#reading-mode').selectOption('bilingual')
    await translated(page)
    await expect.poll(() => page.evaluate(() => {
        const doc = globalThis.reader.view.renderer.getContents()[0].doc
        const source = doc.querySelector('[data-foliate-source-text]')
        const output = doc.querySelector('[data-foliate-translation]')
        return [source, output].every(node => node.getClientRects().length > 0)
    })).toBe(true)
    await page.locator('#reading-mode').selectOption('translation')
    await translated(page)
    if (flow === 'scrolled') {
        await page.locator('#menu-button > button').click()
        await page.getByRole('menuitemradio', { name: 'Scrolled', exact: true }).click()
        await expect.poll(async () => (await position(page)).flow).toBe(flow)
        // Drive the actual scroll path, so persistence must see a real scroll event.
        await page.evaluate(() => globalThis.reader.view.renderer.scrollBy(1200, 0))
    } else await page.locator('#right-button').click()
    await expect.poll(async () => (await position(page)).translation?.offset ?? 0).toBeGreaterThan(0)
    await translated(page)
    // Wait for the saved position and cached translations, not an arbitrary delay.
    await expect.poll(() => page.evaluate(() => {
        const id = JSON.parse(localStorage.getItem('foliate:last-book')).id
        const saved = JSON.parse(localStorage.getItem('foliate:progress:' + id))
        return JSON.stringify(saved?.translation) === JSON.stringify(globalThis.reader.translation.getPosition())
    })).toBe(true)
    await expect.poll(() => page.evaluate(async () => {
        const { loadTranslations } = await import('/ui/reader-storage.js')
        const id = JSON.parse(localStorage.getItem('foliate:last-book')).id
        return (await loadTranslations(id)).length
    })).toBeGreaterThan(0)
    const before = await position(page)
    const requests = fixture.getRequests()
    if (fault === 'position') await page.evaluate(() => {
        const id = JSON.parse(localStorage.getItem('foliate:last-book')).id
        const key = 'foliate:progress:' + id
        const saved = JSON.parse(localStorage.getItem(key))
        saved.translation.offset = 0
        localStorage.setItem(key, JSON.stringify(saved))
        // Prevent the normal pagehide flush from repairing the injected corruption.
        localStorage.setItem = () => {}
    })
    if (fault === 'cache') await page.evaluate(async () => {
        const { clearTranslations } = await import('/ui/reader-storage.js')
        await clearTranslations(JSON.parse(localStorage.getItem('foliate:last-book')).id)
    })
    await page.reload()
    await ready(page)
    await translated(page)
    const checkRestored = async () => {
        await expect.poll(async () => (await position(page)).inTranslation,
            { message: 'Restored translated reading position' }).toBe(true)
        await expect(page.locator('#reading-mode')).toHaveValue(before.mode)
        await expect.poll(async () => (await position(page)).flow).toBe(before.flow)
        await expect.poll(async () => (await position(page)).translation?.key).toBe(before.translation.key)
        await expect.poll(async () => (await position(page)).translation?.offset,
            { message: 'Restored translated reading position' }).toBe(before.translation.offset)
        if (flow === 'scrolled')
            await expect.poll(async () => Math.abs((await position(page)).translation?.viewportOffset
                - before.translation.viewportOffset)).toBeLessThan(1)
        expect(fixture.getRequests(), 'Reload/return must reuse cached translations').toBe(requests)
    }
    await checkRestored()
    await openBook(page, fixture.otherBook, 'Another Book')
    await expect(page.locator('#reading-mode')).toHaveValue('original')
    await expect(page.locator('#translation-status-bar')).toBeHidden()
    await openBook(page, fixture.book)
    await translated(page)
    await checkRestored()
    await testInfo.attach('reading-state', {
        body: JSON.stringify({ before, after: await position(page), requests: fixture.getRequests() }, null, 2),
        contentType: 'application/json',
    })
})

test('browser restart restores the cached book, translation and reading position', async ({ fixture, browserErrors }, testInfo) => {
    const profile = await mkdtemp(tmpdir() + '/foliate-browser-profile-')
    let context
    const launch = async () => {
        context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
        })
        await monitorContext(context, browserErrors)
        return context.pages()[0]
    }
    const close = async () => {
        if (!context) return
        const closing = context
        context = null
        await closing.close()
    }
    try {
        let page = await launch()
        await page.goto(fixture.url)
        await openBook(page, fixture.book)
        await configureTranslation(page, fixture)
        await page.locator('#reading-mode').selectOption('translation')
        await translated(page)
        await page.locator('#right-button').click()
        await expect.poll(async () => (await position(page)).translation?.offset ?? 0).toBeGreaterThan(0)
        await translated(page)
        const before = await position(page)
        const requests = fixture.getRequests()
        // Close the browser process, then launch a new one with the same test profile.
        await close()
        page = await launch()
        await page.goto(fixture.url)
        await ready(page)
        await translated(page)
        await expect(page.locator('#header-title')).toHaveText('网页阅读回归测试')
        await expect.poll(async () => (await position(page)).translation).toEqual(before.translation)
        expect((await position(page)).inTranslation).toBe(true)
        expect(fixture.getRequests(), 'Restart must reuse cached translations').toBe(requests)
        await testInfo.attach('reading-state', {
            body: JSON.stringify({ before, after: await position(page), requests }, null, 2),
            contentType: 'application/json',
        })
    } finally {
        try { await close() }
        finally { await rm(profile, { recursive: true, force: true }) }
    }
})
