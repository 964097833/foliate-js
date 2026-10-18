import { PageTranslation } from '../translation.js'

const waitFor = async (condition, label) => {
    for (let i = 0; i < 250; i++) {
        if (condition()) return
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`Translation format regression timed out: ${label}`)
}
const fixture = async (body, { translate = async ({ text }) => `译文：${text}`, entries = [] } = {}) => {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'width:1100px;height:1800px'
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = `<html><head><style>body { font:18px serif }</style></head><body>${body}</body></html>`
    document.body.append(frame)
    await loaded
    const doc = frame.contentDocument
    const range = doc.createRange()
    range.selectNodeContents(doc.body)
    const renderer = new EventTarget()
    renderer.getContents = () => [{ doc, index: 0 }]
    const anchors = []
    renderer.restoreAnchor = (range, offset) => { anchors.push({ range, offset }); return Promise.resolve() }
    const saved = new Map(entries.map(entry => [entry.key, entry.text]))
    const statuses = []
    const view = { renderer, book: {}, lastLocation: { range } }
    const controller = new PageTranslation(view, {
        translate, cancel: () => {}, prefetch: false,
        onStatus: status => statuses.push(status),
        cacheStore: {
            load: async () => Array.from(saved, ([key, text]) => ({ key, text })),
            save: async entries => { for (const { key, text } of entries) saved.set(key, text) },
            clear: async () => saved.clear(),
        },
    })
    return { doc, view, controller, saved, anchors, statuses,
        output: id => doc.querySelector(`#${id} > [data-foliate-translation]`),
        complete: async () => waitFor(() => statuses.at(-1)?.state === 'complete', 'all formatted paragraphs'),
        close: () => { controller.destroy(); frame.remove() } }
}

{
    const calls = []
    const text = 'Normal same and same plus both end.'
    const oldKey = `0:0:${text}`
    const markup = `<p id="rich">Normal <b>same</b> and <i>same</i> plus <strong><em>both</em></strong> end.</p>
        <p id="plain">Plain cached paragraph</p>
        <p id="reorder">First <em>second</em> third.</p>
        <p id="reset" style="font-weight:bold;font-style:italic">Inherited <span style="font-weight:400;font-style:normal">reset</span> inherited.</p>
        <p id="breaks">Line <strong>one</strong><br><br><em>two</em> end.</p>
        <pre id="indent">  Alpha <em>Beta</em>\n\tGamma <b>Delta</b>  </pre>
        <p id="class"><span style="font-weight:600">CSS <span style="font-style:oblique">nested</span></span> normal.</p>`
    const entries = [{ key: oldKey, text: '旧的无格式译文' },
        { key: '0:1:Plain cached paragraph', text: '普通段落缓存' }]
    const test = await fixture(markup, { entries, translate: async payload => {
        calls.push(payload)
        if (!payload.segments) throw new Error('Unexpected ordinary cache miss')
        if (payload.text.startsWith('First ')) return JSON.stringify([
            { id: 2, text: '第三' }, { id: 0, text: '第一' }, { id: 1, text: '第二' },
        ])
        return JSON.stringify(payload.segments.map(({ id, text }) => ({ id,
            text: !text.trim() ? text : text.trim() === 'same' ? '相同'
            : text.trim() === 'both' ? '<img src=x onerror=unsafe()>' : `中文(${text})`,
        })))
    } })
    try {
        for (const mode of ['bilingual', 'translation']) {
            await test.controller.setMode(mode)
            await test.complete()
            const output = test.output('rich')
            const runs = Array.from(output.children)
            const style = node => test.doc.defaultView.getComputedStyle(node)
            const repeated = runs.filter(run => run.textContent === '相同')
            console.assert(repeated.length === 2 && style(repeated[0]).fontWeight === '700'
                && style(repeated[0]).fontStyle === 'normal' && style(repeated[1]).fontWeight === '400'
                && style(repeated[1]).fontStyle === 'italic', `${mode}: repeated words get their own bold and italic boundaries`)
            const combined = runs.find(run => run.textContent.startsWith('<img'))
            console.assert(style(combined).fontWeight === '700' && style(combined).fontStyle === 'italic'
                && !output.querySelector('img'), 'Nested bold/italic combine and model markup remains harmless text')
            console.assert(style(output).fontWeight === '400' && style(output).fontStyle === 'normal'
                && style(output).fontSize === '24px' && style(output).lineHeight === '37.2px',
            'Partial emphasis never expands to the whole paragraph or changes accepted body typography')
            const reordered = test.output('reorder')
            console.assert(reordered.textContent === '第三第一第二' && style(reordered.lastChild).fontStyle === 'italic',
                'Chinese word order may change while emphasis stays attached to its source identity')
            const reset = Array.from(test.output('reset').children).find(run => run.textContent.includes('reset'))
            console.assert(style(reset).fontWeight === '400' && style(reset).fontStyle === 'normal',
                'Normal inline text overrides a surrounding bold/italic paragraph')
            console.assert(test.output('breaks').textContent.includes('\n\n')
                && test.output('indent').textContent.startsWith('  ')
                && test.output('indent').textContent.includes('\n\t')
                && test.output('indent').textContent.endsWith('  '), 'Mixed emphasis preserves blank lines and preformatted indentation')
            const nested = Array.from(test.output('class').children).find(run => run.textContent.includes('nested'))
            console.assert(style(nested).fontWeight === '600' && style(nested).fontStyle.startsWith('oblique'),
                'Computed CSS emphasis survives across nested inline elements')
        }
        console.assert(calls.length === 6 && calls[0].text === text && calls[0].segments.length > 3,
            'Each mixed paragraph uses one model request with the entire paragraph context')
        console.assert(entries.every(entry => test.saved.get(entry.key) === entry.text)
            && test.output('plain').textContent === '普通段落缓存', 'Old plain and flattened emphasis caches are never overwritten or cleared')
        const output = test.output('rich')
        for (const offset of [2, output.firstChild.textContent.length + 1, output.textContent.length - 2]) {
            test.controller.restorePosition({ key: oldKey, offset, viewportOffset: 17 })
            await test.controller.setMode(test.controller.mode === 'translation' ? 'bilingual' : 'translation')
            const anchor = test.anchors.at(-1)
            test.view.lastLocation.range = anchor.range
            console.assert(test.controller.getPosition().offset === offset && anchor.offset === 17,
                'Paragraph-wide bookmarks restore exactly across plain, bold and italic text nodes')
        }
        const warmed = await fixture(markup, {
            entries: Array.from(test.saved, ([key, text]) => ({ key, text })),
            translate: async () => { throw new Error('Unexpected structured cache miss') },
        })
        try {
            await warmed.controller.setMode('translation')
            await warmed.complete()
            console.assert(warmed.output('rich').innerHTML === output.innerHTML
                && warmed.output('indent').innerHTML === test.output('indent').innerHTML,
            'New documents recover styled text and whitespace entirely from structured caches')
        } finally { warmed.close() }
    } finally { test.close() }
}

{
    let valid = false
    const test = await fixture('<p id="invalid">Plain <strong>bold</strong> end.</p>', {
        translate: async ({ segments }) => valid ? JSON.stringify(segments) : '格式不完整的纯文本',
    })
    try {
        await test.controller.setMode('translation')
        await waitFor(() => test.statuses.at(-1)?.state === 'error', 'invalid structured response')
        console.assert(test.saved.size === 0 && test.output('invalid').querySelector('button'),
            'Malformed model formatting is retryable and never becomes a completed cache entry')
        valid = true
        test.controller.retry()
        await test.complete()
        console.assert(test.saved.size === 1 && test.output('invalid').children.length === 3,
            'Retry recovers the formatted paragraph without clearing unrelated data')
    } finally { test.close() }
}

{
    const calls = []
    const text = 'Underconsumption: In order to build his net, Able is unable to fish that day.'
    const oldKey = `0:0:${text}`
    const markup = `<div id="label"><span><span style="font-weight:bold">Underconsumption:</span></span> In order to build his net, Able is unable to fish that day.</div>
        <p id="risk"><strong><em>Risk-taking:</em></strong><br>He is also taking risk.</p>`
    const test = await fixture(markup, {
        entries: [{ key: oldKey, text: '没有格式边界的旧译文' }],
        translate: async ({ text }) => {
            calls.push(text)
            return text === 'Underconsumption:' ? '节制消费：' : `译文：${text}`
        },
    })
    try {
        for (const mode of ['bilingual', 'translation']) {
            await test.controller.setMode(mode)
            await test.complete()
            const output = test.output('label')
            const title = output.querySelector('[data-foliate-translation-title]')
            const style = node => test.doc.defaultView.getComputedStyle(node)
            console.assert(title.textContent === '节制消费：' && style(title).fontWeight === '700',
                `${mode}: real-book nested inline title retains Chinese bold`)
            console.assert(style(output).fontWeight === '400' && style(output).fontSize === '24px'
                && output.lastChild.nodeType === 3, 'Only the label is bold; its explanation stays normal at 24px')
            const risk = test.output('risk')
            console.assert(style(risk.firstChild).fontWeight === '700' && style(risk.firstChild).fontStyle === 'italic'
                && risk.lastChild.textContent.startsWith('\n'), 'Inline title emphasis and its authored break survive together')
        }
        console.assert(calls.length === 4 && test.saved.get(oldKey) === '没有格式边界的旧译文',
            'Only title-bearing paragraphs get structured translations; old caches remain intact')
        const output = test.output('label')
        const titleLength = output.firstChild.textContent.length
        for (const offset of [2, titleLength + 7, output.textContent.length + 50]) {
            test.controller.restorePosition({ key: oldKey, offset, viewportOffset: 9 })
            await test.controller.setMode('bilingual')
            await test.complete()
            const anchor = test.anchors.at(-1)
            const expectedNode = offset <= titleLength ? output.firstChild.firstChild : output.lastChild
            console.assert(anchor.range.startContainer === expectedNode
                && anchor.range.startOffset === (offset <= titleLength ? offset
                : Math.min(offset - titleLength, output.lastChild.length)) && anchor.offset === 9,
            'Bookmarks resolve inside both title and explanation, clamping offsets past the end')
            test.view.lastLocation.range = anchor.range
            console.assert(test.controller.getPosition().offset === Math.min(offset, output.textContent.length),
                'Nested translated text reports a paragraph-wide character offset')
            await test.controller.setMode('translation')
        }
        const reloaded = await fixture(markup, {
            entries: Array.from(test.saved, ([key, text]) => ({ key, text })),
            translate: async () => { throw new Error('Unexpected title cache miss') },
        })
        try {
            await reloaded.controller.setMode('translation')
            await reloaded.complete()
            console.assert(reloaded.output('label').innerHTML === output.innerHTML,
                'Reloaded structured caches reproduce the same title boundary without model calls')
        } finally { reloaded.close() }
    } finally { test.close() }
}

{
    let calls = 0
    const test = await fixture(`
        <h1 id="h1" style="font-weight:bold;text-align:center">Title</h1>
        <h2 id="h2">Section</h2><h3 id="h3">Subsection</h3>
        <h4 id="h4">Fourth</h4><h5 id="h5">Fifth</h5><h6 id="h6">Sixth</h6>
        <p id="whole" style="font-weight:700;font-style:italic;text-align:center;text-indent:2em">Whole emphasis</p>
        <p id="nested"><strong><em>Entire wrapped emphasis</em></strong></p>
        <p id="mixed">Normal <strong>part only</strong>.</p>
        <p id="right" style="text-align:right">Right aligned</p>
        <blockquote id="quote" style="font-style:italic;border-left:4px solid black">Quote</blockquote>
        <table><tr><th id="head">Header</th><td id="cell">Cell</td></tr></table>`, {
        translate: async ({ text, segments }) => {
            calls++
            return segments ? JSON.stringify(segments.map(({ id, text }) => ({ id, text: `译文：${text}` })))
                : `译文：${text}`
        },
        entries: [{ key: '0:6:Whole emphasis', text: '已有缓存的整段强调' }],
    })
    const style = node => test.doc.defaultView.getComputedStyle(node)
    try {
        for (const mode of ['bilingual', 'translation']) {
            await test.controller.setMode(mode)
            await test.complete()
            const sizes = [1, 2, 3, 4, 5, 6].map(level => parseFloat(style(test.output(`h${level}`)).fontSize))
            console.assert(sizes.every((size, i) => !i || size < sizes[i - 1]),
                `${mode}: translated h1–h6 keep a descending heading hierarchy`, sizes)
            console.assert(style(test.output('h1')).fontWeight === '700'
                && style(test.output('h1')).textAlign === 'center', 'Heading weight and alignment follow the source')
            console.assert(style(test.output('whole')).fontSize === '24px'
                && style(test.output('whole')).lineHeight === '37.2px', 'Body stays at 24px with the accepted line height')
            console.assert(style(test.output('whole')).fontWeight === '700'
                && style(test.output('whole')).fontStyle === 'italic'
                && style(test.output('whole')).textAlign === 'center', `${mode}: cached whole-paragraph emphasis and alignment survive`)
            console.assert(test.output('whole').textContent === '已有缓存的整段强调', 'Presentation changes reuse existing cached text')
            console.assert(style(test.output('nested')).fontWeight === '700'
                && style(test.output('nested')).fontStyle === 'italic', 'Entire paragraphs wrapped in strong/em preserve emphasis')
            console.assert(style(test.output('mixed')).fontWeight === '400', 'A locally bold word does not make its whole translation bold')
            console.assert(style(test.output('right')).textAlign === 'right', 'Right-aligned paragraphs remain right-aligned')
            console.assert(style(test.output('quote')).fontStyle === 'italic'
                && style(test.doc.getElementById('quote')).borderLeftWidth === '4px', 'Quote style and its existing border survive')
            console.assert(style(test.output('head')).fontWeight === '700'
                && style(test.output('head')).textAlign === 'center', 'Table headers keep their weight and alignment')
        }
        console.assert(calls === 12, 'Style checks and mode switching do not retranslate the cached paragraph')
        console.assert(style(test.doc.getElementById('whole')).marginBottom === '5.4px',
            'Accepted compact paragraph margin remains 0.3em of the original 18px paragraph')
        await test.controller.setMode('original')
        console.assert(style(test.output('whole')).display === 'none'
            && style(test.doc.querySelector('#whole [data-foliate-source-text]')).display !== 'none',
        'Returning to original reveals source text and hides the translated block')
    } finally { test.close() }
}

{
    const calls = []
    const plainKey = '0:0:Old paragraph'
    const oldLineKey = '0:1:First lineSecond line'
    const entries = [{ key: plainKey, text: '原有段落缓存' }, { key: oldLineKey, text: '旧版已压平的译文' }]
    const markup = `<p id="plain">Old paragraph</p><p id="lines">First line<br><br>Second line</p>
        <pre id="pre">  Alpha\n\n\tBeta  </pre><p id="safe">Escaped\n    HTML whitespace</p>`
    const test = await fixture(markup, {
        entries, translate: async ({ text }) => { calls.push(text); return `译文：${text}` },
    })
    try {
        test.controller.restorePosition({ key: oldLineKey, offset: 7, viewportOffset: 13 })
        await test.controller.setMode('translation')
        await test.complete()
        console.assert(test.output('plain').textContent === '原有段落缓存' && !calls.includes('Old paragraph'),
            'Existing ordinary paragraph caches keep their identity and avoid model calls')
        console.assert(test.output('lines').textContent === '译文：First line\n\n译文：Second line',
            'Explicit br and blank lines survive translation')
        console.assert(test.output('pre').textContent === '  译文：Alpha\n\n\t译文：Beta  ',
            'Preformatted line breaks, leading indentation and trailing whitespace survive')
        console.assert(calls.includes('First line') && calls.includes('Second line')
            && !calls.some(text => text.includes('\n')), 'Structured paragraphs translate whole individual lines')
        console.assert(calls.includes('Escaped HTML whitespace'), 'HTML source indentation does not become a visible line break')
        console.assert(test.saved.get(oldLineKey) === '旧版已压平的译文' && test.saved.get(plainKey) === '原有段落缓存',
            'Refreshing an incompatible line cache never clears legacy cache entries')
        console.assert(test.saved.size === 5, 'Only structured cache entries and the uncached normal paragraph are added')
        const restored = test.anchors.find(({ range, offset }) => range.startContainer === test.output('lines').firstChild
            && range.startOffset === 7 && offset === 13)
        console.assert(restored, 'Legacy paragraph bookmarks still resolve after the structured cache key changes')
        await test.controller.setMode('bilingual')
        await test.controller.setMode('translation')
        console.assert(calls.length === 5, 'Switching modes reuses completed line translations')
        const warmed = Array.from(test.saved, ([key, text]) => ({ key, text }))
        const reloaded = await fixture(markup, { entries: warmed, translate: async () => { throw new Error('Unexpected cache miss') } })
        try {
            await reloaded.controller.setMode('translation')
            await reloaded.complete()
            console.assert(reloaded.output('lines').textContent === test.output('lines').textContent
                && reloaded.output('pre').textContent === test.output('pre').textContent,
            'A fresh document reuses structured translation caches including their whitespace')
        } finally { reloaded.close() }
    } finally { test.close() }
}

for (const first of ['First line', 'First line:']) {
    let firstResolve
    let secondCalls = 0
    const markup = first.endsWith(':') ? `<strong>${first}</strong> Second line` : `${first}<br>Second line`
    const test = await fixture(`<p id="cancel">${markup}</p>`, {
        translate: ({ text }) => text === first
            ? new Promise(resolve => firstResolve = resolve)
            : (secondCalls++, Promise.resolve('第二行')),
    })
    try {
        await test.controller.setMode('translation')
        await waitFor(() => firstResolve, 'first line requested')
        await test.controller.setMode('original')
        firstResolve('第一行')
        await new Promise(resolve => setTimeout(resolve, 100))
        console.assert(secondCalls === 0 && test.saved.size === 0,
            'Cancelling a structured paragraph stops later lines and never caches a partial result')
    } finally { test.close() }
}

{
    let finish
    let segments
    const test = await fixture('<p id="cancel-rich">Before <em>emphasis</em> after.</p>', {
        translate: payload => {
            segments = payload.segments
            return new Promise(resolve => finish = resolve)
        },
    })
    try {
        await test.controller.setMode('translation')
        await waitFor(() => finish, 'structured paragraph requested')
        await test.controller.setMode('original')
        finish(JSON.stringify(segments))
        await new Promise(resolve => setTimeout(resolve, 100))
        console.assert(test.saved.size === 0 && !test.output('cancel-rich'),
            'Cancelled structured results cannot change the cache or original reading mode')
    } finally { test.close() }
}
