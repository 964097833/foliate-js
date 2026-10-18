import { test, expect } from './fixtures.js'

test('bounded prefetch prepares consecutive pages ahead of rapid navigation', async ({ page, fixture }, testInfo) => {
    await page.goto(fixture.url)
    const profile = await page.evaluate(async () => {
        const { PageTranslation } = await import('/translation.js')
        const frame = document.createElement('iframe')
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
        frame.srcdoc = '<html><head></head><body>' + Array.from({ length: 30 }, (_, i) =>
            `<p id="p${i}">Passage ${i}.${i === 7 ? ' <strong>Bold</strong> and <em>italic</em>.' : ''}</p>`).join('') + '</body></html>'
        document.body.append(frame)
        await loaded
        const doc = frame.contentDocument
        const renderer = new EventTarget()
        renderer.getContents = () => [{ doc, index: 0 }]
        renderer.restoreAnchor = async () => {}
        const range = (first, last) => {
            const value = doc.createRange()
            value.setStartBefore(doc.getElementById('p' + first))
            value.setEndAfter(doc.getElementById('p' + last))
            return value
        }
        const view = { renderer, book: {}, lastLocation: { range: range(0, 2) } }
        const requests = [], saved = []
        let active = 0, peak = 0, state
        const controller = new PageTranslation(view, {
            translate: async ({ text, segments }) => {
                const ordinal = Number(text.match(/^Passage (\d+)/)[1])
                requests.push({ ordinal, start: performance.now() })
                peak = Math.max(peak, ++active)
                await new Promise(resolve => setTimeout(resolve, ordinal === 6 ? 700 : 100))
                active--
                return segments ? JSON.stringify(segments.map(({ id, text }) => ({ id, text: '译文' + text }))) : '译文' + text
            },
            cacheStore: { load: async () => [], save: async entries => saved.push(...entries) },
            onStatus: value => { state = value.state },
        })
        const wait = async predicate => {
            const deadline = performance.now() + 5000
            while (!predicate()) {
                if (performance.now() > deadline) throw new Error('Lookahead profile did not settle')
                await new Promise(resolve => setTimeout(resolve, 5))
            }
        }
        const idle = () => !controller.getDiagnostics().activeRequests && !controller.getDiagnostics().queuedRequests
        const flip = (first, last) => {
            state = null
            view.lastLocation = { range: range(first, last) }
            renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'page' } }))
        }
        try {
            await controller.setMode('bilingual')
            await wait(() => state === 'complete' && idle())
            const prepared = requests.map(request => request.ordinal)
            const initialOutputs = doc.querySelectorAll('[data-foliate-state="complete"]').length
            // One warmed page, followed immediately by the next warmed page.
            flip(3, 5)
            await wait(() => state === 'complete')
            const thirdPageStart = performance.now()
            flip(6, 8)
            await wait(() => state === 'complete')
            const thirdPageMs = Math.round(performance.now() - thirdPageStart)
            const afterFlip = requests.filter(request => request.ordinal >= 6 && request.ordinal <= 8
                && request.start >= thirdPageStart).length
            await wait(idle)
            const settledCount = requests.length
            // Reflow is not a reading action and must not extend speculation.
            renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'anchor' } }))
            await new Promise(resolve => setTimeout(resolve, 50))
            const emphasis = Array.from(doc.querySelectorAll('#p7 [data-foliate-translation-run]'), run => ({
                text: run.textContent, weight: doc.defaultView.getComputedStyle(run).fontWeight,
                italic: doc.defaultView.getComputedStyle(run).fontStyle,
            }))
            return { prepared, initialOutputs, thirdPageMs, afterFlip, peak, emphasis,
                uniqueRequests: new Set(requests.map(request => request.ordinal)).size === requests.length,
                noRecursivePrefetch: requests.length === settledCount,
                furthestParagraph: Math.max(...requests.map(request => request.ordinal)), saved: saved.length }
        } finally { controller.destroy(); frame.remove() }
    })
    await testInfo.attach('consecutive-page-profile', { body: JSON.stringify(profile, null, 2), contentType: 'application/json' })
    expect(profile.initialOutputs).toBe(3)
    expect(profile.peak).toBeLessThanOrEqual(8)
    expect(profile.uniqueRequests).toBe(true)
    expect(profile.noRecursivePrefetch).toBe(true)
    expect(profile.emphasis.some(run => run.weight === '700')).toBe(true)
    expect(profile.emphasis.some(run => run.italic === 'italic')).toBe(true)
    expect(profile.prepared).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(profile.afterFlip).toBe(0)
    expect(profile.furthestParagraph).toBeLessThanOrEqual(14)
})

test('navigation drops unsent speculative work and stopping translation keeps late results out of cache', async ({ page, fixture }, testInfo) => {
    await page.goto(fixture.url)
    const result = await page.evaluate(async () => {
        const { PageTranslation } = await import('/translation.js')
        const frame = document.createElement('iframe')
        const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
        frame.srcdoc = '<html><head></head><body>' + Array.from({ length: 30 }, (_, i) => `<p id="p${i}">${i}</p>`).join('') + '</body></html>'
        document.body.append(frame)
        await loaded
        const doc = frame.contentDocument
        const range = (first, last = first) => {
            const range = doc.createRange()
            range.setStartBefore(doc.getElementById('p' + first))
            range.setEndAfter(doc.getElementById('p' + last))
            return range
        }
        const renderer = new EventTarget()
        renderer.getContents = () => [{ doc, index: 0 }]
        renderer.restoreAnchor = async () => {}
        const view = { renderer, book: {}, lastLocation: { range: range(0, 3) } }
        const requests = [], held = new Map(), saved = [], cancelled = []
        let state
        const controller = new PageTranslation(view, {
            translate: ({ id, text }) => { requests.push(Number(text)); return new Promise(resolve => held.set(Number(text), { id, resolve })) },
            cancel: id => cancelled.push(id),
            cacheStore: { load: async () => [], save: async entries => saved.push(...entries) },
            onStatus: value => { state = value.state },
        })
        const wait = async predicate => {
            const deadline = performance.now() + 3000
            while (!predicate()) {
                if (performance.now() > deadline) throw new Error('Stale prefetch did not settle: ' + requests)
                await new Promise(resolve => setTimeout(resolve, 5))
            }
        }
        try {
            await controller.setMode('bilingual')
            await wait(() => held.has(3))
            for (let i = 0; i < 4; i++) held.get(i).resolve('译文' + i)
            await wait(() => state === 'complete' && held.has(9))
            const initial = { requests: [...requests], diagnostics: controller.getDiagnostics() }
            view.lastLocation = { range: range(20, 22) }
            renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'navigation' } }))
            await wait(() => held.has(21))
            const afterJump = [...requests]
            held.get(20).resolve('二十')
            held.get(21).resolve('二十一')
            await wait(() => held.has(22))
            held.get(22).resolve('二十二')
            await wait(() => state === 'complete' && doc.querySelector('#p22 [data-foliate-state="complete"]'))
            await controller.setMode('original')
            for (const { resolve } of held.values()) resolve('不应保存的延迟结果')
            await wait(() => controller.getDiagnostics().activeRequests === 0)
            return { initial, afterJump, requests, cancelled: cancelled.length, saved: saved.length,
                diagnostics: controller.getDiagnostics(),
                staleDisplayed: !!doc.querySelector('#p4 [data-foliate-translation],#p5 [data-foliate-translation],#p6 [data-foliate-translation]') }
        } finally { controller.destroy(); frame.remove() }
    })
    await testInfo.attach('stale-prefetch', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
    expect(result.initial.requests).toEqual(Array.from({ length: 10 }, (_, i) => i))
    expect(result.initial.diagnostics.activeRequests).toBe(6)
    expect(result.initial.diagnostics.queuedRequests).toBe(2)
    expect(result.afterJump).toEqual([...Array.from({ length: 10 }, (_, i) => i), 20, 21])
    expect(result.requests).not.toContain(10)
    expect(result.requests).not.toContain(11)
    expect(result.requests).not.toContain(23)
    expect(result.cancelled).toBe(6)
    expect(result.saved).toBe(7)
    expect(result.diagnostics.cacheEntries).toBe(7)
    expect(result.diagnostics.queuedRequests).toBe(0)
    expect(result.staleDisplayed).toBe(false)
})

test('prefetch respects paragraph and character bounds while skipping hidden content', async ({ page, fixture }, testInfo) => {
    await page.goto(fixture.url)
    const results = await page.evaluate(async () => {
        const { PageTranslation } = await import('/translation.js')
        const check = async ({ visible, long = 0, oversized = false, hidden = [] }) => {
            const frame = document.createElement('iframe')
            const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
            frame.srcdoc = '<html><head></head><body>' + Array.from({ length: 40 }, (_, i) => {
                const text = i + ':' + 'x'.repeat(i > 0 && long ? (oversized && i === 1 ? 13000 : long) - String(i).length - 1 : 1)
                return `<p id="p${i}"${hidden.includes(i) ? ' style="display:none"' : ''}>${text}</p>`
            }).join('') + '</body></html>'
            document.body.append(frame)
            await loaded
            const doc = frame.contentDocument
            const range = doc.createRange()
            range.setStartBefore(doc.getElementById('p0'))
            range.setEndAfter(doc.getElementById('p' + (visible - 1)))
            const renderer = new EventTarget()
            renderer.getContents = () => [{ doc, index: 0 }]
            renderer.restoreAnchor = async () => {}
            const requests = []
            let complete = false
            const controller = new PageTranslation({ renderer, book: {}, lastLocation: { range } }, {
                translate: async ({ text }) => { requests.push(Number(text.split(':')[0])); return '中文' },
                onStatus: ({ state }) => { if (state === 'complete') complete = true },
            })
            try {
                await controller.setMode('bilingual')
                const deadline = performance.now() + 5000
                while (!complete || controller.getDiagnostics().activeRequests || controller.getDiagnostics().queuedRequests) {
                    if (performance.now() > deadline) throw new Error('Bounded prefetch did not settle')
                    await new Promise(resolve => setTimeout(resolve, 5))
                }
                return requests
            } finally { controller.destroy(); frame.remove() }
        }
        return { dense: await check({ visible: 7 }), long: await check({ visible: 1, long: 6000 }),
            oversized: await check({ visible: 1, long: 6000, oversized: true }),
            hidden: await check({ visible: 1, hidden: [1, 2] }) }
    })
    await testInfo.attach('prefetch-bounds', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
    expect(results.dense).toEqual(Array.from({ length: 19 }, (_, i) => i))
    expect(results.long).toEqual([0, 1, 2])
    expect(results.oversized).toEqual([0, 1])
    expect(results.hidden).toEqual([0, 3, 4, 5, 6, 7, 8])
})
