import { PageTranslation } from '../translation.js'
import * as CFI from '../epubcfi.js'
import { textWalker } from '../text-walker.js'

const waitFor = async (condition, label) => {
    for (let i = 0; i < 100; i++) {
        if (condition()) return
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`Translation regression timed out: ${label}`)
}
const deferred = () => {
    let resolve
    const promise = new Promise(done => resolve = done)
    return { promise, resolve }
}
const fixture = async (translate, bodyPrefix = '') => {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'width:800px;height:500px'
    const ready = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    // Keep this CFI/lifecycle fixture on the legacy plain-text protocol.
    // Mixed computed emphasis is exercised by translation-format-tests.js.
    frame.srcdoc = `<html><head></head><body>${bodyPrefix}<p id="one">First <em style="font-style:normal">complete</em> paragraph <a href="#two">link</a>.</p>
        <p id="two">Second paragraph stays in the book.</p></body></html>`
    document.body.append(frame)
    await ready
    const doc = frame.contentDocument
    const range = doc.createRange()
    range.selectNodeContents(doc.getElementById('one'))
    const originalText = doc.querySelector('em').firstChild
    const originalRange = doc.createRange()
    originalRange.selectNodeContents(originalText)
    const originalCFI = CFI.fromRange(originalRange)
    doc.getSelection().setBaseAndExtent(originalText, 0, originalText, originalText.length)
    const renderer = new EventTarget()
    renderer.getContents = () => [{ doc, index: 0 }]
    renderer.restoreAnchor = () => Promise.resolve()
    const view = { renderer, book: {}, lastLocation: { range } }
    const statuses = [], cancelled = []
    const controller = new PageTranslation(view, {
        translate,
        cancel: id => cancelled.push(id),
        onStatus: status => statuses.push(status),
        prefetch: false,
    })
    const preparedRange = doc.createRange()
    preparedRange.selectNodeContents(originalText)
    console.assert(CFI.fromRange(preparedRange) === originalCFI,
        'Preparing source wrappers preserves the CFI of the same original node')
    console.assert(doc.getSelection().toString() === 'complete',
        'Preparing source wrappers preserves the actual reader selection')
    return { controller, doc, range, renderer, statuses, cancelled,
        close: () => { controller.destroy(); frame.remove() } }
}

{
    const requested = []
    const test = await fixture(async ({ text }) => {
        requested.push(text)
        return '本屏段落的译文。'
    }, 'An earlier introduction outside paragraph elements.')
    try {
        await test.controller.setMode('bilingual')
        await waitFor(() => test.doc.querySelector('[data-foliate-state="complete"]'), 'bare body text boundary')
        console.assert(requested.length === 1 && requested[0].startsWith('First complete'),
            'An ancestor body with bare text does not translate that text on every screen')
    } finally { test.close() }
}

{
    let calls = 0
    const test = await fixture(async () => { calls++; return '<script>unsafe()</script>这是一段译文。' })
    try {
        const { controller, doc } = test
        const source = doc.querySelector('em [data-foliate-source-text]').firstChild
        const selection = doc.createRange()
        selection.selectNodeContents(source)
        const before = CFI.fromRange(selection)
        await controller.setMode('bilingual')
        await waitFor(() => doc.querySelector('[data-foliate-state="complete"]'), 'first translation')
        console.assert(calls === 1, 'Translate a visible paragraph only once')
        console.assert(CFI.fromRange(selection) === before, 'Source CFI survives transparent wrappers')
        console.assert(CFI.toRange(doc, CFI.parse(before)).toString() === 'complete',
            'An existing CFI still resolves to the original text')
        const output = doc.querySelector('[data-foliate-translation]')
        console.assert(!output.querySelector('script') && output.textContent.startsWith('<script>'),
            'Translation is displayed as untrusted text, never HTML')
        const walked = Array.from(textWalker(doc, strs => [strs.join('')])).join('')
        console.assert(!walked.includes('这是一段译文'), 'Text walking excludes translation text')
        await controller.setMode('translation')
        console.assert(calls === 1, 'Display mode changes do not call the model')
        console.assert(doc.defaultView.getComputedStyle(source.parentElement).display === 'none',
            'Translation-only hides completed source text')
        console.assert(doc.defaultView.getComputedStyle(doc.querySelector('a').firstElementChild).display !== 'none',
            'Translation-only preserves the original link entry')
        const translatedRange = doc.createRange()
        translatedRange.selectNodeContents(output.firstChild)
        console.assert(!CFI.toRange(doc, CFI.parse(CFI.fromRange(translatedRange))).toString()
            .includes('这是一段译文'), 'Translation locations map back to original text')
        await controller.setMode('original')
        console.assert(doc.defaultView.getComputedStyle(output).display === 'none', 'Original mode hides translations')
        await controller.setMode('bilingual')
        await new Promise(resolve => setTimeout(resolve, 200))
        console.assert(calls === 1, 'Re-enabling reuses completed paragraph results')
        test.renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'anchor' } }))
        await new Promise(resolve => setTimeout(resolve, 200))
        console.assert(calls === 1, 'Layout reflow does not start translation requests')
    } finally { test.close() }
}

{
    const frame = document.createElement('iframe')
    frame.style.cssText = 'width:800px;height:500px'
    const ready = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = `<html><head></head><body>
        <p id="entry"><span><a href="#target"><span>Chapter 9</span></a></span></p>
        <p id="target">Target paragraph.</p></body></html>`
    document.body.append(frame)
    await ready
    const doc = frame.contentDocument
    const range = doc.createRange()
    range.selectNodeContents(doc.getElementById('entry'))
    const renderer = new EventTarget()
    renderer.getContents = () => [{ doc, index: 0 }]
    renderer.restoreAnchor = () => Promise.resolve()
    const view = { renderer, book: {}, lastLocation: { range } }
    const controller = new PageTranslation(view, {
        translate: async () => '第九章：政府发挥创意。',
        cancel: () => {},
        onStatus: () => {},
    })
    try {
        await controller.setMode('translation')
        await waitFor(() => doc.querySelector('[data-foliate-state="complete"]'), 'linked entry')
        const source = doc.querySelector('#entry [data-foliate-source-text]')
        console.assert(source && !source.hasAttribute('data-foliate-retain'),
            'A fully linked entry does not retain its source text')
        console.assert(doc.defaultView.getComputedStyle(source).display === 'none',
            'Translation-only hides a fully linked entry')
        console.assert(doc.querySelector('[data-foliate-translation]').textContent
            === '第九章：政府发挥创意。', 'A linked entry displays its translation')
    } finally {
        controller.destroy()
        frame.remove()
    }
}

{
    const frame = document.createElement('iframe')
    frame.style.cssText = 'width:800px;height:500px'
    const ready = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = `<html><head></head><body>
        <p>Alpha</p><p>Beta</p><p>Gamma</p><p>Delta</p></body></html>`
    document.body.append(frame)
    await ready
    const doc = frame.contentDocument
    const range = doc.createRange()
    range.selectNodeContents(doc.body)
    const renderer = new EventTarget()
    renderer.getContents = () => [{ doc, index: 0 }]
    renderer.restoreAnchor = () => Promise.resolve()
    const view = { renderer, book: {}, lastLocation: { range } }
    const requests = []
    const controller = new PageTranslation(view, {
        translate: ({ text }) => new Promise(resolve => requests.push({ text, resolve })),
        cancel: () => {},
        onStatus: () => {},
    })
    try {
        await controller.setMode('bilingual')
        await waitFor(() => requests.length === 4, 'all paragraphs requested immediately')
        const translation = text => requests.find(request => request.text === text)
        translation('Gamma').resolve('伽马')
        translation('Delta').resolve('德尔塔')
        translation('Alpha').resolve('阿尔法')
        translation('Beta').resolve('贝塔')
        await waitFor(() => doc.querySelectorAll('[data-foliate-state="complete"]').length === 4,
            'all translations')
        const outputs = Array.from(doc.querySelectorAll('[data-foliate-translation]'))
            .map(output => output.textContent)
        console.assert(outputs.join(',') === '阿尔法,贝塔,伽马,德尔塔',
            'All requests are displayed in source order')
    } finally {
        controller.destroy()
        frame.remove()
    }
}

{
    const frame = document.createElement('iframe')
    frame.style.cssText = 'width:800px;height:500px'
    const ready = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<html><head></head><body><p id="one">Geometry paragraph.</p></body></html>'
    document.body.append(frame)
    await ready
    const doc = frame.contentDocument
    // Simulate the paginator right after a section switch: the relocation
    // range is empty, but the iframe still shows a paragraph.
    const range = doc.createRange()
    range.setStart(doc.body, 0)
    range.collapse(true)
    const renderer = new EventTarget()
    renderer.getContents = () => [{ doc, index: 0 }]
    renderer.restoreAnchor = () => Promise.resolve()
    const clip = frame.getBoundingClientRect()
    const view = {
        renderer,
        book: {},
        lastLocation: { range },
        getBoundingClientRect: () => clip,
    }
    const controller = new PageTranslation(view, {
        translate: async () => '几何译文',
        cancel: () => {},
        onStatus: () => {},
        prefetch: false,
    })
    try {
        await controller.setMode('translation')
        await waitFor(() => doc.querySelector('[data-foliate-translation]'), 'geometry fallback')
        console.assert(doc.querySelector('[data-foliate-translation]').textContent === '几何译文',
            'A visible paragraph is translated even when the relocation range is empty')
    } finally {
        controller.destroy()
        frame.remove()
    }
}

{
    const frame = document.createElement('iframe')
    frame.style.cssText = 'width:800px;height:500px'
    const ready = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<html><head></head><body><p id="one">Cached paragraph.</p></body></html>'
    document.body.append(frame)
    await ready
    const doc = frame.contentDocument
    const range = doc.createRange()
    range.selectNodeContents(doc.getElementById('one'))
    const renderer = new EventTarget()
    renderer.getContents = () => [{ doc, index: 0 }]
    renderer.restoreAnchor = () => Promise.resolve()
    const view = { renderer, book: {}, lastLocation: { range } }
    let calls = 0
    const saved = []
    const controller = new PageTranslation(view, {
        translate: async () => { calls++; return '不应请求' },
        cancel: () => {},
        onStatus: () => {},
        cacheStore: {
            load: async () => [{ key: '0:0:Cached paragraph.', text: '缓存译文' }],
            save: async entries => saved.push(...entries),
            clear: async () => {},
        },
    })
    try {
        await controller.setMode('bilingual')
        await waitFor(() => doc.querySelector('[data-foliate-translation]'), 'persisted translation')
        console.assert(calls === 0, 'A persisted translation is reused without a request')
        console.assert(doc.querySelector('[data-foliate-translation]').textContent === '缓存译文',
            'A persisted translation is displayed')
        console.assert(saved.length === 0, 'Reusing the cache does not write it again')
    } finally {
        controller.destroy()
        frame.remove()
    }
}

{
    const frame = document.createElement('iframe')
    frame.style.cssText = 'width:800px;height:500px'
    const ready = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<html><head></head><body><p id="one">Fresh paragraph.</p></body></html>'
    document.body.append(frame)
    await ready
    const doc = frame.contentDocument
    const range = doc.createRange()
    range.selectNodeContents(doc.getElementById('one'))
    const renderer = new EventTarget()
    renderer.getContents = () => [{ doc, index: 0 }]
    renderer.restoreAnchor = () => Promise.resolve()
    const view = { renderer, book: {}, lastLocation: { range } }
    const saved = []
    const controller = new PageTranslation(view, {
        translate: async () => '新译文',
        cancel: () => {},
        onStatus: () => {},
        cacheStore: {
            load: async () => [],
            save: async entries => saved.push(...entries),
            clear: async () => {},
        },
    })
    try {
        await controller.setMode('bilingual')
        await waitFor(() => saved.length === 1, 'persisted translation write')
        console.assert(saved[0].key === '0:0:Fresh paragraph.' && saved[0].text === '新译文',
            'A completed translation is persisted')
    } finally {
        controller.destroy()
        frame.remove()
    }
}

{
    const frame = document.createElement('iframe')
    frame.style.cssText = 'width:800px;height:500px'
    const ready = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = `<html><head></head><body>
        <p id="a">Alpha paragraph.</p><p id="b">Beta paragraph.</p>
        <p id="c">Gamma paragraph.</p><p id="d">Delta paragraph.</p></body></html>`
    document.body.append(frame)
    await ready
    const doc = frame.contentDocument
    const range = doc.createRange()
    range.setStartBefore(doc.getElementById('a'))
    range.setEndAfter(doc.getElementById('b'))
    const renderer = new EventTarget()
    renderer.getContents = () => [{ doc, index: 0 }]
    renderer.restoreAnchor = () => Promise.resolve()
    const view = { renderer, book: {}, lastLocation: { range } }
    const requested = []
    const controller = new PageTranslation(view, {
        translate: async ({ text }) => {
            requested.push(text)
            return `${text} 译文`
        },
        cancel: () => {},
        onStatus: () => {},
    })
    try {
        await controller.setMode('bilingual')
        await waitFor(() => requested.length === 4, 'prefetched next paragraphs')
        const outputs = () => Array.from(doc.querySelectorAll('[data-foliate-translation]'))
        console.assert(outputs().length === 2, 'Prefetched translations are not displayed early')
        const nextRange = doc.createRange()
        nextRange.setStartBefore(doc.getElementById('c'))
        nextRange.setEndAfter(doc.getElementById('d'))
        view.lastLocation = { range: nextRange }
        renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'page' } }))
        await waitFor(() => outputs().length === 4, 'cached next page')
        console.assert(requested.length === 4, 'The next page is displayed from the prefetch cache')
        console.assert(outputs().map(output => output.textContent).join(',')
            === 'Alpha paragraph. 译文,Beta paragraph. 译文,Gamma paragraph. 译文,Delta paragraph. 译文',
        'Prefetched and current translations keep source order')
    } finally {
        controller.destroy()
        frame.remove()
    }
}

{
    const result = deferred()
    let calls = 0
    const test = await fixture(() => { calls++; return result.promise })
    try {
        await test.controller.setMode('bilingual')
        await waitFor(() => calls === 1, 'pending paragraph')
        await test.controller.setMode('translation')
        console.assert(test.cancelled.length === 0, 'Switching active display modes does not cancel the batch')
        result.resolve('切换模式时仍完成原来的翻译。')
        await waitFor(() => test.doc.querySelector('[data-foliate-state="complete"]'), 'mode-switched result')
        console.assert(calls === 1, 'An in-flight paragraph is not duplicated after mode switching')
    } finally { test.close() }
}

{
    const old = deferred(), fresh = deferred()
    let calls = 0
    const test = await fixture(() => ++calls === 1 ? old.promise : fresh.promise)
    try {
        await test.controller.setMode('bilingual')
        await waitFor(() => calls === 1, 'old configuration request')
        await test.controller.clear()
        test.controller.retry()
        await waitFor(() => calls === 2, 'new configuration request')
        old.resolve('不应显示的旧配置译文。')
        await new Promise(resolve => setTimeout(resolve, 40))
        console.assert(!test.doc.querySelector('[data-foliate-state="complete"]'),
            'A late response cannot repopulate cleared translation results')
        fresh.resolve('新配置生成的译文。')
        await waitFor(() => test.doc.querySelector('[data-foliate-state="complete"]'), 'new configuration result')
        console.assert(test.doc.querySelector('[data-foliate-translation]').textContent === '新配置生成的译文。',
            'Only the new configuration result is displayed')
    } finally { test.close() }
}

// Completed responses must survive a slow first paragraph and a page change.
{
    const first = deferred(), second = deferred()
    const test = await fixture(({ text }) => text.startsWith('First') ? first.promise : second.promise)
    try {
        // The fixture retains the live range used by the view.
        test.range.setEndAfter(test.doc.getElementById('two'))
        await test.controller.setMode('bilingual')
        await new Promise(resolve => setTimeout(resolve, 200))
        second.resolve('第二段先完成。')
        await new Promise(resolve => setTimeout(resolve, 30))
        test.range.setStartBefore(test.doc.getElementById('two'))
        test.renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason: 'page' } }))
        await waitFor(() => test.doc.getElementById('two').querySelector('[data-foliate-translation]'),
            'completed second paragraph survives navigation')
        console.assert(test.doc.getElementById('two').querySelector('[data-foliate-translation]').textContent
            === '第二段先完成。', 'A later completed result is cached without waiting for the first paragraph')
        first.resolve('第一段稍后完成。')
    } finally { test.close() }
}

// Restoring the reading anchor must preserve an offset inside a long translation.
{
    const test = await fixture(async () => '很长的译文，用于验证阅读位置不回到段落开头。')
    try {
        await test.controller.setMode('bilingual')
        await waitFor(() => test.doc.querySelector('[data-foliate-state="complete"]'), 'anchor translation')
        const output = test.doc.querySelector('[data-foliate-translation]')
        const position = { key: '0:0:First complete paragraph link.', offset: 8 }
        test.controller.restorePosition(position)
        let restored
        test.renderer.restoreAnchor = range => { restored = range; return Promise.resolve() }
        test.controller.retry()
        await waitFor(() => restored, 'restored translated character offset')
        console.assert(restored.startContainer === output.firstChild && restored.startOffset === 8,
            'Resume restores the character inside the translation, not its paragraph start')
    } finally { test.close() }
}

// Ignore late prefetch results even when cancellation cannot stop the provider.
{
    const frame = document.createElement('iframe')
    const ready = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
    frame.srcdoc = '<html><head></head><body><p id="one">Visible.</p><p>Prefetched.</p></body></html>'
    document.body.append(frame)
    await ready
    const doc = frame.contentDocument
    const range = doc.createRange()
    range.selectNodeContents(doc.getElementById('one'))
    const renderer = new EventTarget()
    renderer.getContents = () => [{ doc, index: 0 }]
    renderer.restoreAnchor = () => Promise.resolve()
    const result = deferred(), saved = []
    let prefetchStarted = false
    const controller = new PageTranslation({ renderer, book: {}, lastLocation: { range } }, {
        translate: ({ text }) => {
            if (text === 'Visible.') return Promise.resolve('当前段落。')
            prefetchStarted = true
            return result.promise
        },
        cacheStore: { load: async () => [], save: async entries => saved.push(...entries),
            clear: async () => { saved.length = 0 } },
    })
    try {
        await controller.setMode('bilingual')
        await waitFor(() => prefetchStarted, 'prefetch started')
        await controller.clear()
        result.resolve('旧译文不得写回。')
        await new Promise(resolve => setTimeout(resolve, 40))
        console.assert(saved.length === 0, 'Cleared prefetch cannot repopulate persistent translations')
    } finally { controller.destroy(); frame.remove() }
}

// Inserting a later result must retain a boundary inside an existing output.
{
    const later = deferred()
    const test = await fixture(({ text }) => text.startsWith('First')
        ? Promise.resolve('第一段译文中间的位置需要保留。') : later.promise)
    try {
        test.range.setEndAfter(test.doc.getElementById('two'))
        await test.controller.setMode('bilingual')
        await waitFor(() => test.doc.querySelector('[data-foliate-state="complete"]'), 'first output')
        const text = test.doc.querySelector('[data-foliate-translation]').firstChild
        test.range.setStart(text, 7)
        test.range.collapse(true)
        let restored
        test.renderer.restoreAnchor = range => { restored = range; return Promise.resolve() }
        later.resolve('后续译文。')
        await waitFor(() => restored, 'later output anchored')
        console.assert(restored.startContainer === text && restored.startOffset === 7,
            'A later translation does not reset the current translation to the paragraph start')
    } finally { test.close() }
}

// A successful retry can enter the cache just before navigation invalidates
// its display batch. The next batch must replace the old error with that cache.
{
    const result = deferred()
    let calls = 0
    const test = await fixture(() => {
        if (++calls === 1) return Promise.reject(new Error('本地服务暂不可用'))
        return result.promise
    })
    try {
        await test.controller.setMode('translation')
        await waitFor(() => test.doc.querySelector('[data-foliate-state="error"]'), 'initial failed paragraph')
        test.controller.retry()
        await waitFor(() => calls === 2, 'retry request')
        result.promise.then(() => test.renderer.dispatchEvent(
            new CustomEvent('relocate', { detail: { reason: 'page' } })))
        result.resolve('重试成功后的完整译文。')
        await waitFor(() => test.statuses.at(-1)?.state === 'complete', 'cached retry completion')
        console.assert(test.doc.querySelector('[data-foliate-translation]').textContent
            === '重试成功后的完整译文。', 'A cached successful retry replaces an existing error output')
        console.assert(!test.doc.querySelector('[data-foliate-state="error"]'),
            'Page completion does not retain the failed paragraph')
        console.assert(calls === 2, 'Recovering the display reuses the successful retry without another request')
    } finally { test.close() }
}
