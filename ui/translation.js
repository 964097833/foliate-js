import { PageTranslation } from '../translation.js'
import { createHTTPBridge } from './http-bridge.js'
import { clearTranslations, loadTranslations, saveTranslations } from './reader-storage.js'

const $ = selector => document.querySelector(selector)
const errorMessage = error => (error?.message ?? String(error))
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
const canonicalURL = value => {
    try {
        const url = new URL(value.trim())
        url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
        return url.href.replace(/\/+$/, '')
    } catch { return value.trim() }
}

export class TranslationUI {
    #bridge
    #events = new AbortController()
    #unsubscribe
    #settings = {}
    #pendingMode
    #saving = false
    #revision = 0
    #mode = $('#reading-mode')
    #dialog = $('#translation-settings')
    #key = $('#api-key')
    #supported = false
    translation = null
    constructor(view, { bridge = createHTTPBridge() } = {}) {
        this.#bridge = bridge
        if (view) this.attach(view)
        const listen = (selector, event, handler) => $(selector)
            .addEventListener(event, handler, { signal: this.#events.signal })
        listen('#reading-mode', 'change', () => this.setMode(this.#mode.value))
        listen('#translation-settings-button', 'click', () => this.openSettings())
        listen('#translation-status-settings', 'click', () => this.openSettings())
        listen('#close-translation-settings', 'click', () => this.#dialog.close())
        listen('#translation-settings-form', 'submit', event => {
            event.preventDefault()
            this.#save()
        })
        listen('#api-url', 'input', () => this.#updateKeyHint())
        listen('#clear-translation-settings', 'click', () => this.#clear())
        listen('#translation-retry', 'click', () => this.translation?.retry())
        this.#dialog.addEventListener('close', () => {
            // A queued close event may arrive after the dialog was reopened.
            if (this.#dialog.open) return
            this.#pendingMode = undefined
            this.#key.value = ''
            this.#syncMode()
        }, { signal: this.#events.signal })
        this.#dialog.addEventListener('cancel', event => {
            if (this.#saving) event.preventDefault()
        }, { signal: this.#events.signal })
        if (this.#bridge) this.#unsubscribe = this.#bridge.onSettingsChange(settings => {
            if (this.#saving) return
            this.#settings = settings
            this.#settingsChanged()
        })
    }
    attach(view, { bookId } = {}) {
        this.translation?.destroy()
        this.#supported = typeof view.renderer.setStyles === 'function'
        const cacheStore = bookId ? {
            load: () => loadTranslations(bookId),
            save: entries => saveTranslations(bookId, entries),
            clear: () => clearTranslations(bookId),
        } : null
        this.translation = new PageTranslation(view, {
            translate: payload => this.#bridge.translate(payload),
            cancel: id => this.#bridge?.cancel(id),
            onStatus: status => this.#showStatus(status),
            cacheStore,
        })
        this.#showStatus({ state: 'idle' })
        this.#syncMode()
    }
    #syncMode() {
        this.#mode.value = this.translation?.mode ?? 'original'
        this.#mode.dispatchEvent?.(new Event('foliate-mode-change'))
    }
    #showStatus({ state, message = '' }) {
        const bar = $('#translation-status-bar')
        bar.hidden = !message
        bar.dataset.state = state
        $('#translation-status').textContent = message
        $('#translation-retry').hidden = !['error', 'failed'].includes(state)
        $('#translation-status-settings').hidden = !['error', 'failed'].includes(state)
    }
    #showError(error) {
        this.#showStatus({ state: 'error', message: errorMessage(error) })
    }
    async setMode(mode) {
        if (!this.translation) return
        const revision = ++this.#revision
        if (mode === 'original') this.#pendingMode = undefined
        try {
            if (mode !== 'original') {
                if (!this.#supported) {
                    this.#syncMode()
                    this.#showStatus({ state: 'unsupported', message: '翻译支持流式 EPUB、MOBI/AZW3 和 FB2；暂不支持固定版式及 PDF。' })
                    return
                }
                if (!this.#bridge) {
                    this.#syncMode()
                    this.#showStatus({ state: 'unavailable', message: '请通过本地服务（npm start）打开阅读器后使用翻译。' })
                    return
                }
                this.#settings = await this.#bridge.getSettings()
                if (revision !== this.#revision) return
                if (!this.#settings.hasKey || !this.#settings.url || !this.#settings.model) {
                    this.#pendingMode = mode
                    this.#syncMode()
                    await this.openSettings(revision)
                    return
                }
            }
            await this.translation.setMode(mode)
            this.#syncMode()
        } catch (error) {
            if (revision !== this.#revision) return
            this.#syncMode()
            this.#showError(error)
        }
    }
    async restoreMode(mode) {
        if (!this.translation || !this.#bridge || !this.#supported) return
        if (!['bilingual', 'translation'].includes(mode)) return
        const revision = this.#revision
        try {
            const settings = await this.#bridge.getSettings()
            if (revision !== this.#revision) return
            if (!settings.hasKey || !settings.url || !settings.model) return
            await this.translation.setMode(mode)
            if (revision !== this.#revision) return
            this.#syncMode()
        } catch { /* Keep the original mode when settings are unavailable. */ }
    }
    async openSettings(revision = this.#revision) {
        $('#menu-button .menu')?.classList.remove('show')
        if (!this.#bridge) {
            this.#showStatus({ state: 'unavailable', message: '请通过本地服务（npm start）打开阅读器后配置翻译。' })
            return
        }
        try {
            const settings = await this.#bridge.getSettings()
            if (revision !== this.#revision) return
            this.#settings = settings
            $('#api-url').value = this.#settings.url ?? ''
            $('#api-model').value = this.#settings.model ?? ''
            this.#key.value = ''
            this.#updateKeyHint()
            $('#translation-settings-error').hidden = true
            $('#save-translation-settings').textContent = this.#pendingMode ? '保存并开始翻译' : '保存设置'
            $('#clear-translation-settings').disabled = !this.#settings.hasKey && !this.#settings.url
            if (!this.#dialog.open) this.#dialog.showModal()
        } catch (error) {
            if (revision === this.#revision) this.#showError(error)
        }
    }
    #updateKeyHint() {
        const sameURL = canonicalURL($('#api-url').value) === canonicalURL(this.#settings.url ?? '')
        const keepKey = this.#settings.hasKey && sameURL
        this.#key.required = !keepKey
        this.#key.placeholder = keepKey ? '已保存；留空保留现有 API Key' : '填写 API Key'
        $('#api-key-hint').textContent = this.#settings.hasKey && !sameURL
            ? '服务地址已更改，请填写该服务的 API Key。'
            : 'API Key 使用系统加密，保存在本机，所有阅读标签页共用。'
    }
    #setBusy(busy) {
        this.#saving = busy
        for (const id of ['#save-translation-settings', '#close-translation-settings'])
            $(id).disabled = busy
        $('#clear-translation-settings').disabled = busy || !this.#settings.hasKey && !this.#settings.url
    }
    #settingsError(error) {
        const element = $('#translation-settings-error')
        element.hidden = false
        element.textContent = errorMessage(error)
    }
    async #save() {
        this.#setBusy(true)
        const previousSettings = this.#settings
        const enteredKey = this.#key.value.trim()
        try {
            this.#settings = await this.#bridge.saveSettings({
                url: $('#api-url').value.trim(),
                model: $('#api-model').value.trim(),
                apiKey: this.#key.value,
            })
            const previousMode = this.translation?.mode ?? 'original'
            const requestedMode = this.#pendingMode ?? previousMode
            const configChanged = !previousSettings.hasKey
                || previousSettings.url !== this.#settings.url
                || previousSettings.model !== this.#settings.model
                || !!enteredKey
            if (configChanged) await this.translation?.clear()
            // Another book window may have changed or cleared the configuration
            // while the current document was restoring its reading position.
            this.#settings = await this.#bridge.getSettings()
            const mode = this.#settings.hasKey ? requestedMode : 'original'
            this.#dialog.close()
            this.#setBusy(false)
            await this.translation?.setMode(mode)
            this.#syncMode()
            if (mode !== 'original' && previousMode !== 'original') this.translation?.retry()
        } catch (error) {
            if (this.#dialog.open) this.#settingsError(error)
            else this.#showError(error)
        }
        finally { this.#setBusy(false) }
    }
    async #clear() {
        this.#setBusy(true)
        try {
            this.#settings = await this.#bridge.clearSettings()
            await this.translation?.clear()
            await this.translation?.setMode('original')
            this.#syncMode()
            this.#pendingMode = undefined
            $('#api-url').value = ''
            $('#api-model').value = ''
            this.#key.value = ''
            this.#updateKeyHint()
            $('#translation-settings-error').hidden = true
            $('#clear-translation-settings').disabled = true
            $('#save-translation-settings').textContent = '保存设置'
        } catch (error) { this.#settingsError(error) }
        finally { this.#setBusy(false) }
    }
    async #settingsChanged() {
        if (!this.translation) return
        try {
            await this.translation.clear()
            if (!this.#settings.hasKey) {
                await this.translation.setMode('original')
                this.#syncMode()
            } else if (this.translation.mode !== 'original') await this.translation.retry()
        } catch (error) { this.#showError(error) }
    }
    destroy() {
        this.#revision++
        this.#events.abort()
        this.#unsubscribe?.()
        this.translation?.destroy()
        this.#key.value = ''
    }
}
