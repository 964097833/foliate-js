import { createReaderFixture } from '../web-reader-fixture.js'
import { test, expect, ready, openBook, position, translated, configureTranslation, monitorContext } from './fixtures.js'

const github = () => {
    const files = new Map()
    let revision = 0
    let offline = false
    return { files, offline: value => { offline = value }, async request(input) {
        if (offline) return { status: 503, data: {} }
        const old = files.get(input.path)
        if (input.method === 'GET') return old ? { status: 200, data: old } : { status: 404, data: {} }
        if (old?.sha !== input.sha) return { status: 409, data: {} }
        const data = { content: input.content, sha: (++revision).toString(16).padStart(40, '0') }
        files.set(input.path, data)
        return { status: old ? 200 : 201, data }
    } }
}
const configureSync = async page => {
    await page.locator('#sync-button').click()
    await page.locator('#sync-repository').fill('fixture/private-reader-data')
    await page.locator('#sync-branch').fill('main')
    await page.locator('#sync-token').fill('test-only-token')
    await page.locator('#sync-form button[type="submit"]').click()
    await expect(page.locator('#sync-status')).toContainText('已同步', { timeout: 15000 })
    await page.locator('#sync-close').click()
}
const containsAnchor = (page, cfi) => page.evaluate(cfi => {
    const view = globalThis.reader.view
    const resolved = view.resolveCFI(cfi)
    const content = view.renderer.getContents().find(item => item.index === resolved.index)
    if (!content) return { contains: false, index: resolved.index, actualIndex: view.renderer.getContents()[0]?.index }
    const target = resolved.anchor(content.doc)
    const visible = view.lastLocation.range.cloneRange()
    // Paginator CFIs can point to element boundaries (body:0 / p:0).
    // Compare their first text character, and include the last visible element.
    if (visible.endContainer.nodeType === 1)
        visible.setEnd(visible.endContainer, visible.endContainer.childNodes.length)
    let node = target.startContainer, offset = target.startOffset
    if (node.nodeType === 1) {
        node = node.childNodes[offset] ?? node
        const walker = content.doc.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        if (node.nodeType !== 3) node = walker.nextNode() ?? node
        if (node.nodeType === 3 && !node.textContent.trim()) {
            const parentWalker = content.doc.createTreeWalker(target.startContainer, NodeFilter.SHOW_TEXT)
            for (let text = parentWalker.nextNode(); text; text = parentWalker.nextNode())
                if (text.textContent.trim()) { node = text; break }
        }
        offset = 0
    }
    return { contains: visible.isPointInRange(node, offset), cfi: view.lastLocation.cfi, requested: cfi,
        node: node.nodeName, text: node.textContent.slice(0, 30), start: visible.startContainer.textContent.slice(0, 30),
        stored: localStorage.getItem('foliate:progress:' + JSON.parse(localStorage.getItem('foliate:last-book')).id) }

}, cfi)
const translatedAnchorVisible = (page, position) => page.evaluate(position => {
    const view = globalThis.reader.view
    const [section, ordinal] = position.key.split(':')
    const doc = view.renderer.getContents().find(item => item.index === Number(section))?.doc
    const output = doc?.querySelector(`[data-foliate-paragraph="${section}-${ordinal}"] > [data-foliate-translation]`)
    if (!output) return false
    const walker = doc.createTreeWalker(output, NodeFilter.SHOW_TEXT)
    let remaining = position.offset
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (remaining <= node.length) {
            const visible = view.lastLocation.range.cloneRange()
            if (visible.endContainer.nodeType === 1)
                visible.setEnd(visible.endContainer, visible.endContainer.childNodes.length)
            return visible.isPointInRange(node, remaining)
        }
        remaining -= node.length
    }
    return false
}, position)
const synchronize = async page => {
    await page.evaluate(() => globalThis.readerSync.sync())
    await expect(page.locator('#sync-status')).toContainText('已同步')
}
const format = page => page.evaluate(() => {
    const doc = globalThis.reader.view.renderer.getContents()[0].doc
    const output = doc.querySelector('#long > [data-foliate-translation]')
    return { size: doc.defaultView.getComputedStyle(output).fontSize,
        weight: doc.defaultView.getComputedStyle(output).fontWeight,
        runs: [...output.querySelectorAll('[data-foliate-translation-run]')].map(run => ({
            weight: doc.defaultView.getComputedStyle(run).fontWeight,
            italic: doc.defaultView.getComputedStyle(run).fontStyle,
        })) }
})

// Swift cannot run in Chromium. Exercise the actual native JS adapter through a
// simulated Keychain/URLSession plugin, and explicitly keep this distinct from
// an installed iPhone test in the handoff documentation.
const installPhoneTransport = async (context, remote) => {
    let configured = false
    let requests = 0
    const appearances = []
    const settings = { url: 'https://model.example/v1', model: 'qwen3.8-flash', hasKey: true }
    await context.exposeBinding('__phoneCall', async (_source, method, input) => {
        if (method === 'settings') {
            if (input.scope === 'translation') return settings
            if (input.method === 'PUT') configured = true
            return { repository: configured ? 'fixture/private-reader-data' : '', branch: 'main', hasToken: configured }
        }
        if (method === 'github') return remote.request(input)
        if (method === 'setAppearance') { appearances.push(input.theme); return {} }
        if (method === 'cancel') return {}
        if (method === 'translate') {
            requests++
            const content = input.body.messages.at(-1).content
            let structured
            try { structured = JSON.parse(content) } catch { /* Plain passage. */ }
            const text = structured?.segments ? structured.text : content
            const translated = '安静的房间会改变我们观察世界的方式。阅读很少是一场竞赛，我们在句子之间停留，理解另一种声音。'
            const translation = structured?.segments
                ? JSON.stringify(structured.segments.map(({ id, text }) => ({ id,
                    text: !text.trim() ? text : text.length > 150 ? translated.repeat(35) : `测试译文：${text}`,
                }))) : text.length > 150 ? translated.repeat(35) : `测试译文：${text}`
            return { status: 200, data: { choices: [{ finish_reason: 'stop', message: { content: translation } }] } }
        }
        throw new Error(`Unexpected native method ${method}`)
    })
    await context.addInitScript(() => {
        globalThis.Capacitor = { isNativePlatform: () => true }
        globalThis.__phonePlugin = new Proxy({}, { get: (_target, method) => input => globalThis.__phoneCall(method, input) })
    })
    await context.route('**/ui/capacitor-runtime.js', route => route.fulfill({ contentType: 'text/javascript',
        body: 'export const registerPlugin = () => globalThis.__phonePlugin' }))
    return { requests: () => requests, appearances: () => appearances }
}

const installMacSync = async (context, remote) => {
    let configured = false
    await context.route('**/api/sync/**', async route => {
        const request = route.request()
        const data = request.url().endsWith('/request')
            ? await remote.request(request.postDataJSON())
            : (() => {
                if (request.method() === 'PUT') configured = true
                return { repository: configured ? 'fixture/private-reader-data' : '', branch: 'main', hasToken: configured }
            })()
        await route.fulfill({ json: data })
    })
}

test('sync summary separates pending, success and error from collapsed connection settings', async ({ page, context, fixture }) => {
    const remote = github()
    await installMacSync(context, remote)
    await page.goto(fixture.url)
    await openBook(page, fixture.book)
    await configureSync(page)
    await page.locator('#right-button').click()
    await page.evaluate(() => globalThis.reader.flushProgress())
    await page.locator('#sync-button').click()
    await expect(page.locator('#sync-summary')).toHaveAttribute('data-state', 'pending')
    await expect(page.locator('#sync-summary-title')).toHaveText('等待同步')
    await expect(page.locator('#sync-connection')).not.toHaveAttribute('open')
    await expect(page.locator('#sync-token')).not.toBeVisible()
    await expect(page.locator('#sync-book-title')).toHaveText('网页阅读回归测试')
    await expect(page.locator('#sync-book-position')).toContainText('Chapter One')
    await page.locator('#sync-now').click()
    await expect(page.locator('#sync-summary-title')).toHaveText('已同步')
    await expect(page.locator('#sync-last-time')).toContainText('最近成功同步')
    const saved = await position(page)
    const manifest = JSON.parse(Buffer.from(remote.files.get('reader-sync/manifest.json').content, 'base64').toString())
    expect(manifest.current.cfi).toBe(saved.cfi)
    remote.offline(true)
    await page.locator('#sync-now').click()
    await expect(page.locator('#sync-summary')).toHaveAttribute('data-state', 'error')
    await expect(page.locator('#sync-summary-title')).toHaveText('同步未完成')
    expect(await position(page)).toEqual(saved)
    await expect(page.locator('#sync-now')).toBeEnabled()
    remote.offline(false)
    await page.locator('#sync-now').click()
    await expect(page.locator('#sync-summary-title')).toHaveText('已同步')
    await page.locator('#sync-connection > summary').click()
    await expect(page.locator('#sync-token')).toBeVisible()
})

test('Mac and phone exchange formatted cache and positions, and phone works after Mac shuts down', async ({ page, context, browser, fixture, browserErrors }, testInfo) => {
    const remote = github()
    await installMacSync(context, remote)
    await page.goto(fixture.url)
    await openBook(page, fixture.richBook, '网页局部强调回归测试')
    await configureTranslation(page, fixture)
    await page.locator('#reading-mode').selectOption('translation')
    await translated(page)
    await page.locator('#right-button').click()
    await translated(page)
    await expect.poll(async () => (await position(page)).translation?.offset ?? 0).toBeGreaterThan(0)
    await page.waitForLoadState('networkidle')
    const macPosition = await position(page)
    const macFormat = await format(page)
    await configureSync(page)
    const phoneFixture = await createReaderFixture()
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await monitorContext(phoneContext, browserErrors)
    const native = await installPhoneTransport(phoneContext, remote)
    const phone = await phoneContext.newPage()
    try {
        await phone.goto(phoneFixture.url)
        await configureSync(phone)
        await ready(phone)
        await translated(phone)
        expect(native.appearances()).toContain('paper')
        expect(await phone.evaluate(() => [...globalThis.reader.view.renderer.getContents()[0].doc.fonts]
            .some(font => font.family === 'Foliate Serif' && font.status === 'loaded'))).toBe(true)
        expect(await format(phone)).toEqual(macFormat)
        const phonePosition = await position(phone)
        // Changing column widths changes the page's first character. The saved
        // logical character must remain on screen across the two viewports.
        expect(await translatedAnchorVisible(phone, macPosition.translation)).toBe(true)
        // Native traffic is outside the page's network lifecycle; use the
        // reader's ready/cache signals, including the already loaded font.
        await expect.poll(() => phone.evaluate(() => globalThis.reader.translation
            .getDiagnostics().activeRequests)).toBe(0)
        const beforeReload = await position(phone)
        const cachedRequests = native.requests()
        await phone.reload()
        await ready(phone)
        await translated(phone)
        await expect.poll(() => position(phone)).toEqual(beforeReload)
        expect(native.requests()).toBe(cachedRequests)

        await fixture.close() // Phone assets and native network transport are independent.
        await phone.locator('#right-button').tap()
        await translated(phone)
        await synchronize(phone)
        const published = JSON.parse(Buffer.from(remote.files.get('reader-sync/manifest.json').content, 'base64').toString())
        const phoneSaved = await position(phone)
        expect(published.current.translation.key).toBe(phoneSaved.translation.key)
        expect(published.current.translation.offset).toBe(phoneSaved.translation.offset)
        expect(published.current.translation.viewportOffset).toBeUndefined()

        // Read and translate previously unseen content with no Mac backend alive.
        await openBook(phone, phoneFixture.otherBook, 'Another Book')
        await phone.locator('#reading-mode').selectOption('translation')
        await translated(phone)
        expect(native.requests()).toBeGreaterThan(cachedRequests)
        remote.offline(true)
        await phone.locator('#right-button').tap()
        await translated(phone)
        await phone.evaluate(() => globalThis.readerSync.sync())
        await expect(phone.locator('#sync-status')).toContainText('失败')
        const offlinePosition = await position(phone)
        await phone.reload()
        await ready(phone)
        await translated(phone)
        await expect.poll(() => position(phone)).toEqual(offlinePosition)
        remote.offline(false)
        await synchronize(phone)
        const phonePublished = JSON.parse(Buffer.from(remote.files.get('reader-sync/manifest.json').content, 'base64').toString())
        expect(phonePublished.current.translation?.key).toBe(offlinePosition.translation.key)
        const returningMac = await createReaderFixture()
        const returningContext = await browser.newContext()
        await monitorContext(returningContext, browserErrors)
        await installMacSync(returningContext, remote)
        const returningPage = await returningContext.newPage()
        try {
            await returningPage.goto(returningMac.url)
            await configureTranslation(returningPage, returningMac)
            await configureSync(returningPage)
            await ready(returningPage)
            await translated(returningPage)
            // A wider page can include the heading above the saved character.
            // The same paragraph/character must be visible, not necessarily the first glyph.
            await expect.poll(() => translatedAnchorVisible(returningPage, offlinePosition.translation)).toBe(true)
            const logical = await returningPage.evaluate(() => JSON.parse(localStorage
                .getItem('foliate:sync:fixture/private-reader-data:main')).current.translation)
            expect(logical).toEqual(phonePublished.current.translation)
            expect(returningMac.getRequests()).toBe(0)
        } finally { await returningContext.close(); await returningMac.close() }
        await testInfo.attach('cross-device-result', { body: JSON.stringify({ macPosition, phonePosition,
            phoneSaved, offlinePosition, nativeRequests: native.requests(), macFormat }, null, 2), contentType: 'application/json' })
    } finally {
        if (testInfo.status !== testInfo.expectedStatus) {
            await testInfo.attach('phone-failure', { body: await phone.screenshot(), contentType: 'image/png' })
            await testInfo.attach('phone-dom', { body: await phone.content(), contentType: 'text/html' })
        }
        await phoneContext.close()
        await phoneFixture.close()
    }
})

for (const choice of ['local', 'remote']) test(`concurrent offline reading asks before keeping ${choice} position`, async ({ page, context, browser, fixture, browserErrors }) => {
    const remote = github()
    await installMacSync(context, remote)
    await page.goto(fixture.url)
    await openBook(page, fixture.book)
    await configureSync(page)
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await monitorContext(phoneContext, browserErrors)
    await installPhoneTransport(phoneContext, remote)
    const phone = await phoneContext.newPage()
    try {
        await phone.goto(fixture.url)
        await configureSync(phone)
        await ready(phone)
        await page.waitForLoadState('networkidle')
        await expect.poll(() => phone.evaluate(() => globalThis.reader.view.renderer.getContents()[0]
            .doc.fonts.status)).toBe('loaded')
        const previousMac = await position(page)
        const previousPhone = await position(phone)
        await page.locator('#right-button').click()
        await expect.poll(async () => (await position(page)).cfi).not.toBe(previousMac.cfi)
        await phone.locator('#right-button').click()
        await expect.poll(async () => (await position(phone)).cfi).not.toBe(previousPhone.cfi)
        const local = await position(phone)
        await synchronize(page)
        const before = remote.files.get('reader-sync/manifest.json').sha
        await phone.evaluate(() => globalThis.readerSync.sync())
        await expect(phone.locator('#sync-conflict')).toBeVisible()
        expect(remote.files.get('reader-sync/manifest.json').sha).toBe(before)
        await phone.locator(`#sync-use-${choice}`).click()
        await expect(phone.locator('#sync-status')).toContainText('已同步')
        await expect(phone.locator('#sync-conflict')).toBeHidden()
        if (choice === 'local') {
            const published = JSON.parse(Buffer.from(remote.files.get('reader-sync/manifest.json').content, 'base64').toString())
            expect(published.current.cfi).toBe(local.cfi)
            await synchronize(page)
            await expect.poll(() => containsAnchor(page, local.cfi)).toMatchObject({ contains: true })
        } else {
            const published = JSON.parse(Buffer.from(remote.files.get('reader-sync/manifest.json').content, 'base64').toString())
            await expect.poll(() => containsAnchor(phone, published.current.cfi)).toMatchObject({ contains: true })
        }
    } finally { await phoneContext.close() }
})

test('clearing translations survives offline restart and does not resurrect stale device caches', async ({ page, context, browser, fixture, browserErrors }) => {
    const remote = github()
    await installMacSync(context, remote)
    await page.goto(fixture.url)
    await openBook(page, fixture.book)
    await page.evaluate(async () => {
        const storage = await import('/ui/reader-storage.js')
        const { id } = await storage.getLastBook()
        await storage.saveTranslations(id, [{ key: 'generation-probe', text: '旧译文' }])
    })
    await configureSync(page)
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await monitorContext(phoneContext, browserErrors)
    await installPhoneTransport(phoneContext, remote)
    const phone = await phoneContext.newPage()
    const entries = device => device.evaluate(async () => {
        const storage = await import('/ui/reader-storage.js')
        return storage.loadTranslations((await storage.getLastBook()).id)
    })
    try {
        await phone.goto(fixture.url)
        await configureSync(phone)
        expect(await entries(phone)).toEqual([{ key: 'generation-probe', text: '旧译文' }])
        remote.offline(true)
        await page.evaluate(async () => {
            const storage = await import('/ui/reader-storage.js')
            const { id } = await storage.getLastBook()
            await storage.clearTranslations(id)
            await storage.saveTranslations(id, [{ key: 'generation-probe', text: '新译文' }])
        })
        await page.reload()
        await ready(page)
        expect(await entries(page)).toEqual([{ key: 'generation-probe', text: '新译文' }])
        remote.offline(false)
        await synchronize(page)
        await synchronize(phone)
        expect(await entries(phone)).toEqual([{ key: 'generation-probe', text: '新译文' }])
        await synchronize(page)
        expect(await entries(page)).toEqual([{ key: 'generation-probe', text: '新译文' }])
    } finally { await phoneContext.close() }
})
