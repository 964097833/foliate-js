import { test as base, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createReaderFixture } from '../web-reader-fixture.js'
import { observePage, attachFailureSnapshots } from './diagnostics.js'

export const monitorContext = async (context, errors) => {
    await context.addInitScript(() => {
        globalThis.__foliateReaderEvents = []
        document.addEventListener('reader-state-change', ({ detail }) => {
            globalThis.__foliateReaderEvents.push({ ...detail, time: Date.now() })
            if (globalThis.__foliateReaderEvents.length > 25) globalThis.__foliateReaderEvents.shift()
        })
    })
    const observe = page => {
        observePage(page)
        page.on('pageerror', error => errors.push(error.stack ?? error.message))
        page.on('console', message => {
            if (['error', 'assert'].includes(message.type()))
                errors.push(`${message.type()}: ${message.text()} ${JSON.stringify(message.location())}`)
        })
    }
    context.on('page', observe)
    for (const page of context.pages()) observe(page)
    await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }))
    await context.route('**/tests/**', async route => {
        const pathname = new URL(route.request().url()).pathname
        const file = new URL('../..' + pathname, import.meta.url)
        if (!fileURLToPath(file).startsWith(fileURLToPath(new URL('../', import.meta.url))))
            return route.abort()
        await route.fulfill({
            contentType: pathname.endsWith('.html') ? 'text/html' : 'text/javascript',
            body: await readFile(file),
        })
    })
}

export const test = base.extend({
    // Playwright requires a destructured argument to discover fixture dependencies.
    // eslint-disable-next-line no-empty-pattern
    fixture: async ({}, use) => {
        const fixture = await createReaderFixture()
        try { await use(fixture) }
        finally { await fixture.close() }
    },
    // This guard runs for every page and iframe, throughout the test and teardown.
    browserErrors: [async ({ context }, use, testInfo) => {
        const errors = []
        await monitorContext(context, errors)
        await use(errors)
        await testInfo.attach('browser-errors', {
            body: JSON.stringify(errors, null, 2), contentType: 'application/json',
        })
        expect(errors, 'Browser runtime errors and failed console assertions').toEqual([])
    }, { auto: true }],
    failureSnapshots: [async ({ page, browserErrors }, use, testInfo) => {
        await use()
        if (browserErrors.length || testInfo.status !== testInfo.expectedStatus)
            await attachFailureSnapshots(page.context(), testInfo)
    }, { auto: true }],
})

export { expect }

export const ready = async page => {
    await expect(page.locator('html')).toHaveAttribute('data-reader-state', 'ready')
    await expect.poll(() => page.evaluate(() => {
        const view = globalThis.reader?.view
        const doc = view?.renderer?.getContents()[0]?.doc
        return !!(view?.lastLocation?.cfi && doc?.body)
    })).toBe(true)
}

export const openBook = async (page, file, title = '网页阅读回归测试') => {
    const previous = await page.locator('html').getAttribute('data-reader-generation')
    await page.locator('#file-input').setInputFiles(file)
    await expect(page.locator('html')).not.toHaveAttribute('data-reader-generation', previous ?? '')
    await expect(page.locator('#header-title')).toHaveText(title)
    await ready(page)
    await expect.poll(() => page.evaluate(() =>
        JSON.parse(localStorage.getItem('foliate:last-book'))?.name)).toBe(file.split('/').at(-1))
}

export const position = page => page.evaluate(() => ({
    cfi: globalThis.reader.view.lastLocation.cfi,
    translation: globalThis.reader.translation.getPosition(),
    inTranslation: !!globalThis.reader.view.lastLocation.range.startContainer.parentElement
        ?.closest('[data-foliate-translation]'),
    flow: globalThis.reader.view.renderer.getAttribute('flow'),
    mode: document.querySelector('#reading-mode').value,
}))

export const translated = async page => {
    await expect(page.locator('#translation-status')).toHaveText('当前页翻译完成')
    await expect.poll(() => page.evaluate(() =>
        globalThis.reader.view.renderer.getContents()[0].doc
            .querySelector('[data-foliate-state="complete"]')?.textContent.length ?? 0)).toBeGreaterThan(0)
}

export const configureTranslation = async (page, fixture) => {
    await page.locator('#menu-button > button').click()
    await page.locator('#translation-settings-button').click()
    await page.locator('#api-url').fill(fixture.modelURL)
    await page.locator('#api-key').fill(fixture.testKey)
    await page.locator('#api-model').fill(fixture.model)
    await page.locator('#save-translation-settings').click()
    await expect(page.locator('#translation-settings')).not.toBeVisible()
}
