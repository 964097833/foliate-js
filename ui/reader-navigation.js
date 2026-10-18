const $ = selector => document.querySelector(selector)
const percent = value => `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
const flatten = items => items.flatMap(item => [item, ...flatten(item.subitems ?? [])])

// UI navigation keeps its return point separate from the durable reading bookmark.
export class ReaderNavigation {
    #view
    #translation
    #flush
    #entries = []
    #returnPoint
    #returnTimer
    #previewing = false
    #jumping = false
    constructor(flush) {
        this.#flush = flush
        $('#progress-slider').addEventListener('input', () => this.#preview())
        $('#progress-slider').addEventListener('change', () => {
            const fraction = Number($('#progress-slider').value)
            this.#cancelPreview()
            this.jump({ fraction }).catch(error => console.error(error))
        })
        for (const event of ['pointercancel', 'blur'])
            $('#progress-slider').addEventListener(event, () => this.#cancelPreview())
        $('#progress-slider').addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); this.#cancelPreview() }
        })
        $('#return-position').addEventListener('click', () => this.#return().catch(error => console.error(error)))
        $('#return-position').addEventListener('focus', () => clearTimeout(this.#returnTimer))
        $('#return-position').addEventListener('blur', () => this.#expireReturn())
    }
    attach(view, translation) {
        this.#view = view
        this.#translation = translation
        this.#returnPoint = null
        this.#entries = []
        this.#previewing = false
        clearTimeout(this.#returnTimer)
        $('#return-position').hidden = true
        $('#progress-preview').hidden = true
        // Resolve chapter names without loading or translating chapter documents.
        Promise.all(flatten(view.book.toc ?? []).filter(item => item.href).map(async item => {
            const resolved = await view.resolveNavigation(item.href)
            return { ...item, index: resolved?.index }
        })).then(entries => {
            if (this.#view === view) this.#entries = entries.filter(item => Number.isInteger(item.index))
        }).catch(error => console.error(error))
    }
    update(detail) {
        const { fraction, section, tocItem } = detail
        if (!Number.isFinite(fraction)) return
        const label = tocItem?.label || `第 ${(section?.current ?? 0) + 1} 节`
        $('#chapter-title').textContent = label
        $('#immersive-progress').textContent = `${label} · ${percent(fraction)}`
        const renderer = this.#view.renderer
        const remaining = renderer.pages - 2 - renderer.page
        const start = this.#entries.findIndex(item => item.href === tocItem?.href)
        const next = this.#entries[start + 1]?.index ?? this.#view.book.sections.length
        const wholeChapter = start >= 0 && this.#entries[start].index === section?.current
            && next === section.current + 1
        $('#chapter-progress').textContent = renderer.scrolled ? '连续滚动'
            : Number.isFinite(remaining) ? `${wholeChapter ? '本章' : '本节'}还剩 ${Math.max(0, remaining)} 页` : ''
        if (!this.#previewing) $('#progress-slider').value = fraction
    }
    #preview() {
        if (!this.#view) return
        this.#previewing = true
        const fraction = Number($('#progress-slider').value)
        const fractions = this.#view.getSectionFractions()
        let index = fractions.findIndex(value => value > fraction) - 1
        if (index < 0) index = fraction >= 1 ? this.#view.book.sections.length - 1 : 0
        const label = this.#entries.findLast(item => item.index <= index)?.label || `第 ${index + 1} 节`
        $('#progress-preview').textContent = `${label} · ${percent(fraction)}，松开跳转`
        $('#progress-preview').hidden = false
        $('#progress-slider').setAttribute('aria-valuetext', `${label}，${percent(fraction)}`)
    }
    #cancelPreview() {
        this.#previewing = false
        $('#progress-preview').hidden = true
        $('#progress-slider').removeAttribute('aria-valuetext')
        const fraction = this.#view?.lastLocation?.fraction
        if (Number.isFinite(fraction)) $('#progress-slider').value = fraction
    }
    async jump(target) {
        if (!this.#view?.lastLocation || this.#jumping) return
        this.#jumping = true
        const view = this.#view
        const range = view.renderer.getVisibleRange?.()
        const content = view.renderer.getContents().find(item => item.doc === range?.startContainer.ownerDocument)
        const cfi = content ? view.getCFI(content.index, range) : view.lastLocation.cfi
        const saved = { cfi, translation: this.#translation.getPosition() }
        try {
            await view.goTo(target)
            if (this.#view !== view) return
            this.#returnPoint = saved
            $('#return-position').hidden = false
            this.#expireReturn()
            this.#flush()
        } finally { this.#jumping = false }
    }
    #expireReturn() {
        clearTimeout(this.#returnTimer)
        this.#returnTimer = setTimeout(() => { $('#return-position').hidden = true }, 30000)
    }
    async #return() {
        if (!this.#returnPoint || this.#jumping) return
        const saved = this.#returnPoint
        this.#returnPoint = null
        clearTimeout(this.#returnTimer)
        $('#return-position').hidden = true
        this.#translation.restorePosition(saved.translation)
        await this.#view.goTo(saved.cfi)
        this.#translation.retry()
        this.#flush()
    }
}
