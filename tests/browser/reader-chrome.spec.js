import { test, expect, openBook, ready, translated, configureTranslation, position } from './fixtures.js'

test('night theme keeps the real book callout readable without changing its layout', async ({ page, fixture }) => {
    await page.goto(fixture.url)
    await openBook(page, new URL('../fixtures/how-an-economy-grows.epub', import.meta.url).pathname,
        'How an Economy Grows and Why It Crashes')
    await page.evaluate(() => globalThis.reader.view.renderer.goTo({ index: 14 }))
    const callout = () => page.evaluate(() => {
        const doc = globalThis.reader.view.renderer.getContents()[0].doc
        const box = doc.querySelector('.calibre_22')
        const style = doc.defaultView.getComputedStyle(box)
        return { width: box.getBoundingClientRect().width, background: style.backgroundColor,
            color: doc.defaultView.getComputedStyle(box.querySelector('.calibre_24')).color }
    })
    const before = await callout()
    await page.locator('#appearance-button').click()
    await page.locator('[data-theme="dark"]').click()
    await page.locator('#close-appearance').click()
    await expect.poll(callout).toEqual({ width: before.width, background: 'rgb(48, 49, 54)', color: 'rgb(233, 229, 221)' })
    await page.locator('#appearance-button').click()
    await page.locator('[data-theme="paper"]').click()
    await page.locator('#close-appearance').click()
    await expect.poll(callout).toEqual(before)
})

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) test.describe(`reading controls ${viewport.width}px`, () => {
    test.use({ viewport })
    test('text selection and chapter links keep tools stable; Escape restores immersive controls', async ({ page, fixture }) => {
        await page.goto(fixture.url)
        await openBook(page, fixture.book)
        const body = page.locator('foliate-view')
        // A real drag selects text in the chapter iframe without hiding tools.
        await page.mouse.move(viewport.width * .4, viewport.height * .4)
        await page.mouse.down()
        await page.mouse.move(viewport.width * .65, viewport.height * .45, { steps: 8 })
        await page.mouse.up()
        await expect(body).toBeVisible()
        await expect(page.locator('body')).not.toHaveClass(/chrome-hidden/)
        await page.evaluate(() => globalThis.reader.view.renderer.getContents()[0].doc.getSelection().removeAllRanges())
        const linkPoint = await page.evaluate(async () => {
            await globalThis.reader.view.goTo('one.xhtml')
            const doc = globalThis.reader.view.renderer.getContents()[0].doc
            const link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'a')
            link.href = '#p0'
            link.textContent = '跳到正文'
            doc.querySelector('h1').append(link)
            const rect = link.getBoundingClientRect()
            const frame = doc.defaultView.frameElement.getBoundingClientRect()
            return { x: frame.left + rect.left + rect.width / 2, y: frame.top + rect.top + rect.height / 2 }
        })
        await page.mouse.click(linkPoint.x, linkPoint.y)
        await expect(page.locator('body')).not.toHaveClass(/chrome-hidden/)
        await page.mouse.click(viewport.width / 2, viewport.height * .45)
        await expect(page.locator('body')).toHaveClass(/chrome-hidden/)
        await page.keyboard.press('Escape')
        await expect(page.locator('body')).not.toHaveClass(/chrome-hidden/)
        await page.locator('#side-bar-button').click()
        await page.locator('#toc-view').getByText('Chapter Two', { exact: true }).click()
        await expect(page.locator('body')).not.toHaveClass(/chrome-hidden/)
    })
    test('immersive tools, chapter preview and return preserve reading and cached formatting', async ({ page, fixture }) => {
        await page.goto(fixture.url)
        await openBook(page, fixture.richBook, '网页局部强调回归测试')
        await configureTranslation(page, fixture)
        await page.locator('[data-reading-mode="translation"]').click()
        await translated(page)
        await page.waitForLoadState('networkidle')
        const cache = await page.evaluate(async () => {
            const storage = await import('/ui/reader-storage.js')
            return storage.loadTranslations((await storage.getLastBook()).id)
        })
        await expect(page.locator('#chapter-title')).toHaveText('Chapter One')
        await expect(page.locator('#chapter-progress')).toContainText('还剩')
        await page.mouse.click(viewport.width / 2, viewport.height * .45)
        await expect(page.locator('body')).toHaveClass(/chrome-hidden/)
        await expect.poll(() => page.evaluate(() => globalThis.reader.view.renderer.getAttribute('margin'))).toBe('36px')
        await expect(page.locator('#appearance-button')).not.toBeVisible()
        await expect(page.locator('#progress-slider')).not.toBeVisible()
        await page.locator('#immersive-progress').click()
        await expect(page.locator('body')).not.toHaveClass(/chrome-hidden/)
        await expect(page.locator('#appearance-button')).toBeVisible()
        await page.waitForLoadState('networkidle')
        const before = await position(page)
        // Preview does not relocate, persist or request translation until committed.
        const requests = fixture.getRequests()
        await page.locator('#progress-slider').evaluate(node => {
            node.value = '.95'
            node.dispatchEvent(new Event('input'))
        })
        await expect(page.locator('#progress-preview')).toContainText('Chapter Two')
        expect(await position(page)).toEqual(before)
        expect(fixture.getRequests()).toBe(requests)
        await page.locator('#progress-slider').dispatchEvent('change')
        await expect(page.locator('#chapter-title')).toHaveText('Chapter Two')
        await expect(page.locator('#return-position')).toBeVisible()
        await page.locator('#return-position').click()
        await translated(page)
        await expect.poll(() => position(page)).toEqual(before)
        await page.locator('#side-bar-button').click()
        await page.locator('#toc-view').getByText('Chapter Two', { exact: true }).click()
        await expect(page.locator('#chapter-title')).toHaveText('Chapter Two')
        await page.locator('#return-position').click()
        await translated(page)
        await expect.poll(() => position(page)).toEqual(before)
        await expect.poll(() => page.evaluate(async entries => {
            const storage = await import('/ui/reader-storage.js')
            const next = new Map((await storage.loadTranslations((await storage.getLastBook()).id)).map(e => [e.key, e.text]))
            return entries.every(e => next.get(e.key) === e.text)
        }, cache)).toBe(true)
        await page.reload()
        await ready(page)
        await translated(page)
        await expect.poll(() => position(page)).toEqual(before)
        await expect(page.locator('#return-position')).not.toBeVisible()
    })
    test('appearance, reading modes and library preserve translated content and restart position', async ({ page, fixture }) => {
        await page.goto(fixture.url)
        await openBook(page, fixture.richBook, '网页局部强调回归测试')
        await configureTranslation(page, fixture)
        await page.locator('[data-reading-mode="translation"]').click()
        await translated(page)
        await expect(page.locator('[data-reading-mode="translation"]')).toHaveAttribute('aria-pressed', 'true')
        await page.locator('#appearance-button').click()
        await page.locator('[data-flow="scrolled"]').click()
        await page.locator('#close-appearance').click()
        await page.evaluate(() => globalThis.reader.view.goTo('one.xhtml#long'))
        await translated(page)
        await page.evaluate(() => globalThis.reader.view.renderer.scrollBy(650, 0))
        await translated(page)
        await page.waitForLoadState('networkidle')
        const before = await position(page)
        const cache = await page.evaluate(async () => {
            const s = await import('/ui/reader-storage.js')
            return s.loadTranslations((await s.getLastBook()).id)
        })
        await page.locator('#appearance-button').click()
        await page.locator('#font-larger').click()
        await expect(page.locator('#font-size-value')).toHaveText('25')
        await page.locator('[data-theme="dark"]').click()
        await expect(page.locator('html')).toHaveAttribute('data-reader-theme', 'dark')
        await page.locator('#close-appearance').click()
        await expect.poll(async () => (await position(page)).translation?.key).toBe(before.translation.key)
        // A new font size changes line starts. Preserve the saved character's
        // vertical position, rather than requiring the new line to start there.
        await expect.poll(() => page.evaluate(position => {
            const view = globalThis.reader.view
            const [section, ordinal] = position.key.split(':')
            const doc = view.renderer.getContents().find(item => item.index === Number(section)).doc
            const output = doc.querySelector(`[data-foliate-paragraph="${section}-${ordinal}"] > [data-foliate-translation]`)
            const walker = doc.createTreeWalker(output, NodeFilter.SHOW_TEXT)
            let remaining = position.offset
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (remaining <= node.length) {
                    const range = doc.createRange()
                    range.setStart(node, remaining)
                    range.collapse(true)
                    return Math.abs(view.renderer.captureAnchorOffset(range) - position.viewportOffset)
                }
                remaining -= node.length
            }
            return Infinity
        }, before.translation)).toBeLessThan(1)
        const formatting = await page.evaluate(() => {
            const doc = globalThis.reader.view.renderer.getContents()[0].doc
            const output = doc.querySelector('#long > [data-foliate-translation]')
            return { size: doc.defaultView.getComputedStyle(output).fontSize,
                runs: [...output.querySelectorAll('[data-foliate-translation-run]')].map(run => {
                    const style = doc.defaultView.getComputedStyle(run)
                    return [style.fontWeight, style.fontStyle]
                }) }
        })
        expect(formatting.size).toBe('25px')
        expect(formatting.runs).toContainEqual(['700', 'normal'])
        expect(formatting.runs).toContainEqual(['400', 'italic'])
        await expect.poll(() => page.evaluate(async entries => {
            const s = await import('/ui/reader-storage.js')
            const next = new Map((await s.loadTranslations((await s.getLastBook()).id)).map(e => [e.key, e.text]))
            return entries.every(e => next.get(e.key) === e.text)
        }, cache)).toBe(true)
        const saved = await position(page)
        await page.reload()
        await ready(page)
        await translated(page)
        await expect(page.locator('html')).toHaveAttribute('data-reader-theme', 'dark')
        await expect(page.locator('#font-size-value')).toHaveText('25')
        await expect.poll(() => position(page)).toEqual(saved)
        await page.locator('#library-button').click()
        await expect(page.locator('#library-book-title')).toHaveText('网页局部强调回归测试')
        await page.locator('#library-current').click()
        expect(await position(page)).toEqual(saved)
        await page.locator('#side-bar-button').click()
        await expect(page.locator('#side-bar')).toHaveClass('show')
        await page.keyboard.press('Escape')
        await expect(page.locator('#side-bar')).not.toHaveClass('show')
        await expect(page.locator('#side-bar-button')).toBeFocused()
        const boxes = await page.locator('#reader-dock > button, #reader-dock [data-reading-mode], #menu-button > button')
            .evaluateAll(nodes => nodes.map(node => {
                const { x, y, width, height } = node.getBoundingClientRect()
                return { x, y, width, height }
            }))
        for (const box of boxes) {
            expect(box.width).toBeGreaterThanOrEqual(44)
            expect(box.height).toBeGreaterThanOrEqual(44)
            expect(box.x).toBeGreaterThanOrEqual(0)
            expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
        }
        await page.locator('#appearance-button').click()
        await page.setViewportSize(viewport.width < 700 ? { width: 1280, height: 900 } : { width: 390, height: 844 })
        await page.setViewportSize(viewport)
        await expect.poll(() => page.locator('#header-bar').evaluate(node => node.getBoundingClientRect().top)).toBe(0)
        await expect(page.locator('#close-appearance')).toBeInViewport()
        if (viewport.width < 700) {
            await page.locator('#side-bar-button').click()
            await expect(page.locator('#appearance-settings')).not.toBeVisible()
            await expect(page.locator('#side-bar')).toHaveClass('show')
            await page.locator('#close-contents').click()
            await expect(page.locator('#side-bar-button')).toBeFocused()
        } else await page.locator('#close-appearance').click()
    })
})
