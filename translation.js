import { parseTranslatedSegments } from './translation-format.js'

const paragraphSelector = 'p,h1,h2,h3,h4,h5,h6,li,dt,dd,figcaption,blockquote,pre,td,th,div'
const ignoredSelector = 'script,style,noscript,template,svg,math,[hidden],[data-foliate-translation]'
const readingReasons = new Set(['page', 'scroll', 'navigation', 'snap'])
const minPrefetchParagraphs = 6
const maxPrefetchParagraphs = 12
const maxPrefetchCharacters = 12000
const maxTranslationRequests = 8
const maxBackgroundRequests = 6

const sourceNodes = element => {
    const nodes = []
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement
        if (parent.closest(ignoredSelector)) continue
        const paragraph = parent.closest(paragraphSelector)
        if (paragraph !== element && !(element === element.ownerDocument.body && !paragraph)) continue
        nodes.push(node)
    }
    return nodes
}

// Keep authored breaks distinct from whitespace used to indent HTML markup.
const sourceLayout = (element, nodes) => {
    const doc = element.ownerDocument
    const getStyle = node => doc.defaultView.getComputedStyle(node)
    const whitespace = getStyle(element).whiteSpace
    const verbatim = ['pre', 'pre-wrap', 'break-spaces'].includes(whitespace)
    const multiline = verbatim || whitespace === 'pre-line'
    const included = new Set(nodes)
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    const units = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        let value
        let parent
        if (included.has(node)) {
            value = node.nodeValue.replace(/\r\n?/g, '\n')
            if (!multiline) value = value.replace(/\s+/g, ' ')
            parent = node.parentElement
        } else if (node.localName === 'br' && !node.closest(ignoredSelector)) {
            const paragraph = node.parentElement.closest(paragraphSelector)
            if (paragraph !== element && !(element === doc.body && !paragraph)) continue
            value = '\n'
            parent = node.parentElement
        } else continue
        const style = getStyle(parent)
        const emphasis = { fontWeight: style.fontWeight, fontStyle: style.fontStyle }
        for (const text of value.split('')) units.push({ text, emphasis })
    }
    const normalized = []
    let pendingSpace
    let lineStart = true
    for (const unit of units) {
        if (verbatim) { normalized.push(unit); continue }
        if (unit.text === '\n') {
            normalized.push(unit)
            lineStart = true
            pendingSpace = null
        } else if (/\s/.test(unit.text)) pendingSpace ??= unit
        else {
            if (pendingSpace && !lineStart) normalized.push({ ...pendingSpace, text: ' ' })
            normalized.push(unit)
            pendingSpace = null
            lineStart = false
        }
    }
    const runs = []
    for (const unit of normalized) {
        const last = runs.at(-1)
        // Breaks stay separate, so the model cannot move words across lines.
        if (last && !last.text.includes('\n') && unit.text !== '\n'
            && last.emphasis.fontWeight === unit.emphasis.fontWeight
            && last.emphasis.fontStyle === unit.emphasis.fontStyle) last.text += unit.text
        else runs.push({ text: unit.text, emphasis: unit.emphasis })
    }
    if (verbatim) {
        const indented = runs.flatMap(run => run.text.split(/(^[ \t]+|[ \t]+$)/)
            .filter(Boolean).map(text => ({ ...run, text })))
        runs.splice(0, runs.length, ...indented)
    }
    const text = runs.map(run => run.text).join('')
    return { text, lines: text.includes('\n') || verbatim ? text.split('\n') : null, runs }
}

const partialEmphasis = (element, runs, title) => {
    const meaningful = runs.filter(run => run.text.trim())
    const styles = new Set(meaningful.map(run => JSON.stringify(run.emphasis)))
    if (styles.size <= 1) return null
    if (title) {
        const parent = element.ownerDocument.defaultView.getComputedStyle(element)
        let offset = 0
        const plainBody = runs.every(run => {
            offset += run.text.length
            return offset <= title.text.length || !run.text.trim()
                || run.emphasis.fontWeight === parent.fontWeight && run.emphasis.fontStyle === parent.fontStyle
        })
        if (plainBody) return null // Keep the existing title-v1 cache compatible.
    }
    return runs.map((run, id) => ({ id, ...run }))
}

const sourceEmphasis = (element, nodes) => {
    const getStyle = node => element.ownerDocument.defaultView.getComputedStyle(node)
    const parent = getStyle(element)
    const styles = nodes.filter(node => node.nodeValue.trim()).map(node => getStyle(node.parentElement))
    return Object.fromEntries(['fontWeight', 'fontStyle'].flatMap(property => {
        const value = styles[0]?.[property]
        return value && value !== parent[property] && styles.every(style => style[property] === value)
            ? [[property, value]] : []
    }))
}

// Some books put a bold label and its explanation in the same ordinary div.
// Translate the label separately so its Chinese boundary is known exactly.
const sourceTitle = (element, nodes, text) => {
    const getStyle = node => element.ownerDocument.defaultView.getComputedStyle(node.parentElement)
    let title = ''
    const styles = []
    for (const node of nodes) {
        if (!node.nodeValue.trim()) { title += node.nodeValue; continue }
        const style = getStyle(node)
        if (Number(style.fontWeight) < 600) break
        title += node.nodeValue
        styles.push({ fontWeight: style.fontWeight, fontStyle: style.fontStyle })
    }
    title = title.replace(/\s+/g, ' ').trim()
    if (!styles.length || !/[:：]$/.test(title) || !text.startsWith(title)
        || !text.slice(title.length).trim()) return null
    return { text: title, emphasis: {
        fontWeight: String(Math.min(...styles.map(style => Number(style.fontWeight)))),
        ...(styles.every(style => style.fontStyle === styles[0].fontStyle)
            ? { fontStyle: styles[0].fontStyle } : {}),
    } }
}

const translatedRange = (output, offset) => {
    const doc = output.ownerDocument
    const walker = doc.createTreeWalker(output, NodeFilter.SHOW_TEXT)
    let last
    const range = doc.createRange()
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        last = node
        if (offset <= node.length) {
            range.setStart(node, offset)
            range.collapse(true)
            return range
        }
        offset -= node.length
    }
    if (!last) return null
    range.setStart(last, last.length)
    range.collapse(true)
    return range
}

// A page range can start on an outer quote/div while its visible Chinese text
// lives several levels below. Recover a real visible caret for that bookmark.
const visibleTranslatedRange = (output, view) => {
    const doc = output.ownerDocument
    const frame = doc.defaultView?.frameElement?.getBoundingClientRect()
    const clip = view.getBoundingClientRect?.()
    if (!frame || !clip?.width || !clip.height) return null
    const walker = doc.createTreeWalker(output, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const range = doc.createRange()
        range.selectNodeContents(node)
        for (const rect of range.getClientRects()) {
            const left = Math.max(rect.left, clip.left - frame.left)
            const right = Math.min(rect.right, clip.right - frame.left)
            const top = Math.max(rect.top, clip.top - frame.top)
            const bottom = Math.min(rect.bottom, clip.bottom - frame.top)
            if (right <= left || bottom <= top) continue
            const x = left + Math.min(1, (right - left) / 2)
            const y = (top + bottom) / 2
            const caret = doc.caretRangeFromPoint?.(x, y)
            if (caret && output.contains(caret.startContainer)) return caret
            const position = doc.caretPositionFromPoint?.(x, y)
            if (position && output.contains(position.offsetNode)) {
                range.setStart(position.offsetNode, position.offset)
                range.collapse(true)
                return range
            }
        }
    }
    return null
}

const css = `
    [data-foliate-source-text] { display: contents; }
    [data-foliate-translation] { display: none; }
    html[data-foliate-reading-mode="bilingual"] [data-foliate-source-text] {
        display: inline;
        color: color-mix(in srgb, CanvasText 72%, transparent);
        font-size: .88em;
    }
    html[data-foliate-reading-mode="bilingual"]
        [data-foliate-source-text][data-foliate-source-body] { font-size: 20px; }
    html:not([data-foliate-reading-mode="original"]) [data-foliate-translation] {
        display: block;
        margin-block: .2em .35em;
        color: CanvasText;
        font-family: 'Songti SC', 'Noto Serif CJK SC', serif;
        font-size: 24px;
        line-height: 1.55;
        font-weight: inherit;
        font-style: inherit;
        text-align: inherit;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }
    html:not([data-foliate-reading-mode="original"])
        :is(h1,h2,h3,h4,h5,h6) > [data-foliate-translation] {
        margin-block: .2em .6em;
        font-size: 32px;
        line-height: 1.35;
        text-align: inherit;
    }
    html:not([data-foliate-reading-mode="original"]) h1 > [data-foliate-translation] { font-size: 36px; }
    html:not([data-foliate-reading-mode="original"]) h2 > [data-foliate-translation] { font-size: 32px; }
    html:not([data-foliate-reading-mode="original"]) h3 > [data-foliate-translation] { font-size: 28px; }
    html:not([data-foliate-reading-mode="original"]) h4 > [data-foliate-translation] { font-size: 26px; }
    html:not([data-foliate-reading-mode="original"]) h5 > [data-foliate-translation] { font-size: 25px; }
    html:not([data-foliate-reading-mode="original"]) h6 > [data-foliate-translation] { font-size: 24px; }
    html:not([data-foliate-reading-mode="original"]) pre > [data-foliate-translation] { font-family: inherit; }
    html[data-foliate-reading-mode="translation"]
        :is(p,div)[data-foliate-complete] {
        margin-block: 0 .3em;
    }
    html[data-foliate-reading-mode="translation"]
        :is(p,div)[data-foliate-complete] > [data-foliate-translation] {
        margin-block: 0;
    }
    html[data-foliate-reading-mode="translation"]
        [data-foliate-source-text][data-foliate-source-complete]:not([data-foliate-retain]) {
        display: none;
    }
    html:not([data-foliate-reading-mode="original"])
        [data-foliate-translation][data-foliate-state="error"] {
        font: 14px/1.5 system-ui, sans-serif;
        color: CanvasText;
    }
    [data-foliate-translation] button {
        margin-inline-start: .6em;
        font: inherit;
        color: LinkText;
        background: transparent;
        border: 0;
        text-decoration: underline;
        cursor: pointer;
    }
`

export class PageTranslation {
    mode = 'original'
    #view
    #translate
    #cancel
    #onStatus
    #documents = new Map()
    #cache = new Map()
    #cacheStore = null
    #cacheReady = Promise.resolve()
    #cacheLoaded = true
    #requestCount = 0
    #cacheEpoch = 0
    #jobs = new Map()
    #queue = []
    #active = 0
    #resumePosition = null
    #prefetchEnabled = true
    #generation = 0
    #timer
    #destroyed = false
    #onLoad
    #onRelocate

    constructor(view, { translate, cancel, onStatus = () => {}, cacheStore = null, prefetch = true }) {
        this.#view = view
        this.#translate = payload => { this.#requestCount++; return translate(payload) }
        this.#cancel = cancel
        this.#onStatus = onStatus
        this.#cacheStore = cacheStore
        this.#prefetchEnabled = prefetch
        if (cacheStore) {
            this.#cacheLoaded = false
            const epoch = this.#cacheEpoch
            this.#cacheReady = Promise.resolve()
                .then(() => cacheStore.load())
                .then(entries => {
                    if (epoch !== this.#cacheEpoch || !entries) return
                    for (const entry of entries) this.#cache.set(entry.key, entry.text)
                })
                .catch(() => {})
                .finally(() => { this.#cacheLoaded = true })
        }
        this.#onLoad = ({ detail: { doc, index } }) => {
            this.#abort()
            this.#prepare(doc, index)
        }
        this.#onRelocate = ({ detail }) => {
            if (this.mode !== 'original' && readingReasons.has(detail.reason)) {
                this.#resumePosition = null
                this.#schedule(detail.reason === 'scroll' ? 160 : 0)
            }
        }
        view.renderer.addEventListener('load', this.#onLoad)
        view.renderer.addEventListener('relocate', this.#onRelocate)
        for (const { doc, index } of view.renderer.getContents()) this.#prepare(doc, index)
    }

    #status(state, message, count) {
        if (!this.#destroyed) this.#onStatus({ state, message, count })
    }

    #supported() {
        return this.#view.book?.rendition?.layout !== 'pre-paginated'
            && typeof this.#view.renderer?.restoreAnchor === 'function'
    }

    #prepare(doc, index) {
        if (!this.#supported() || !doc?.body || this.#documents.has(doc)) return
        // The flowing renderer unloads the preceding section. Keep translated
        // text in the cache without retaining its discarded iframe document.
        this.#documents.clear()
        const selection = doc.getSelection()
        const selected = selection?.rangeCount ? {
            anchor: selection.anchorNode, anchorOffset: selection.anchorOffset,
            focus: selection.focusNode, focusOffset: selection.focusOffset,
        } : null
        const range = this.#view.lastLocation?.range
        const location = range?.startContainer.ownerDocument === doc ? {
            start: range.startContainer, startOffset: range.startOffset,
            end: range.endContainer, endOffset: range.endOffset,
        } : null
        const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style')
        style.setAttribute('data-foliate-translation-style', '')
        style.textContent = css
        doc.head.append(style)
        const paragraphs = []
        const elements = Array.from(doc.body.querySelectorAll(paragraphSelector))
        // Bare text in the body is also valid in legacy formats.
        elements.unshift(doc.body)
        for (const element of elements) {
            if (element.closest(ignoredSelector)) continue
            const nodes = sourceNodes(element)
            if (!nodes.length) continue
            const legacyText = nodes.map(node => node.nodeValue).join('').replace(/\s+/g, ' ').trim()
            if (!legacyText) continue
            const ordinal = paragraphs.length
            element.setAttribute('data-foliate-paragraph', `${index}-${ordinal}`)
            const key = `${index}:${ordinal}:${legacyText}`
            const { text, lines, runs } = sourceLayout(element, nodes)
            // Bookmarks keep their old paragraph identity. Structured line and
            // inline-title translations get separate versioned cache entries.
            const title = sourceTitle(element, nodes, text)
            const layoutKey = text === legacyText ? key : `${key}\u0001layout-v1:${text}`
            const segments = partialEmphasis(element, runs, title)
            const cacheKey = segments ? `${layoutKey}\u0001emphasis-v1:${JSON.stringify(segments)}`
                : title ? `${layoutKey}\u0001title-v1:${title.text}` : layoutKey
            const paragraph = { element, nodes, text, lines, key, cacheKey,
                title, segments, emphasis: sourceEmphasis(element, nodes), output: null }
            paragraphs.push(paragraph)
            this.#wrapSource(paragraph)
        }
        const info = { doc, index, paragraphs, style }
        this.#documents.set(doc, info)
        doc.documentElement.setAttribute('data-foliate-reading-mode', this.mode)
        for (const paragraph of paragraphs) {
            const cached = this.#cache.get(paragraph.cacheKey)
            if (cached) this.#display(paragraph, cached)
        }
        if (location) {
            range.setStart(location.start, location.startOffset)
            range.setEnd(location.end, location.endOffset)
        }
        if (selected?.anchor?.isConnected && selected.focus?.isConnected)
            selection.setBaseAndExtent(selected.anchor, selected.anchorOffset,
                selected.focus, selected.focusOffset)
    }

    #abort() {
        clearTimeout(this.#timer)
        this.#generation++
        // Discard work that has not reached the provider. The next reading
        // action rebuilds its window, while already running work stays reusable.
        for (const job of this.#queue) {
            job.cancelled = true
            job.reject(new Error('翻译已取消'))
            if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key)
        }
        this.#queue = []
        for (const job of this.#jobs.values()) job.background = true
    }

    #schedule(delay = 0) {
        this.#abort()
        this.#timer = setTimeout(() => this.#run(), delay)
    }

    #current() {
        const contents = this.#view.renderer.getContents()
        const range = this.#view.lastLocation?.range
        if (!range) return []
        const doc = range.startContainer.ownerDocument
        const content = contents.find(content => content.doc === doc)
        if (!content) return []
        this.#prepare(doc, content.index)
        return this.#documents.get(doc).paragraphs.filter(({ element, nodes, output }) => {
            // The paginator's relocation range is usually the visible page,
            // but right after a section switch it can be empty or only cover
            // its first paragraph. Fall back to the iframe-to-reader geometry
            // so every paragraph actually on screen is translated.
            if (!this.#visible({ element })
                && !nodes.some(node => node.nodeValue.trim() && range.intersectsNode(node))
                && !(output && range.intersectsNode(output))) return false
            const style = doc.defaultView.getComputedStyle(element)
            return style.display !== 'none' && style.visibility !== 'hidden'
                && element.getClientRects().length > 0
        })
    }
    #visible({ element }) {
        const frame = element.ownerDocument.defaultView?.frameElement
        const host = this.#view
        if (!frame || typeof host.getBoundingClientRect !== 'function') return false
        const frameRect = frame.getBoundingClientRect()
        const clip = host.getBoundingClientRect()
        if (!clip.width || !clip.height) return false
        return Array.from(element.getClientRects()).some(rect => {
            const left = frameRect.left + rect.left
            const top = frameRect.top + rect.top
            return left + rect.width > clip.left && left < clip.right
                && top + rect.height > clip.top && top < clip.bottom
        })
    }

    #anchor() {
        const range = this.#view.lastLocation?.range
        if (!range) return null
        // Keep the original node identity: a live Range's boundary moves when
        // its text node is placed inside a transparent source wrapper.
        return { node: range.startContainer, offset: range.startOffset,
            viewportOffset: this.#view.renderer.captureAnchorOffset?.(range) }
    }

    async #restore(anchor) {
        if (!anchor || this.#destroyed) return
        const generation = this.#generation
        await new Promise(resolve => requestAnimationFrame(resolve))
        if (this.#destroyed || generation !== this.#generation) return
        const resume = this.#resumePosition
        if (resume && this.mode !== 'original') {
            for (const { paragraphs } of this.#documents.values()) {
                const output = paragraphs.find(paragraph => paragraph.key === resume.key)?.output
                const range = output && translatedRange(output, resume.offset)
                if (range) {
                    anchor = { node: range.startContainer, offset: range.startOffset,
                        viewportOffset: resume.viewportOffset }
                    this.#resumePosition = null
                    break
                }
            }
        }
        const node = anchor.node ?? anchor.startContainer ?? anchor
        if (node.ownerDocument && !this.#view.renderer.getContents()
            .some(({ doc }) => doc === node.ownerDocument)) return
        const viewportOffset = anchor.viewportOffset
        if (anchor.node) {
            const range = anchor.node.ownerDocument.createRange()
            range.setStart(anchor.node, Math.min(anchor.offset,
                [3, 4].includes(anchor.node.nodeType) ? anchor.node.length : anchor.node.childNodes.length))
            range.collapse(true)
            anchor = range
        }
        await this.#view.renderer.restoreAnchor(anchor, viewportOffset)
    }

    #wrapSource({ element, nodes }) {
        const doc = element.ownerDocument
        const link = node => node.parentElement.closest('a[href]')
        const note = node => node.parentElement.closest('sup,sub')
        const meaningful = nodes.filter(node => node.nodeValue.trim())
        // Keep inline link text and footnote markers clickable in translation
        // mode, but do not keep a whole entry that is nothing but a link (for
        // example a table-of-contents line), or its English text would remain
        // visible alongside the translation.
        const allLinked = meaningful.length > 0
            && meaningful.every(node => note(node) || link(node))
        for (const node of nodes) {
            if (!node.parentNode || node.parentElement.hasAttribute('data-foliate-source-text')) continue
            const wrapper = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span')
            wrapper.setAttribute('data-foliate-source-text', '')
            if (!/^h[1-6]$/i.test(element.localName))
                wrapper.setAttribute('data-foliate-source-body', '')
            if (note(node) || !allLinked && link(node))
                wrapper.setAttribute('data-foliate-retain', '')
            node.parentNode.insertBefore(wrapper, node)
            wrapper.append(node)
        }
    }

    #display(paragraph, text, state = 'complete') {
        const { element, nodes } = paragraph
        const doc = element.ownerDocument
        if (!paragraph.output) {
            const output = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span')
            output.setAttribute('data-foliate-translation', '')
            output.setAttribute('lang', 'zh-Hans')
            Object.assign(output.style, paragraph.emphasis)
            // Put a parent's own text before its nested list/paragraph children.
            let tail = nodes.at(-1)?.parentElement
            while (tail?.parentElement && tail.parentElement !== element)
                tail = tail.parentElement
            if (tail?.parentElement === element) tail.after(output)
            else element.append(output)
            paragraph.output = output
        }
        paragraph.output.setAttribute('data-foliate-state', state)
        paragraph.output.textContent = text
        if (state === 'complete' && paragraph.segments) {
            const translated = parseTranslatedSegments(text, paragraph.segments)
            paragraph.output.replaceChildren(...translated.map(({ id, text }) => {
                const span = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span')
                span.setAttribute('data-foliate-translation-run', String(id))
                Object.assign(span.style, paragraph.segments[id].emphasis)
                span.textContent = text
                return span
            }))
        } else if (state === 'complete' && paragraph.title) {
            const [title, body] = JSON.parse(text)
            const label = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span')
            label.setAttribute('data-foliate-translation-title', '')
            Object.assign(label.style, paragraph.title.emphasis)
            label.textContent = title
            paragraph.output.replaceChildren(label, doc.createTextNode(body))
        }
        element.toggleAttribute('data-foliate-complete', state === 'complete')
        for (const node of nodes)
            node.parentElement?.toggleAttribute('data-foliate-source-complete', state === 'complete')
        if (state === 'error') {
            const button = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button')
            button.type = 'button'
            button.textContent = '重试'
            button.addEventListener('click', () => this.retry())
            paragraph.output.append(button)
        }
    }

    async #run() {
        if (this.#destroyed || this.mode === 'original') return
        const generation = this.#generation
        await this.#cacheReady
        if (this.#destroyed || this.mode === 'original' || generation !== this.#generation) return
        if (!this.#supported()) {
            this.#status('unsupported', '此书的固定版式暂不支持翻译')
            return
        }
        for (const { doc, index } of this.#view.renderer.getContents()) this.#prepare(doc, index)
        // IndexedDB may finish after #prepare. Apply the loaded document's
        // cached layout before deciding which paragraphs are on this page.
        const cached = Array.from(this.#documents.values()).flatMap(info => info.paragraphs).filter(paragraph =>
            paragraph.output?.getAttribute('data-foliate-state') !== 'complete'
            && this.#cache.has(paragraph.cacheKey))
        if (cached.length || this.#resumePosition) {
            const anchor = this.#anchor()
            for (const paragraph of cached)
                this.#display(paragraph, this.#cache.get(paragraph.cacheKey))
            await this.#restore(anchor)
            if (generation !== this.#generation || this.mode === 'original') return
        }
        const paragraphs = this.#current()
        if (!paragraphs.length) {
            this.#status('empty', '本页没有可翻译文字')
            return
        }
        const pending = paragraphs.filter(paragraph => !this.#cache.has(paragraph.cacheKey))
        if (!pending.length) {
            if (this.#resumePosition) await this.#restore(this.#anchor())
            if (generation !== this.#generation) return
            this.#prefetch(paragraphs)
            this.#status('complete', '当前页翻译完成', paragraphs.length)
            return
        }
        let count = 0
        let failures = 0
        let firstError = ''
        let prefetched = false
        this.#status('translating', '正在翻译当前页…', count)
        // Display settled responses without waiting for a slower earlier
        // paragraph. Keep insertion and anchor restoration sequential.
        const requests = new Set(pending.map(paragraph => {
            const request = this.#request(paragraph, false).then(
                translated => ({ request, paragraph, translated }),
                error => ({ request, paragraph, error, failed: true }))
            return request
        }))
        if (pending.length < paragraphs.length) {
            this.#prefetch(paragraphs)
            prefetched = true
        }
        while (requests.size) {
            const { request, paragraph, translated, error, failed } = await Promise.race(requests)
            requests.delete(request)
            try {
                if (failed) throw error
                if (typeof translated !== 'string' || !translated.trim())
                    throw new Error('翻译服务返回了空译文')
                if (generation !== this.#generation || this.mode === 'original') return
                if (!this.#view.renderer.getContents().some(({ doc }) => doc === paragraph.element.ownerDocument))
                    return
                const anchor = this.#anchor()
                this.#display(paragraph, translated)
                await this.#restore(anchor)
                if (generation !== this.#generation || this.mode === 'original') return
                count++
                this.#status('translating', '正在翻译当前页…', count)
                if (!prefetched) {
                    this.#prefetch(paragraphs)
                    prefetched = true
                }
            } catch (error) {
                if (generation !== this.#generation || this.mode === 'original') return
                const message = (error?.message || '翻译失败，请重试')
                    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
                const anchor = this.#anchor()
                this.#display(paragraph, message, 'error')
                await this.#restore(anchor)
                if (generation !== this.#generation || this.mode === 'original') return
                failures++
                firstError ||= message
            }
        }
        if (generation !== this.#generation) return
        if (failures) this.#status('error',
            failures === 1 ? firstError : `${failures} 个段落翻译失败：${firstError}`, count)
        else this.#status('complete', '当前页翻译完成', count)
    }

    #request(paragraph, background) {
        if (this.#cache.has(paragraph.cacheKey)) return Promise.resolve(this.#cache.get(paragraph.cacheKey))
        const existing = this.#jobs.get(paragraph.cacheKey)
        if (existing) {
            if (!background) existing.background = false
            this.#drain()
            return existing.promise
        }
        const epoch = this.#cacheEpoch
        const job = { id: crypto.randomUUID(), key: paragraph.cacheKey, background, epoch }
        job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }))
        job.run = async () => {
            try {
                const text = await this.#translateParagraph(paragraph, job)
                if (typeof text !== 'string' || !text.trim()) throw new Error('翻译服务返回了空译文')
                if (epoch !== this.#cacheEpoch || this.#destroyed || job.cancelled)
                    throw new Error('翻译已取消')
                this.#cache.set(paragraph.cacheKey, text)
                if (this.#cacheStore)
                    Promise.resolve(this.#cacheStore.save([{ key: paragraph.cacheKey, text }])).catch(() => {})
                job.resolve(text)
            } catch (error) { job.reject(error) }
            finally {
                this.#active--
                if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key)
                this.#drain()
            }
        }
        job.promise.catch(() => {})
        this.#jobs.set(job.key, job)
        this.#queue.push(job)
        this.#drain()
        return job.promise
    }
    async #translateParagraph(paragraph, job) {
        if (paragraph.segments) {
            const segments = paragraph.segments.map(({ id, text }) => ({ id, text }))
            const translated = await this.#translate({ id: job.id, text: paragraph.text, segments })
            return JSON.stringify(parseTranslatedSegments(translated, segments))
        }
        if (paragraph.title) {
            const title = await this.#translate({ id: job.id, text: paragraph.title.text })
            if (typeof title !== 'string' || !title.trim()) throw new Error('翻译服务返回了空译文')
            if (job.cancelled || this.#destroyed || job.epoch !== this.#cacheEpoch)
                throw new Error('翻译已取消')
            const remaining = paragraph.text.slice(paragraph.title.text.length)
            const separator = remaining.match(/^\s*/)[0]
            const text = remaining.slice(separator.length)
            const body = await this.#translateParagraph({ text, title: null,
                lines: paragraph.lines ? text.split('\n') : null }, job)
            if (typeof body !== 'string' || !body.trim()) throw new Error('翻译服务返回了空译文')
            return JSON.stringify([title.replace(/\s+/g, ' ').trim(), separator + body])
        }
        if (!paragraph.lines) return this.#translate({ id: job.id, text: paragraph.text })
        const translated = []
        for (const line of paragraph.lines) {
            if (job.cancelled || this.#destroyed || job.epoch !== this.#cacheEpoch)
                throw new Error('翻译已取消')
            if (!line.trim()) { translated.push(line); continue }
            // Each paragraph occupies one slot even when it needs several lines.
            const text = await this.#translate({ id: job.id, text: line.trim() })
            if (typeof text !== 'string' || !text.trim()) throw new Error('翻译服务返回了空译文')
            const leading = line.match(/^\s*/)[0]
            const trailing = line.match(/\s*$/)[0]
            translated.push(leading + text.replace(/\s+/g, ' ').trim() + trailing)
        }
        return translated.join('\n')
    }
    #drain() {
        if (this.#destroyed || this.mode === 'original') return
        this.#queue.sort((a, b) => Number(a.background) - Number(b.background))
        while (this.#active < maxTranslationRequests && this.#queue.length) {
            // Reserve two slots for newly visible text.
            if (this.#queue[0].background && Array.from(this.#jobs.values())
                .filter(job => job.started && job.background).length >= maxBackgroundRequests) break
            const job = this.#queue.shift()
            this.#active++
            job.started = true
            job.run()
        }
    }
    #prefetchParagraphs(paragraphs) {
        for (const paragraph of paragraphs) this.#request(paragraph, true)
    }
    #prefetch(paragraphs) {
        if (!this.#prefetchEnabled) return
        if (this.#destroyed || this.mode === 'original' || !this.#supported()) return
        const doc = paragraphs[0]?.element.ownerDocument
        const info = doc && this.#documents.get(doc)
        if (!info) return
        const last = paragraphs.at(-1)
        const start = info.paragraphs.indexOf(last) + 1
        if (start <= 0) return
        const count = Math.min(maxPrefetchParagraphs, Math.max(minPrefetchParagraphs, paragraphs.length * 2))
        const next = []
        let characters = 0
        for (const paragraph of info.paragraphs.slice(start)) {
            const { element, text } = paragraph
            const style = element.ownerDocument.defaultView.getComputedStyle(element)
            if (style.display === 'none' || style.visibility === 'hidden' || !element.getClientRects().length) continue
            // Allow one oversized paragraph rather than permanently skipping it.
            if (next.length && characters + text.length > maxPrefetchCharacters) break
            next.push(paragraph)
            characters += text.length
            if (next.length === count) break
        }
        this.#prefetchParagraphs(next)
    }
    #cancelRequests() {
        for (const job of this.#jobs.values()) {
            job.cancelled = true
            if (job.started) Promise.resolve(this.#cancel?.(job.id)).catch(() => {})
            job.reject(new Error('翻译已取消'))
        }
        this.#jobs.clear()
        this.#queue = []
    }
    getDiagnostics() {
        return { mode: this.mode, cacheLoaded: this.#cacheLoaded, cacheEntries: this.#cache.size,
            activeRequests: this.#active, queuedRequests: this.#queue.length, requestsStarted: this.#requestCount,
            activeBackgroundRequests: Array.from(this.#jobs.values()).filter(job => job.started && job.background).length,
            pendingResume: !!this.#resumePosition,
            documents: Array.from(this.#documents.values(), ({ index, paragraphs }) => ({
                index, paragraphs: paragraphs.length,
                completed: paragraphs.filter(paragraph => paragraph.output?.getAttribute('data-foliate-state') === 'complete').length,
            })) }
    }

    getPosition() {
        let range = this.#view.lastLocation?.range
        const element = range?.startContainer.nodeType === 1
            ? range.startContainer : range?.startContainer.parentElement
        let output = element?.closest('[data-foliate-translation]')
        if (!output && range && this.mode !== 'original') {
            for (const { paragraphs } of this.#documents.values()) {
                for (const paragraph of paragraphs) {
                    const candidate = paragraph.output
                    if (!candidate || candidate.getAttribute('data-foliate-state') !== 'complete'
                        || candidate.ownerDocument !== range.startContainer.ownerDocument
                        || !range.intersectsNode(candidate)) continue
                    const caret = visibleTranslatedRange(candidate, this.#view)
                    if (caret) { output = candidate; range = caret; break }
                }
                if (output) break
            }
        }
        if (!output) return this.#resumePosition
        for (const { paragraphs } of this.#documents.values()) {
            const paragraph = paragraphs.find(paragraph => paragraph.output === output)
            if (!paragraph) continue
            const prefix = output.ownerDocument.createRange()
            prefix.selectNodeContents(output)
            prefix.setEnd(range.startContainer, range.startOffset)
            const viewportOffset = this.#view.renderer.captureAnchorOffset?.(range)
            return { key: paragraph.key, offset: prefix.toString().length,
                ...(Number.isFinite(viewportOffset) ? { viewportOffset } : {}) }
        }
        return null
    }
    restorePosition(position) {
        if (position && typeof position.key === 'string'
            && Number.isInteger(position.offset) && position.offset >= 0)
            this.#resumePosition = position
    }
    async setMode(mode) {
        if (!['original', 'bilingual', 'translation'].includes(mode))
            throw new Error('未知阅读模式')
        if (mode === this.mode) return
        const before = this.mode
        let anchor = this.#anchor()
        if (mode === 'original' && anchor?.node) {
            const output = anchor.node.parentElement?.closest('[data-foliate-translation]')
            const paragraph = output && Array.from(this.#documents.values())
                .flatMap(info => info.paragraphs).find(paragraph => paragraph.output === output)
            if (paragraph) anchor = { node: paragraph.nodes[0], offset: 0 }
        }
        if (mode === 'original' || before === 'original') this.#abort()
        if (mode === 'original') this.#cancelRequests()
        this.mode = mode
        for (const { doc } of this.#documents.values())
            doc.documentElement.setAttribute('data-foliate-reading-mode', mode)
        await this.#restore(anchor)
        if (mode === 'original') this.#status('idle', '')
        else if (before === 'original') this.#schedule()
    }

    retry() {
        if (this.mode !== 'original') this.#schedule()
    }

    async clear() {
        const anchor = this.#anchor()
        this.#abort()
        this.#cancelRequests()
        this.#cacheEpoch++
        this.#cache.clear()
        this.#resumePosition = null
        if (this.#cacheStore)
            await Promise.resolve(this.#cacheStore.clear()).catch(() => {})
        for (const { paragraphs } of this.#documents.values())
            for (const paragraph of paragraphs) {
                paragraph.output?.remove()
                paragraph.output = null
                paragraph.element.removeAttribute('data-foliate-complete')
                for (const node of paragraph.nodes)
                    node.parentElement?.removeAttribute('data-foliate-source-complete')
            }
        await this.#restore(anchor)
        this.#status('idle', '')
    }

    destroy() {
        this.#abort()
        this.#cancelRequests()
        this.#destroyed = true
        this.#view.renderer.removeEventListener('load', this.#onLoad)
        this.#view.renderer.removeEventListener('relocate', this.#onRelocate)
        for (const { doc, style, paragraphs } of this.#documents.values()) {
            doc.documentElement.removeAttribute('data-foliate-reading-mode')
            style.remove()
            for (const paragraph of paragraphs) {
                paragraph.output?.remove()
                paragraph.element.removeAttribute('data-foliate-paragraph')
                paragraph.element.removeAttribute('data-foliate-complete')
            }
            for (const wrapper of doc.querySelectorAll('[data-foliate-source-text]'))
                wrapper.replaceWith(...wrapper.childNodes)
        }
        this.#documents.clear()
        this.#cache.clear()
    }
}
