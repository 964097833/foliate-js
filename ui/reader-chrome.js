import { getReadingFlow, saveReadingFlow } from './reader-storage.js'
import { nativePlugin } from './native-bridge.js'

const $ = selector => document.querySelector(selector)
const themes = {
    light: { paper: '#ffffff', ink: '#272622', scheme: 'light' },
    paper: { paper: '#faf8f3', ink: '#272622', scheme: 'light' },
    dark: { paper: '#202124', ink: '#e9e5dd', scheme: 'dark' },
}

export class ReaderChrome {
    #onAppearance
    #onFlow
    #appearance = { theme: 'paper', fontSize: 24 }
    #menu = $('#menu-button .menu')
    #menuButton = $('#menu-button > button')
    #compact = matchMedia('(max-width: 700px)')
    #font
    #onTools
    #tapTimer
    toolsVisible = true
    ready
    constructor({ onAppearance, onFlow, onTools }) {
        this.#onAppearance = onAppearance
        this.#onFlow = onFlow
        this.#onTools = onTools
        this.ready = this.#loadFont()
        try {
            const saved = JSON.parse(localStorage.getItem('foliate:appearance'))
            if (Object.hasOwn(themes, saved?.theme)) this.#appearance.theme = saved.theme
            if (Number.isInteger(saved?.fontSize) && saved.fontSize >= 18 && saved.fontSize <= 36)
                this.#appearance.fontSize = saved.fontSize
        } catch { /* Use the reading defaults when storage is unavailable. */ }
        this.#render()
        $('#immersive-progress').addEventListener('click', () => this.showTools())
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.showTools()
        })
        this.#menuButton.addEventListener('click', () => {
            if (document.body.classList.contains('is-empty')) return $('#translation-settings-button').click()
            const open = !this.#menu.classList.contains('show')
            this.#menu.classList.toggle('show', open)
            this.#menu.inert = !open
            this.#menuButton.setAttribute('aria-expanded', String(open))
            if (open) this.#menu.querySelector('button').focus()
        })
        this.#menu.addEventListener('click', () => this.closeMenu())
        document.addEventListener('click', event => {
            if (!$('#menu-button').contains(event.target)) this.closeMenu()
        })
        this.#menu.addEventListener('keydown', event => {
            const items = [...this.#menu.querySelectorAll('button')]
            const index = items.indexOf(document.activeElement)
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus()
            }
            if (event.key === 'Escape') {
                this.closeMenu()
                this.#menuButton.focus()
            }
        })
        const placeDock = () => {
            const dialog = $('#appearance-settings')
            const container = dialog.open && this.#compact.matches ? dialog : $('#reader-bottom')
            if ($('#reader-dock').parentElement !== container) container.append($('#reader-dock'))
        }
        this.#compact.addEventListener('change', placeDock)
        $('#appearance-button').addEventListener('click', () => {
            const dialog = $('#appearance-settings')
            if (dialog.open) dialog.close()
            else dialog.showModal()
            placeDock()
        })
        $('#appearance-settings').addEventListener('close', placeDock)
        // The phone dock is inside the modal sheet. Dismiss it before opening
        // another panel so the target does not remain inert behind the modal.
        for (const button of document.querySelectorAll('#side-bar-button, [data-reading-mode], #dock-sync, #dock-open, #translation-settings-button'))
            button.addEventListener('click', () => {
                if ($('#appearance-settings').open) $('#appearance-settings').close()
            }, { capture: true })
        $('#close-appearance').addEventListener('click', () => $('#appearance-settings').close())
        $('#appearance-settings').addEventListener('click', event => {
            if (event.target !== event.currentTarget) return
            const box = event.currentTarget.getBoundingClientRect()
            if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)
                event.currentTarget.close()
        })
        $('#font-smaller').addEventListener('click', () => this.#change({ fontSize: this.#appearance.fontSize - 1 }))
        $('#font-larger').addEventListener('click', () => this.#change({ fontSize: this.#appearance.fontSize + 1 }))
        for (const button of document.querySelectorAll('[data-theme]'))
            button.addEventListener('click', () => this.#change({ theme: button.dataset.theme }))
        for (const button of document.querySelectorAll('[data-flow]'))
            button.addEventListener('click', () => {
                saveReadingFlow(button.dataset.flow)
                this.#onFlow(button.dataset.flow)
                this.#render()
            })
        for (const button of document.querySelectorAll('[data-reading-mode]'))
            button.addEventListener('click', () => {
                $('#reading-mode').value = button.dataset.readingMode
                $('#reading-mode').dispatchEvent(new Event('change'))
            })
        $('#reading-mode').addEventListener('foliate-mode-change', () => this.#render())
        for (const button of ['#dock-sync', '#empty-sync', '#library-sync'])
            $(button).addEventListener('click', () => {
                $('#library-dialog').close()
                $('#sync-button').click()
                if (button === '#library-sync') $('#sync-library').open = true
            })
        for (const button of ['#dock-open', '#library-import'])
            $(button).addEventListener('click', () => {
                $('#library-dialog').close()
                $('#file-input').click()
            })
        $('#library-button').addEventListener('click', () => $('#library-dialog').showModal())
        for (const button of ['#library-current', '#close-library'])
            $(button).addEventListener('click', () => $('#library-dialog').close())
    }
    closeMenu() {
        this.#menu.classList.remove('show')
        this.#menu.inert = true
        this.#menuButton.setAttribute('aria-expanded', 'false')
    }
    showTools() {
        clearTimeout(this.#tapTimer)
        return this.setToolsVisible(true)
    }
    setToolsVisible(visible) {
        if (visible === this.toolsVisible || !visible && (document.querySelector('dialog[open]')
            || $('#side-bar').classList.contains('show'))) return
        this.toolsVisible = visible
        this.closeMenu()
        document.body.classList.toggle('chrome-hidden', !visible)
        for (const selector of ['#header-bar', '#reader-bottom']) $(selector).inert = !visible
        $('#immersive-progress').hidden = visible
        if (!visible && document.activeElement?.closest('#header-bar, #reader-bottom'))
            document.activeElement.blur()
        return this.#onTools?.()
    }
    async #loadFont() {
        if (!nativePlugin) return
        const response = await fetch(new URL('./fonts/noto-serif-sc.woff2', import.meta.url))
        if (!response.ok) throw new Error('无法加载本地阅读字体。')
        this.#font = await new FontFace('Foliate Serif', await response.arrayBuffer(), { weight: '200 900' }).load()
    }
    prepareDocument(doc) {
        if (this.#font) doc.fonts.add(this.#font)
        let pointer
        doc.addEventListener('pointerdown', event => {
            clearTimeout(this.#tapTimer)
            pointer = { x: event.screenX, y: event.screenY, time: performance.now() }
        })
        doc.addEventListener('pointercancel', () => { pointer = null })
        doc.addEventListener('selectionchange', () => {
            if (!doc.getSelection()?.isCollapsed) clearTimeout(this.#tapTimer)
        })
        doc.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.showTools()
        })
        doc.addEventListener('click', event => {
            clearTimeout(this.#tapTimer)
            if (event.defaultPrevented || event.detail !== 1 || event.ctrlKey || event.metaKey || event.altKey
                || !pointer || performance.now() - pointer.time > 400
                || Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) > 10
                || !doc.getSelection()?.isCollapsed
                || event.target.closest('a, button, input, select, textarea, [contenteditable="true"]')) return
            const x = event.clientX + (doc.defaultView.frameElement?.getBoundingClientRect().left ?? 0)
            if (x < innerWidth * .25 || x > innerWidth * .75) return
            this.#tapTimer = setTimeout(() => {
                if (doc.defaultView && doc.getSelection()?.isCollapsed)
                    this.setToolsVisible(!this.toolsVisible)
            }, 250)
        })
        // Preserve boxed book content in night mode without leaving a pale
        // background behind light text. Attributes do not change CFI nodes.
        for (const element of doc.querySelectorAll('body *')) {
            if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue
            const values = doc.defaultView.getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number)
            if (values?.length >= 3 && (values[3] ?? 1) > .8
                && values.slice(0, 3).every(value => value > 180))
                element.setAttribute('data-foliate-reader-surface', '')
        }
    }
    #change(patch) {
        const next = { ...this.#appearance, ...patch }
        if (next.fontSize < 18 || next.fontSize > 36) return
        this.#appearance = next
        try { localStorage.setItem('foliate:appearance', JSON.stringify(next)) } catch { /* Keep settings for this session. */ }
        this.#render()
        this.#onAppearance()
    }
    #render() {
        document.documentElement.dataset.readerTheme = this.#appearance.theme
        nativePlugin?.setAppearance({ theme: this.#appearance.theme }).catch(error => console.error(error))
        $('#font-size-value').textContent = this.#appearance.fontSize
        $('#font-smaller').disabled = this.#appearance.fontSize <= 18
        $('#font-larger').disabled = this.#appearance.fontSize >= 36
        for (const button of document.querySelectorAll('[data-theme]'))
            button.setAttribute('aria-pressed', String(button.dataset.theme === this.#appearance.theme))
        for (const button of document.querySelectorAll('[data-flow]'))
            button.setAttribute('aria-pressed', String(button.dataset.flow === getReadingFlow()))
        for (const button of document.querySelectorAll('[data-reading-mode]'))
            button.setAttribute('aria-pressed', String(button.dataset.readingMode === $('#reading-mode').value))
    }
    get styles() {
        const { paper, ink, scheme } = themes[this.#appearance.theme]
        return `html { color-scheme: ${scheme} !important; background: ${paper} !important;
            color: ${ink}; font-size: ${this.#appearance.fontSize * 28 / 24}px !important; --foliate-font-size: ${this.#appearance.fontSize}px; }
            body { background: transparent !important; }
            html:not([data-foliate-reading-mode="original"]) [data-foliate-translation] { color: inherit; }
            ${this.#appearance.theme === 'dark' ? `
                [data-foliate-reader-surface] { background-color: #303136 !important; color: ${ink} !important; }
                [data-foliate-reader-surface] :not(a) { color: inherit !important; }
            ` : ''}`
    }
}
