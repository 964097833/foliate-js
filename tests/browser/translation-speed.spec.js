import { test, expect } from './fixtures.js'

test('translation scheduling displays fast results and warms the next page', async ({ page, fixture }, testInfo) => {
    await page.goto(fixture.url)
    const profile = await page.evaluate(async () => {
        const { PageTranslation } = await import('/translation.js')
        const frame = document.createElement('iframe')
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
        frame.srcdoc = '<html><head></head><body><p id="a">Slow paragraph.</p>'
            + '<p id="b"><strong>Fast</strong> formatted paragraph.</p>'
            + '<p id="c">Next one.</p><p id="d">Next two.</p><p id="e">Next three.</p>'
            + '<p id="f">Outside the prefetch window.</p></body></html>'
        document.body.append(frame)
        await loaded
        const doc = frame.contentDocument
        const range = doc.createRange()
        range.setStartBefore(doc.getElementById('a'))
        range.setEndAfter(doc.getElementById('b'))
        const renderer = new EventTarget()
        renderer.getContents = () => [{ doc, index: 0 }]
        renderer.restoreAnchor = async () => {}
        const view = { renderer, book: {}, lastLocation: { range } }
        const events = [], saved = []
        const start = performance.now()
        let active = 0, peak = 0
        const event = (type, text) => events.push({ type, text, ms: Math.round(performance.now() - start) })
        const controller = new PageTranslation(view, {
            translate: async ({ text, segments }) => {
                active++
                peak = Math.max(peak, active)
                event('start', text)
                await new Promise(resolve => setTimeout(resolve, text.startsWith('Slow') ? 700 : text.startsWith('Fast') ? 100 : 200))
                active--
                event('finish', text)
                return segments ? JSON.stringify(segments.map(({ id, text }) => ({ id, text: '中文' + text }))) : '中文' + text
            },
            cacheStore: { load: async () => [], save: async entries => saved.push(...entries) },
        })
        const observer = new MutationObserver(() => {
            for (const output of doc.querySelectorAll('[data-foliate-state="complete"]')) {
                const id = output.parentElement.id
                if (!events.some(event => event.type === 'display' && event.text === id)) event('display', id)
            }
        })
        observer.observe(doc.body, { subtree: true, childList: true, attributes: true })
        const wait = async predicate => {
            const deadline = performance.now() + 5000
            while (!predicate()) {
                if (performance.now() > deadline) throw new Error('Speed profile did not settle')
                await new Promise(resolve => setTimeout(resolve, 5))
            }
        }
        try {
            await controller.setMode('bilingual')
            await wait(() => controller.getDiagnostics().cacheEntries === 5
                && doc.querySelectorAll('[data-foliate-state="complete"]').length === 2)
            const before = { requests: events.filter(event => event.type === 'start').length,
                displayed: doc.querySelectorAll('[data-foliate-state="complete"]').length }
            const next = doc.createRange()
            next.setStartBefore(doc.getElementById('c'))
            next.setEndAfter(doc.getElementById('e'))
            view.lastLocation = { range: next }
            const flippedAt = performance.now()
            renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'page' } }))
            await wait(() => doc.querySelectorAll('[data-foliate-state="complete"]').length === 5)
            const output = doc.querySelector('#b [data-foliate-translation]')
            return { events, peak, before, cacheEntries: saved.length,
                cachedPageMs: Math.round(performance.now() - flippedAt),
                formatting: Array.from(output.children, run => ({
                    text: run.textContent, weight: doc.defaultView.getComputedStyle(run).fontWeight,
                })),
                nextPageCalls: events.filter(event => event.type === 'start' && event.text.startsWith('Next')).length }
        } finally { controller.destroy(); observer.disconnect(); frame.remove() }
    })
    await testInfo.attach('translation-speed-profile', { body: JSON.stringify(profile, null, 2), contentType: 'application/json' })
    expect(profile.before).toEqual({ requests: 5, displayed: 2 })
    expect(profile.nextPageCalls).toBe(3)
    expect(profile.peak).toBeLessThanOrEqual(4)
    expect(profile.formatting.map(run => run.weight)).toEqual(['700', '400'])
    const time = (type, text) => profile.events.find(event => event.type === type && event.text === text).ms
    expect(time('display', 'b')).toBeLessThan(time('finish', 'Slow paragraph.'))
    expect(time('finish', 'Next three.')).toBeLessThan(time('finish', 'Slow paragraph.'))
})

test('page navigation prioritizes visible text and reuses in-flight prefetch', async ({ page, fixture }, testInfo) => {
    await page.goto(fixture.url)
    const result = await page.evaluate(async () => {
        const { PageTranslation } = await import('/translation.js')
        const frame = document.createElement('iframe')
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
        frame.srcdoc = '<html><head></head><body>'
            + Array.from('ABCDEFGH', text => `<p id="${text}">${text}</p>`).join('') + '</body></html>'
        document.body.append(frame)
        await loaded
        const doc = frame.contentDocument
        const selection = (first, last = first) => {
            const range = doc.createRange()
            range.setStartBefore(doc.getElementById(first))
            range.setEndAfter(doc.getElementById(last))
            return range
        }
        const renderer = new EventTarget()
        renderer.getContents = () => [{ doc, index: 0 }]
        const view = { renderer, book: {}, lastLocation: { range: selection('A') } }
        let restoring = 0, maxRestoring = 0, batches = 0
        const anchors = []
        renderer.restoreAnchor = async range => {
            restoring++
            maxRestoring = Math.max(maxRestoring, restoring)
            await new Promise(resolve => setTimeout(resolve, 5))
            const node = range.startContainer
            anchors.push((node.nodeType === 1 ? node.childNodes[range.startOffset] : node.parentElement)?.id)
            restoring--
        }
        const requests = [], held = new Map()
        const controller = new PageTranslation(view, {
            translate: ({ text }) => {
                requests.push(text)
                return new Promise(resolve => held.set(text, resolve))
            },
            onStatus: ({ state, count }) => { if (state === 'translating' && count === 0) batches++ },
        })
        const wait = async predicate => {
            const deadline = performance.now() + 3000
            while (!predicate()) {
                if (performance.now() > deadline) throw new Error('Priority regression did not settle: ' + requests)
                await new Promise(resolve => setTimeout(resolve, 5))
            }
        }
        const navigate = (first, last) => {
            view.lastLocation = { range: selection(first, last) }
            renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'page' } }))
        }
        try {
            await controller.setMode('bilingual')
            await wait(() => held.has('A'))
            held.get('A')('甲')
            await wait(() => held.has('C'))
            const initial = { requests: [...requests], diagnostics: controller.getDiagnostics() }
            navigate('D', 'F')
            await wait(() => held.has('E'))
            const foreground = { requests: [...requests], diagnostics: controller.getDiagnostics() }
            held.get('B')('乙')
            await wait(() => held.has('F'))
            held.get('C')('丙')
            // Move again while the preceding page still has pending results.
            navigate('E')
            await wait(() => batches === 3)
            held.get('D')('丁')
            held.get('F')('己')
            held.get('E')('戊')
            await wait(() => doc.querySelector('#E [data-foliate-state="complete"]') && restoring === 0)
            return { initial, foreground, requests, maxRestoring,
                visible: doc.querySelector('#E [data-foliate-translation]').textContent,
                staleDisplayed: !!doc.querySelector('#D [data-foliate-translation], #F [data-foliate-translation]'),
                anchor: anchors.at(-1) }
        } finally { controller.destroy(); frame.remove() }
    })
    await testInfo.attach('translation-priority', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
    expect(result.initial.requests).toEqual(['A', 'B', 'C'])
    expect(result.initial.diagnostics.activeRequests).toBe(2)
    expect(result.foreground.requests).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(result.foreground.diagnostics.activeRequests).toBe(4)
    expect(result.requests.filter(text => text === 'D')).toHaveLength(1)
    expect(result.visible).toBe('戊')
    expect(result.staleDisplayed).toBe(false)
    expect(result.anchor).toBe('E')
    expect(result.maxRestoring).toBe(1)
})
