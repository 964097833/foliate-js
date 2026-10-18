import { chromium } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { test, expect, ready, openBook, position, translated, configureTranslation, monitorContext } from './fixtures.js'

const fault = process.env.FOLIATE_TEST_FAULT

test('browser regressions and asynchronous error gate', async ({ page, fixture }, testInfo) => {
    await page.goto(new URL('/tests/tests.html', fixture.url).href)
    await expect(page.locator('#test-status')).toHaveAttribute('data-state', 'passed', { timeout: 20_000 })
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

for (const formatted of [false, true]) test(`browser restart restores the cached book, translation and reading position${formatted ? ' (formatted)' : ''}`, async ({ fixture, browserErrors }, testInfo) => {
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
        const title = formatted ? '网页格式回归测试' : '网页阅读回归测试'
        await openBook(page, formatted ? fixture.formattedBook : fixture.book, title)
        await configureTranslation(page, fixture)
        await page.locator('#reading-mode').selectOption('translation')
        await translated(page)
        if (formatted) {
            await page.evaluate(() => globalThis.reader.view.goTo('one.xhtml#long'))
            await expect.poll(() => page.evaluate(() => globalThis.reader.view.renderer.getContents()[0].doc
                .querySelector('#long > [data-foliate-translation]')?.getAttribute('data-foliate-state'))).toBe('complete')
            await translated(page)
            await page.waitForLoadState('networkidle')
        }
        await page.locator('#right-button').click()
        await expect.poll(async () => (await position(page)).translation?.offset ?? 0).toBeGreaterThan(0)
        await translated(page)
        await page.waitForLoadState('networkidle')
        const before = await position(page)
        const requests = fixture.getRequests()
        // Close the browser process, then launch a new one with the same test profile.
        await close()
        page = await launch()
        await page.goto(fixture.url)
        await ready(page)
        await translated(page)
        await expect(page.locator('#header-title')).toHaveText(title)
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

for (const flow of ['paginated', 'scrolled']) test(`${flow}: formatted caches and reading positions survive reload`, async ({ page, fixture }, testInfo) => {
    await page.goto(fixture.url)
    await openBook(page, fixture.formattedBook, '网页格式回归测试')
    await configureTranslation(page, fixture)
    const seeded = await page.evaluate(async () => {
        const { saveTranslations } = await import('/ui/reader-storage.js')
        const doc = globalThis.reader.view.renderer.getContents()[0].doc
        const id = JSON.parse(localStorage.getItem('foliate:last-book')).id
        const entries = ['heading', 'subheading', 'emphasis', 'lines', 'long'].map(name => {
            const element = doc.getElementById(name)
            const [section, ordinal] = element.getAttribute('data-foliate-paragraph').split('-')
            const text = Array.from(element.querySelectorAll('[data-foliate-source-text]'), node => node.textContent)
                .join('').replace(/\s+/g, ' ').trim()
            return { key: `${section}:${ordinal}:${text}`, text: `已有译文：${name}` }
        })
        await saveTranslations(id, entries)
        return entries
    })
    await page.reload()
    await ready(page)
    await page.locator('#reading-mode').selectOption('bilingual')
    await translated(page)
    const formatting = () => page.evaluate(() => {
        const doc = globalThis.reader.view.renderer.getContents()[0].doc
        const output = id => doc.querySelector(`#${id} > [data-foliate-translation]`)
        const style = id => doc.defaultView.getComputedStyle(output(id))
        return {
            heading: parseFloat(style('heading').fontSize),
            subheading: parseFloat(style('subheading').fontSize),
            emphasis: [style('emphasis').fontSize, style('emphasis').fontWeight,
                style('emphasis').fontStyle, style('emphasis').textAlign, output('emphasis').textContent],
            lines: output('lines').textContent,
            pre: output('pre').textContent,
        }
    })
    const styles = await formatting()
    expect(styles.heading).toBeGreaterThan(styles.subheading)
    expect(styles.emphasis).toEqual(['24px', '700', 'italic', 'center', '已有译文：emphasis'])
    expect(styles.lines).toBe('测试译文：First verse\n\n测试译文：Second verse')
    expect(styles.pre).toBe('  测试译文：Alpha\n\t测试译文：Beta')
    await page.locator('#reading-mode').selectOption('translation')
    await translated(page)
    if (flow === 'scrolled') {
        await page.locator('#menu-button > button').click()
        await page.getByRole('menuitemradio', { name: 'Scrolled', exact: true }).click()
        await expect.poll(async () => (await position(page)).flow).toBe(flow)
    }
    await page.evaluate(() => globalThis.reader.view.goTo('one.xhtml#long'))
    await expect.poll(() => page.evaluate(() => globalThis.reader.view.renderer.getContents()[0].doc
        .querySelector('#long > [data-foliate-translation]')?.getAttribute('data-foliate-state'))).toBe('complete')
    await translated(page)
    await page.waitForLoadState('networkidle')
    const inlineTitleStyle = () => page.evaluate(() => {
        const doc = globalThis.reader.view.renderer.getContents()[0].doc
        const output = doc.querySelector('#long > [data-foliate-translation]')
        const title = output.querySelector('[data-foliate-translation-title]')
        return [doc.defaultView.getComputedStyle(title).fontWeight,
            doc.defaultView.getComputedStyle(output).fontWeight, title.textContent]
    })
    expect(await inlineTitleStyle()).toEqual(['700', '400', '测试译文：Risk-taking:'])
    if (flow === 'scrolled') await page.evaluate(() => globalThis.reader.view.renderer.scrollBy(1200, 0))
    else await page.locator('#right-button').click()
    await expect.poll(async () => (await position(page)).translation?.offset ?? 0).toBeGreaterThan(0)
    await expect.poll(async () => (await position(page)).inTranslation).toBe(true)
    await translated(page)
    await page.waitForLoadState('networkidle')
    const before = await position(page)
    const requests = fixture.getRequests()
    const cache = () => page.evaluate(async () => {
        const { loadTranslations } = await import('/ui/reader-storage.js')
        return loadTranslations(JSON.parse(localStorage.getItem('foliate:last-book')).id)
    })
    const cached = await cache()
    for (const entry of seeded) expect(cached).toContainEqual(entry)
    expect(cached.some(entry => entry.key.includes('layout-v1:') && entry.text.includes('\n'))).toBe(true)
    await page.reload()
    await ready(page)
    await translated(page)
    await page.waitForLoadState('networkidle')
    await expect.poll(async () => (await position(page)).translation?.key).toBe(before.translation.key)
    await expect.poll(async () => (await position(page)).translation?.offset).toBe(before.translation.offset)
    if (flow === 'scrolled')
        await expect.poll(async () => Math.abs((await position(page)).translation?.viewportOffset
            - before.translation.viewportOffset)).toBeLessThan(1)
    expect((await position(page)).flow).toBe(flow)
    expect((await position(page)).mode).toBe('translation')
    expect((await position(page)).inTranslation).toBe(true)
    expect(fixture.getRequests(), 'Formatted caches must avoid repeat model calls after reload').toBe(requests)
    expect(await cache()).toEqual(cached)
    expect(await formatting()).toEqual(styles)
    expect(await inlineTitleStyle()).toEqual(['700', '400', '测试译文：Risk-taking:'])
    await testInfo.attach('formatted-reading-state', {
        body: JSON.stringify({ before, after: await position(page), requests,
            cacheEntries: cached.length, formatting: styles }, null, 2), contentType: 'application/json',
    })
})
