import { test, expect } from './fixtures.js'

test('all real EPUB sections retain standalone and inline title emphasis', async ({ page, fixture }, testInfo) => {
    test.setTimeout(60_000)
    await page.goto(fixture.url)
    await page.locator('#file-input').setInputFiles(new URL('../fixtures/how-an-economy-grows.epub', import.meta.url).pathname)
    await expect(page.locator('#header-title')).toHaveText('How an Economy Grows and Why It Crashes')
    // This book opens on an image-only cover, which has no body text to wait for.
    await expect.poll(() => page.evaluate(() => !!globalThis.reader?.view?.lastLocation?.cfi)).toBe(true)
    const report = await page.evaluate(async () => {
        const { PageTranslation } = await import('/translation.js')
        const report = { sections: 0, standalone: [], inline: [], failures: [] }
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
            let controller
            try {
                if (!titles.length) continue
                const range = doc.createRange()
                range.selectNodeContents(doc.body)
                const renderer = new EventTarget()
                renderer.getContents = () => [{ doc, index }]
                renderer.restoreAnchor = async () => {}
                let complete = false
                let calls = 0
                controller = new PageTranslation({ renderer, book: {}, lastLocation: { range } }, {
                    translate: async ({ text }) => {
                        calls++
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
    expect(report.failures).toEqual([])
    await testInfo.attach('all-book-title-emphasis', {
        body: JSON.stringify(report, null, 2), contentType: 'application/json',
    })
})
