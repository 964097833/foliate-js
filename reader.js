import { makeBook } from './view.js'
import { nativePlugin, nativeSHA1 } from './ui/native-bridge.js'
import { ReaderSync } from './ui/reader-sync.js'
import { createTOCView } from './ui/tree.js'
import { ReaderChrome } from './ui/reader-chrome.js'
import { ReaderNavigation } from './ui/reader-navigation.js'
import { Overlayer } from './overlayer.js'
import { TranslationUI } from './ui/translation.js'
import { bookId, getLastBook, getProgress, getReadingMode, getReadingFlow, getTranslationPosition, saveBook, saveProgress, saveReadingMode } from './ui/reader-storage.js'

const defaultCSS = `
    html { font-family: Georgia, 'Times New Roman', serif; font-size: 28px; }
    h1 {
        font-size: 1.85em;
        font-weight: normal;
        line-height: 1.2;
        text-align: center;
        margin-block: .5em;
    }
`

const getCSS = ({ spacing, justify, hyphenate }) => `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
        color-scheme: light dark;
    }
    /* https://github.com/whatwg/html/issues/5426 */
    @media (prefers-color-scheme: dark) {
        a:link {
            color: lightblue;
        }
    }
    p, li, blockquote, dd {
        line-height: ${spacing};
        text-align: ${justify ? 'justify' : 'start'};
        -webkit-hyphens: ${hyphenate ? 'auto' : 'manual'};
        hyphens: ${hyphenate ? 'auto' : 'manual'};
        -webkit-hyphenate-limit-before: 3;
        -webkit-hyphenate-limit-after: 2;
        -webkit-hyphenate-limit-lines: 2;
        hanging-punctuation: allow-end last;
        widows: 2;
    }
    /* prevent the above from overriding the align attribute */
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }

    pre {
        white-space: pre-wrap !important;
    }
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] {
        display: none;
    }
`

const $ = document.querySelector.bind(document)

const locales = 'en'
const percentFormat = new Intl.NumberFormat(locales, { style: 'percent' })
const listFormat = new Intl.ListFormat(locales, { style: 'short', type: 'conjunction' })

const formatLanguageMap = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    const keys = Object.keys(x)
    return x[keys[0]]
}

const formatOneContributor = contributor => typeof contributor === 'string'
    ? contributor : formatLanguageMap(contributor?.name)

const formatContributor = contributor => Array.isArray(contributor)
    ? listFormat.format(contributor.map(formatOneContributor))
    : formatOneContributor(contributor)

class Reader {
    #tocView
    #bookId
    #progressTimer
    #restoring = false
    #appearanceTask = Promise.resolve()
    #coverURL
    style = {
        spacing: 1.4,
        justify: false,
        hyphenate: false,
    }
    annotations = new Map()
    annotationsByValue = new Map()
    closeSideBar() {
        $('#dimming-overlay').classList.remove('show')
        $('#side-bar').classList.remove('show')
        $('#side-bar').inert = true
        $('#side-bar-button').setAttribute('aria-expanded', 'false')
        $('#side-bar-button').focus()
    }
    constructor() {
        const compact = matchMedia('(max-width: 700px)')
        this.compact = compact
        compact.addEventListener('change', () => {
            if (this.view?.renderer.setStyles)
                this.#updateAppearance()
        })
        $('#side-bar-button').addEventListener('click', () => {
            $('#dimming-overlay').classList.add('show')
            $('#side-bar').classList.add('show')
            $('#side-bar').inert = false
            $('#side-bar-button').setAttribute('aria-expanded', 'true')
            requestAnimationFrame(() => $('#close-contents').focus())
        })
        $('#close-contents').addEventListener('click', () => this.closeSideBar())
        document.addEventListener('keydown', event => {
            if (!$('#side-bar').classList.contains('show')) return
            if (event.key === 'Escape') { event.preventDefault(); this.closeSideBar() }
            if (event.key === 'Tab') {
                const items = [...$('#side-bar').querySelectorAll('button, a[href]')]
                    .filter(item => item.getClientRects().length)
                if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus() }
                else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus() }
            }
        })
        $('#dimming-overlay').addEventListener('click', () => this.closeSideBar())
        $('#left-button').addEventListener('click', () => this.view?.goLeft())
        $('#right-button').addEventListener('click', () => this.view?.goRight())
        document.addEventListener('keydown', this.#handleKeydown.bind(this))
        $('#reading-mode').addEventListener('foliate-mode-change', () => {
            if (this.#bookId && !this.#restoring) saveReadingMode(this.#bookId, $('#reading-mode').value)
        })
        addEventListener('pagehide', () => this.#flushProgress())
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.#flushProgress()
        })

        this.chrome = new ReaderChrome({
            onAppearance: () => this.#updateAppearance(),
            onFlow: value => this.view?.renderer?.setAttribute('flow', value),
            onTools: () => this.#updateAppearance(),
        })
        this.translationUI = new TranslationUI()
        this.navigation = new ReaderNavigation(() => this.#flushProgress())
    }
    async open(file, { id, syncPosition } = {}) {
        await this.chrome.ready
        await this.chrome.showTools()
        this.#flushProgress()
        this.#bookId = id ?? null
        if (syncPosition) {
            saveProgress(this.#bookId, syncPosition.cfi, syncPosition.translation)
            saveReadingMode(this.#bookId, syncPosition.mode)
        }
        const savedMode = getReadingMode(this.#bookId)
        const savedProgress = getProgress(this.#bookId)
        const savedTranslation = getTranslationPosition(this.#bookId)
        this.#restoring = true
        this.translation?.destroy()
        this.view?.close()
        this.view?.remove()
        this.annotations.clear()
        this.annotationsByValue.clear()
        if (this.#coverURL) URL.revokeObjectURL(this.#coverURL)
        this.#coverURL = null
        for (const image of [$('#side-bar-cover'), $('#library-cover')]) image.removeAttribute('src')
        $('#toc-view').replaceChildren()
        $('#tick-marks').replaceChildren()
        this.view = document.createElement('foliate-view')
        document.body.append(this.view)
        await this.view.open(nativePlugin ? await makeBook(file, { sha1: nativeSHA1(nativePlugin) }) : file)
        this.view.addEventListener('load', this.#onLoad.bind(this))
        this.view.addEventListener('relocate', this.#onRelocate.bind(this))

        const { book } = this.view
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            detail.data = Promise.resolve(detail.data).catch(e => {
                console.error(new Error(`Failed to load ${detail.name}`, { cause: e }))
                return ''
            })
        })
        this.view.renderer.setAttribute('flow', getReadingFlow())
        this.view.renderer.setStyles?.([defaultCSS, getCSS(this.style) + this.chrome.styles])
        if (this.view.renderer.setStyles) {
            this.view.renderer.setAttribute('max-column-count', '1')
            this.view.renderer.setAttribute('max-inline-size', '820px')
            this.view.renderer.setAttribute('margin', this.compact.matches ? '144px' : '80px')
        }
        this.translationUI.attach(this.view, { bookId: this.#bookId })
        this.translation = this.translationUI.translation
        this.navigation.attach(this.view, this.translation)
        document.body.classList.remove('is-empty')
        $('#menu-button > button').setAttribute('aria-haspopup', 'menu')
        $('#nav-bar').style.visibility = 'visible'
        $('#appearance-button').disabled = !this.view.renderer.setStyles

        const slider = $('#progress-slider')
        slider.dir = book.dir
        for (const fraction of this.view.getSectionFractions()) {
            const option = document.createElement('option')
            option.value = fraction
            $('#tick-marks').append(option)
        }

        const title = formatLanguageMap(book.metadata?.title) || 'Untitled Book'
        document.title = title
        $('#header-title').textContent = title
        $('#side-bar-title').innerText = title
        $('#library-book-title').textContent = title
        $('#side-bar-author').innerText = formatContributor(book.metadata?.author)
        Promise.resolve(book.getCover?.()).then(blob => {
            if (!blob || this.view.book !== book) return
            this.#coverURL = URL.createObjectURL(blob)
            for (const image of [$('#side-bar-cover'), $('#library-cover')]) image.src = this.#coverURL
        })

        const toc = book.toc
        if (toc) {
            this.#tocView = createTOCView(toc, href => {
                this.navigation.jump(href).catch(e => console.error(e))
                this.closeSideBar()
            })
            $('#toc-view').append(this.#tocView.element)
        }

        try {
            await this.view.init({ lastLocation: savedProgress })
            this.translation.restorePosition(savedTranslation)
            await this.translationUI.restoreMode(savedMode)

        } finally { this.#restoring = false }
        this.#flushProgress()
        saveReadingMode(this.#bookId, $('#reading-mode').value)

        // load and show highlights embedded in the file by Calibre
        const bookmarks = await book.getCalibreBookmarks?.()
        if (bookmarks) {
            const { fromCalibreHighlight } = await import('./epubcfi.js')
            for (const obj of bookmarks) {
                if (obj.type === 'highlight') {
                    const value = fromCalibreHighlight(obj)
                    const color = obj.style.which
                    const note = obj.notes
                    const annotation = { value, color, note }
                    const list = this.annotations.get(obj.spine_index)
                    if (list) list.push(annotation)
                    else this.annotations.set(obj.spine_index, [annotation])
                    this.annotationsByValue.set(value, annotation)
                }
            }
            this.view.addEventListener('create-overlay', e => {
                const { index } = e.detail
                const list = this.annotations.get(index)
                if (list) for (const annotation of list)
                    this.view.addAnnotation(annotation)
            })
            this.view.addEventListener('draw-annotation', e => {
                const { draw, annotation } = e.detail
                const { color } = annotation
                draw(Overlayer.highlight, { color })
            })
            this.view.addEventListener('show-annotation', e => {
                const annotation = this.annotationsByValue.get(e.detail.value)
                if (annotation.note) alert(annotation.note)
            })
        }
    }
    #handleKeydown(event) {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey
            || document.querySelector('dialog[open]')
            || $('#side-bar').classList.contains('show')
            || $('#menu-button .menu').classList.contains('show')
            || event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
        const k = event.key
        if (k === 'ArrowLeft' || k === 'h') this.view?.goLeft()
        else if(k === 'ArrowRight' || k === 'l') this.view?.goRight()
    }
    #onLoad({ detail: { doc } }) {
        this.chrome.prepareDocument(doc)
        doc.addEventListener('keydown', this.#handleKeydown.bind(this))
    }
    #updateAppearance() {
        if (!this.view?.renderer.setStyles) return
        this.#appearanceTask = this.#appearanceTask.then(() => this.translation.preservePosition(() => {
            this.view.renderer.setStyles([defaultCSS, getCSS(this.style) + this.chrome.styles])
            this.view.renderer.setAttribute('margin', this.chrome.toolsVisible
                ? this.compact.matches ? '144px' : '80px' : '36px')
        })).then(() => this.#flushProgress()).catch(error => console.error(error))
        return this.#appearanceTask
    }
    setReadingMode(mode) {
        return this.translationUI.setMode(mode)
    }
    flushProgress() { this.#flushProgress() }
    #flushProgress() {
        clearTimeout(this.#progressTimer)
        const cfi = this.view?.lastLocation?.cfi
        if (this.#bookId && cfi && !this.#restoring)
            saveProgress(this.#bookId, cfi, this.translation?.getPosition())
    }
    #onRelocate({ detail }) {
        const { fraction, location, tocItem, pageItem } = detail
        const percent = percentFormat.format(fraction)
        const loc = pageItem
            ? `Page ${pageItem.label}`
            : `Loc ${location.current}`
        const slider = $('#progress-slider')
        slider.style.visibility = 'visible'
        slider.title = `${percent} · ${loc}`
        $('#reading-progress').textContent = percent
        $('#library-book-progress').textContent = `已读 ${percent}`
        if (tocItem?.href) this.#tocView?.setCurrentHref?.(tocItem.href)
        this.navigation.update(detail)
        if (this.#bookId && detail.cfi && !this.#restoring) {
            clearTimeout(this.#progressTimer)
            // Persist navigation immediately; debounce only continuous scrolling.
            if (!this.view.renderer.scrolled) this.#flushProgress()
            else this.#progressTimer = setTimeout(() => this.#flushProgress(), 100)
        }
    }
}

const reader = new Reader()
globalThis.reader = reader

let openGeneration = 0
const setReaderState = (state, generation = openGeneration) => {
    if (generation !== openGeneration) return
    document.documentElement.dataset.readerState = state
    document.documentElement.dataset.readerGeneration = String(generation)
    document.dispatchEvent(new CustomEvent('reader-state-change', { detail: { state, generation } }))
}
setReaderState('idle')

const open = async (file, { cached = false, id = bookId(file), syncPosition } = {}) => {
    const generation = ++openGeneration
    setReaderState('loading', generation)
    $('#drop-target')?.remove()
    try {
        await reader.open(file, { id, syncPosition })
    } catch (error) {
        reader.view?.close?.()
        reader.view?.remove()
        if (!$('#drop-target')) document.body.append(dropTarget)
        document.body.classList.add('is-empty')
        dropTarget.style.visibility = 'visible'
        setReaderState('failed', generation)
        throw error
    }
    if (id && !cached) {
        try {
            await saveBook(file)
        }
        catch (error) {
            console.warn('无法缓存这本书，刷新后需要重新打开。', error)
        }
    }
    setReaderState('ready', generation)
}

const dragOverHandler = e => e.preventDefault()
const dropHandler = e => {
    e.preventDefault()
    const item = Array.from(e.dataTransfer.items)
        .find(item => item.kind === 'file')
    if (item) {
        const entry = item.webkitGetAsEntry()
        open(entry.isFile ? item.getAsFile() : entry).catch(e => console.error(e))
    }
}
const dropTarget = $('#drop-target')
dropTarget.addEventListener('drop', dropHandler)
dropTarget.addEventListener('dragover', dragOverHandler)

$('#file-input').addEventListener('change', e => {
    const file = e.target.files[0]
    e.target.value = ''
    if (file) open(file).catch(error => console.error(error))
})
$('#file-button').addEventListener('click', () => $('#file-input').click())

const sync = new ReaderSync(open)
globalThis.readerSync = sync
await sync.initialize()
const params = new URLSearchParams(location.search)
const url = params.get('url')
if (url) open(url).catch(e => console.error(e))
else if (['http:', 'https:', 'capacitor:'].includes(location.protocol)) {
    const last = await getLastBook().catch(error => {
        console.warn('无法恢复上次阅读的书籍。', error)
        return null
    })
    if (last && !reader.view) {
        await open(last.file, { cached: true }).catch(error => {
            console.error(error)
            dropTarget.style.visibility = 'visible'
        })
    }
    else if (!reader.view) dropTarget.style.visibility = 'visible'
}
else dropTarget.style.visibility = 'visible'

sync.resume()
void sync.restore()
