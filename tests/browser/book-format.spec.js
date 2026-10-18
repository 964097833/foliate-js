import { test, expect, configureTranslation, translated } from './fixtures.js'

test('all real EPUB sections retain standalone and inline title emphasis', async ({ page, fixture }, testInfo) => {
    test.setTimeout(60_000)
    await page.goto(fixture.url)
    await page.locator('#file-input').setInputFiles(new URL('../fixtures/how-an-economy-grows.epub', import.meta.url).pathname)
    await expect(page.locator('#header-title')).toHaveText('How an Economy Grows and Why It Crashes')
    // This book opens on an image-only cover, which has no body text to wait for.
    await expect.poll(() => page.evaluate(() => !!globalThis.reader?.view?.lastLocation?.cfi)).toBe(true)
    const report = await page.evaluate(async () => {
        const { PageTranslation } = await import('/translation.js')
        const report = { sections: 0, standalone: [], inline: [], emphasis: [], failures: [] }
        for (let index = 0; index < globalThis.reader.view.book.sections.length; index++) {
            const url = await globalThis.reader.view.book.sections[index].load()
            const frame = document.createElement('iframe')
            frame.style.cssText = 'width:1100px;height:2000px'
            frame.setAttribute('sandbox', 'allow-same-origin allow-scripts')
            document.body.append(frame)
            await new Promise(resolve => { frame.onload = resolve; frame.src = url })
            const doc = frame.contentDocument
            report.sections++
            const titles = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6,.bold')).flatMap(element => {
                const paragraph = element.closest('p,div,h1,h2,h3,h4,h5,h6,li,blockquote')
                const text = element.textContent.trim()
                if (!paragraph || !text) return []
                const whole = /^h[1-6]$/.test(element.localName) || text === paragraph.textContent.trim()
                const inline = !whole && /[:：]$/.test(text) && paragraph.textContent.trim().startsWith(text)
                return whole || inline ? [{ paragraph, text, inline }] : []
            })
            const emphasis = []
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (!node.parentElement.closest('.bold,.italic') || !node.nodeValue.trim()) continue
                const paragraph = node.parentElement.closest('p,div,h1,h2,h3,h4,h5,h6,li,blockquote')
                const style = doc.defaultView.getComputedStyle(node.parentElement)
                if (paragraph) emphasis.push({ paragraph, text: node.nodeValue.replace(/\s+/g, ' ').trim(),
                    weight: style.fontWeight, italic: style.fontStyle })
            }
            let controller
            try {
                if (!titles.length && !emphasis.length) continue
                const range = doc.createRange()
                range.selectNodeContents(doc.body)
                const renderer = new EventTarget()
                renderer.getContents = () => [{ doc, index }]
                renderer.restoreAnchor = async () => {}
                let complete = false
                let calls = 0
                controller = new PageTranslation({ renderer, book: {}, lastLocation: { range } }, {
                    translate: async ({ text, segments }) => {
                        calls++
                        if (segments) return JSON.stringify(segments.map(({ id, text }) => ({
                            id, text: text.trim() ? `测试译文：${text}` : text,
                        })))
                        return text === 'Underconsumption:' ? '节制消费：'
                            : text === 'Risk-taking:' ? '承担风险：' : `测试译文：${text}`
                    },
                    cancel: () => {}, prefetch: false,
                    onStatus: status => { complete = status.state === 'complete' },
                })
                await controller.setMode('bilingual')
                const deadline = Date.now() + 7000
                while (!complete && Date.now() < deadline)
                    await new Promise(resolve => setTimeout(resolve, 20))
                if (!complete) throw new Error(`Section ${index} did not finish translation`)
                const before = calls
                for (const mode of ['bilingual', 'translation']) {
                    await controller.setMode(mode)
                    for (const { paragraph, text, inline } of titles) {
                        const output = paragraph.querySelector(':scope > [data-foliate-translation]')
                        const label = inline ? output?.querySelector('[data-foliate-translation-title]') : output
                        const weight = label && doc.defaultView.getComputedStyle(label).fontWeight
                        if (weight !== '700') report.failures.push({ index, text, mode, weight })
                        if (inline && output && doc.defaultView.getComputedStyle(output).fontWeight !== '400')
                            report.failures.push({ index, text, mode, reason: 'explanation became bold' })
                        if (mode === 'translation')
                            report[inline ? 'inline' : 'standalone'].push({ index, text, weight })
                    }
                    for (const { paragraph, text, weight, italic } of emphasis) {
                        const output = paragraph.querySelector(':scope > [data-foliate-translation]')
                        const runs = output?.querySelectorAll('[data-foliate-translation-run]')
                        const label = output?.querySelector('[data-foliate-translation-title]')
                        const candidates = runs?.length ? Array.from(runs) : label ? [label] : output ? [output] : []
                        const matched = candidates.some(run => {
                            const style = doc.defaultView.getComputedStyle(run)
                            return (run === label || run.textContent.includes(text))
                                && style.fontWeight === weight && style.fontStyle === italic
                        })
                        if (!matched) report.failures.push({ index, text, mode, weight, italic, reason: 'source emphasis missing' })
                        if (mode === 'translation') report.emphasis.push({ index, text, weight, italic, matched })
                    }
                }
                if (calls !== before) report.failures.push({ index, reason: 'mode switch retranslates' })
            } finally {
                controller?.destroy()
                frame.remove()
            }
        }
        return report
    })
    expect(report.sections).toBe(40)
    expect(report.standalone.length).toBeGreaterThan(40)
    expect(report.inline.map(title => title.text)).toEqual(['Underconsumption:', 'Risk-taking:'])
    expect(report.emphasis.length).toBeGreaterThan(70)
    expect(report.failures).toEqual([])
    await testInfo.attach('all-book-title-emphasis', {
        body: JSON.stringify(report, null, 2), contentType: 'application/json',
    })
})

for (const nested of [false, true]) test(`real EPUB ${nested ? 'nested callout' : 'illustrated page'} keeps its cached position and image geometry after reload`, async ({ page, fixture }, testInfo) => {
    await page.setViewportSize({ width: 1679, height: 754 })
    let requests = 0
    await page.route('**/api/translation/translate', async route => {
        requests++
        const { text, segments } = route.request().postDataJSON()
        const translate = text => text.trim()
            ? '测试译文。'.repeat(Math.max(1, Math.ceil(text.length / 18))) : text
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            translation: segments ? JSON.stringify(segments.map(({ id, text }) => ({ id, text: translate(text) })))
            : translate(text),
        }) })
    })
    await page.goto(fixture.url)
    await page.locator('#file-input').setInputFiles(new URL('../fixtures/how-an-economy-grows.epub', import.meta.url).pathname)
    // The initial cover emits a CFI before the reader has finished opening.
    // Wait for its saved-book signal before navigating, otherwise goTo is locked.
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('foliate:last-book'))?.name))
        .toBe('how-an-economy-grows.epub')
    await configureTranslation(page, fixture)
    await page.evaluate(() => globalThis.reader.view.renderer.goTo({ index: 14 }))
    await page.locator('#reading-mode').selectOption('translation')
    await translated(page)
    const target = await page.evaluate(nested => {
        const view = globalThis.reader.view
        const { doc, index } = view.renderer.getContents()[0]
        const range = doc.createRange()
        range.selectNode(nested ? doc.querySelector('.calibre_22') : doc.querySelectorAll('img')[5])
        return view.getCFI(index, range)
    }, nested)
    await page.evaluate(cfi => globalThis.reader.view.goTo(cfi), target)
    await translated(page)
    await page.waitForLoadState('networkidle')
    const snapshot = () => page.evaluate(() => {
        const view = globalThis.reader.view
        const { doc } = view.renderer.getContents()[0]
        const frame = doc.defaultView.frameElement.getBoundingClientRect()
        return { cfi: view.lastLocation.cfi, translation: globalThis.reader.translation.getPosition(),
            fraction: view.lastLocation.fraction,
            images: Array.from(doc.querySelectorAll('img'), (img, index) => {
                const rect = img.getBoundingClientRect()
                return { index, left: Math.round(frame.left + rect.left), top: Math.round(frame.top + rect.top) }
            }).filter(rect => rect.left >= 0 && rect.left < 1600) }
    })
    const before = await snapshot()
    const count = requests
    if (nested) {
        expect(await page.evaluate(() => {
            const range = globalThis.reader.view.lastLocation.range
            const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
            return !!element.closest('[data-foliate-translation]')
        })).toBe(false)
        expect(before.translation).not.toBeNull()
    }
    else expect(before.images.length).toBeGreaterThanOrEqual(2)
    await page.reload()
    await expect.poll(() => page.evaluate(() => !!globalThis.reader?.view?.lastLocation?.cfi)).toBe(true)
    await translated(page)
    await page.waitForLoadState('networkidle')
    expect(await snapshot()).toEqual(before)
    expect(requests).toBe(count)
    await testInfo.attach('illustrated-page-resume', {
        body: JSON.stringify({ before, after: await snapshot(), requests }, null, 2), contentType: 'application/json',
    })
})
