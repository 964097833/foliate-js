const paragraphSelector = 'p,h1,h2,h3,h4,h5,h6,li,dt,dd,figcaption,blockquote,pre,td,th,div'
const ignoredSelector = 'script,style,noscript,template,svg,math,[hidden],[data-foliate-translation]'
const readingReasons = new Set(['page', 'scroll', 'navigation', 'snap'])
const prefetchParagraphCount = 3

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
        font: normal 24px/1.55 'Songti SC', 'Noto Serif CJK SC', serif;
        text-align: start;
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
        this.#translate = translate
        this.#cancel = cancel
        this.#onStatus = onStatus
        this.#cacheStore = cacheStore
        this.#prefetchEnabled = prefetch
        if (cacheStore) {
            const epoch = this.#cacheEpoch
            this.#cacheReady = Promise.resolve()
                .then(() => cacheStore.load())
                .then(entries => {
                    if (epoch !== this.#cacheEpoch || !entries) return
                    for (const entry of entries) this.#cache.set(entry.key, entry.text)
                })
                .catch(() => {})
        }
        this.#onLoad = ({ detail: { doc, index } }) => {
            this.#abort()
            this.#prepare(doc, index)
        }
        this.#onRelocate = ({ detail }) => {
            if (this.mode !== 'original' && readingReasons.has(detail.reason)) {
                this.#resumePosition = null
                this.#schedule()
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
            const text = nodes.map(node => node.nodeValue).join('').replace(/\s+/g, ' ').trim()
            if (!text) continue
            const ordinal = paragraphs.length
            element.setAttribute('data-foliate-paragraph', `${index}-${ordinal}`)
            const paragraph = { element, nodes, text, key: `${index}:${ordinal}:${text}`, output: null }
            paragraphs.push(paragraph)
            this.#wrapSource(paragraph)
        }
        const info = { doc, index, paragraphs, style }
        this.#documents.set(doc, info)
        doc.documentElement.setAttribute('data-foliate-reading-mode', this.mode)
        for (const paragraph of paragraphs) {
            const cached = this.#cache.get(paragraph.key)
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
        for (const job of this.#queue) job.background = true
    }

    #schedule() {
        this.#abort()
        this.#timer = setTimeout(() => this.#run(), 160)
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
                if (output?.firstChild?.nodeType === 3) {
                    anchor = { node: output.firstChild, offset: resume.offset,
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
        const paragraphs = this.#current()
        if (!paragraphs.length) {
            this.#status('empty', '本页没有可翻译文字')
            return
        }
        const cached = paragraphs.filter(paragraph =>
            paragraph.output?.getAttribute('data-foliate-state') !== 'complete'
            && this.#cache.has(paragraph.key))
        if (cached.length) {
            const anchor = this.#anchor()
            for (const paragraph of cached)
                this.#display(paragraph, this.#cache.get(paragraph.key))
            await this.#restore(anchor)
            if (generation !== this.#generation || this.mode === 'original') return
        }
        const pending = paragraphs.filter(paragraph => !this.#cache.has(paragraph.key))
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
        this.#status('translating', '正在翻译当前页…', count)
        // Cache each response as it arrives, independently of display order.
        const requests = pending.map(paragraph => ({
            paragraph, promise: this.#request(paragraph, false),
        }))
        for (const { paragraph, promise } of requests) {
            try {
                const translated = await promise
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
        if (!failures) this.#prefetch(paragraphs)
        if (failures) this.#status('error',
            failures === 1 ? firstError : `${failures} 个段落翻译失败：${firstError}`, count)
        else this.#status('complete', '当前页翻译完成', count)
    }

    #request(paragraph, background) {
        if (this.#cache.has(paragraph.key)) return Promise.resolve(this.#cache.get(paragraph.key))
        const existing = this.#jobs.get(paragraph.key)
        if (existing) {
            if (!background) existing.background = false
            this.#drain()
            return existing.promise
        }
        const epoch = this.#cacheEpoch
        const job = { id: crypto.randomUUID(), key: paragraph.key, background, epoch }
        job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }))
        job.run = async () => {
            try {
                const text = await this.#translate({ id: job.id, text: paragraph.text })
                if (typeof text !== 'string' || !text.trim()) throw new Error('翻译服务返回了空译文')
                if (epoch !== this.#cacheEpoch || this.#destroyed || job.cancelled)
                    throw new Error('翻译已取消')
                this.#cache.set(paragraph.key, text)
                if (this.#cacheStore)
                    Promise.resolve(this.#cacheStore.save([{ key: paragraph.key, text }])).catch(() => {})
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
    #drain() {
        if (this.#destroyed || this.mode === 'original') return
        this.#queue.sort((a, b) => Number(a.background) - Number(b.background))
        while (this.#active < 4 && this.#queue.length) {
            // At most one speculative request: leave room for the next page.
            if (this.#queue[0].background && this.#active >= 1) break
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
        const next = info.paragraphs.slice(start, start + prefetchParagraphCount)
            .filter(({ element }) => {
                const style = element.ownerDocument.defaultView.getComputedStyle(element)
                return style.display !== 'none' && style.visibility !== 'hidden'
                    && element.getClientRects().length > 0
            })
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
    getPosition() {
        const range = this.#view.lastLocation?.range
        const element = range?.startContainer.nodeType === 1
            ? range.startContainer : range?.startContainer.parentElement
        const output = element?.closest('[data-foliate-translation]')
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
