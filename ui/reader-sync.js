import { createSyncBridge } from './native-bridge.js'
import { getLastBook, getProgress, getTranslationPosition, getReadingMode,
    loadTranslations, saveTranslations, clearTranslations, getTranslationSyncState, acknowledgeTranslationSync } from './reader-storage.js'
import { SyncRepository, SyncConflict, mergeClocks, selectCurrent, portablePosition, mergeTranslationCaches } from './sync-protocol.js'

const $ = selector => document.querySelector(selector)
const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('')

export class ReaderSync {
    #bridge = createSyncBridge()
    #repository
    #key
    #meta
    #device
    #open
    #busy = false
    #applying = true
    #timer
    #again = false
    #conflict
    #manifest
    #storageRevision = 0
    constructor(open) {
        this.#open = open
        this.#device = id()
        try {
            this.#device = localStorage.getItem('foliate:sync-device') ?? this.#device
            localStorage.setItem('foliate:sync-device', this.#device)
        } catch { this.#bridge = null }
        $('#sync-button').addEventListener('click', () => this.showSettings())
        $('#sync-close').addEventListener('click', () => $('#sync-settings').close())
        $('#sync-form').addEventListener('submit', event => {
            event.preventDefault()
            this.#saveSettings().catch(error => this.#error(error))
        })
        $('#sync-now').addEventListener('click', () => this.sync())
        $('#sync-disconnect').addEventListener('click', async () => {
            if (this.#busy) return
            try {
                await this.#bridge.clearSettings()
                this.#repository = null
                clearTimeout(this.#timer)
                this.#status('已断开同步；本地书籍和译文已保留。')
            } catch (error) { this.#error(error) }
        })
        $('#sync-use-local').addEventListener('click', () => this.#resolveConflict('local'))
        $('#sync-use-remote').addEventListener('click', () => this.#resolveConflict('remote'))
        $('#sync-open-book').addEventListener('click', () => this.#openSelected())
        globalThis.addEventListener('foliate-storage-change', ({ detail }) => {
            if (this.#applying || !this.#repository) return
            this.#storageRevision++
            if (!['translations', 'translations-reset'].includes(detail.kind)) {
                try { this.#changed(detail.id) }
                catch { this.#error(new Error('无法保存同步状态，请检查本机存储空间。')) }
            }
            clearTimeout(this.#timer)
            this.#timer = setTimeout(() => this.sync(), 15000)
        })
        // iOS can suspend immediately. The durable dirty marker survives even if
        // this opportunistic flush cannot finish; never report it as completed.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.sync()
            else if (this.#repository) this.sync()
        })
        setInterval(() => {
            if (document.visibilityState === 'visible' && this.#repository) this.sync()
        }, 60000)
    }
    #status(message) {
        $('#sync-status').textContent = message
        $('#sync-button').title = message
        $('#sync-button').setAttribute('aria-label', `书籍与进度同步：${message}`)
        $('#sync-button').dataset.state = 'idle'
    }
    #error(error) {
        this.#status(error.message ?? '同步失败，请检查网络后重试。')
        $('#sync-button').dataset.state = 'error'
        if (error instanceof SyncConflict) {
            this.#conflict = error
            $('#sync-conflict').hidden = false
            const describe = current => {
                const name = this.#manifest?.books[current?.bookId]?.name ?? '当前书籍'
                const percent = Number.isFinite(current?.fraction) ? ` · ${Math.round(current.fraction * 100)}%` : ''
                return `${current?.device ?? '设备'} · ${name}${percent}`
            }
            $('#sync-conflict-description').textContent = `本机：${describe(error.local)}；远端：${describe(error.remote)}。两份位置均保留，请选择继续位置。`
            $('#sync-settings').showModal()
        }
    }
    #persist() { localStorage.setItem(this.#key, JSON.stringify(this.#meta)) }
    async #configure(settings) {
        if (!settings?.hasToken) { this.#repository = null; return }
        this.#key = `foliate:sync:${settings.repository}:${settings.branch}`
        try { this.#meta = JSON.parse(localStorage.getItem(this.#key) ?? 'null') } catch { this.#meta = null }
        this.#meta ??= { current: null, dirty: false }
        this.#repository = new SyncRepository(input => this.#bridge.request(input))
    }
    #changed(book) {
        if (!book || !this.#meta) return
        const cfi = getProgress(book)
        if (!cfi) return
        const clock = { ...this.#meta.current?.clock }
        clock[this.#device] = (clock[this.#device] ?? 0) + 1
        this.#meta.current = { bookId: book, cfi, translation: portablePosition(getTranslationPosition(book)),
            mode: getReadingMode(book) ?? 'original', clock,
            fraction: globalThis.reader?.view?.lastLocation?.fraction,
            device: /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone / iPad' : 'Mac / 浏览器' }
        this.#meta.dirty = true
        this.#persist()
    }
    async initialize() {
        try {
            if (this.#bridge) await this.#configure(await this.#bridge.getSettings())
        } catch (error) { this.#error(error) }
    }
    async restore() {
        if (this.#repository) await this.sync()
    }
    resume() { this.#applying = false }
    async showSettings() {
        if (this.#bridge) {
            try {
                const settings = await this.#bridge.getSettings()
                $('#sync-repository').value = settings.repository
                $('#sync-branch').value = settings.branch
                $('#sync-token').placeholder = settings.hasToken ? '已保存；留空保留' : '仅所选私有仓库的 Contents 读写权限'
            } catch (error) { this.#error(error) }
        }
        if (!this.#bridge) this.#status('此环境不支持安全同步，请使用本机网页或 iPhone App。')
        $('#sync-settings').showModal()
    }
    async #saveSettings() {
        if (this.#busy || !this.#bridge) return
        const settings = await this.#bridge.saveSettings({ repository: $('#sync-repository').value,
            branch: $('#sync-branch').value, token: $('#sync-token').value })
        $('#sync-token').value = ''
        await this.#configure(settings)
        await this.sync()
    }
    async #apply(current, manifest) {
        const book = manifest.books[current.bookId]
        const entries = await this.#repository.readTranslations(book)
        const last = await getLastBook()
        const file = last?.id === current.bookId ? last.file : await this.#repository.downloadBook(book,
            ({ completed, total }) => this.#status(`正在下载书籍：已完成 ${completed}/${total} 块。`))
        // Downloads may take seconds; preserve reading that happened meanwhile.
        if (this.#meta.dirty) throw new SyncConflict(this.#meta.current, current)
        this.#applying = true
        try {
            const state = getTranslationSyncState(current.bookId)
            const generation = book.cacheGeneration ?? 'original'
            if (state.generation !== generation) await clearTranslations(current.bookId, { silent: true })
            acknowledgeTranslationSync(current.bookId, generation, state)
            await saveTranslations(current.bookId, [...entries.values()], { silent: true })
            // Reader.open flushes the old view before loading the new position.
            // Pass an explicit position so that flush cannot overwrite the import.
            await this.#open(file, { syncPosition: current })
            this.#meta.current = current
            this.#meta.dirty = false
            this.#persist()
        } finally { this.#applying = false }
    }
    async #resolveConflict(which) {
        const conflict = this.#conflict
        if (!conflict || this.#busy) return
        this.#conflict = null
        $('#sync-conflict').hidden = true
        if (which === 'local') {
            this.#meta.current.clock = mergeClocks(this.#meta.current.clock, conflict.remote.clock)
            this.#changed(this.#meta.current.bookId)
        } else {
            // Remote selection is deliberate; retain a recovery copy of local progress.
            localStorage.setItem(`${this.#key}:recovery`, JSON.stringify(this.#meta.current))
            this.#meta.current = null; this.#meta.dirty = false
            this.#persist()
        }
        await this.sync()
    }
    async #openSelected() {
        const selected = $('#sync-books').value
        if (this.#busy || !this.#manifest?.books[selected]) return
        this.#busy = true
        try {
            const book = this.#manifest.books[selected]
            const entries = await this.#repository.readTranslations(book)
            const file = await this.#repository.downloadBook(book,
                ({ completed, total }) => this.#status(`正在下载书籍：已完成 ${completed}/${total} 块。`))
            this.#applying = true
            const state = getTranslationSyncState(selected)
            const generation = book.cacheGeneration ?? 'original'
            if (state.generation !== generation) await clearTranslations(selected, { silent: true })
            acknowledgeTranslationSync(selected, generation, state)
            await saveTranslations(selected, [...entries.values()], { silent: true })
            await this.#open(file)
            this.#applying = false
            this.#changed(selected)
            $('#sync-settings').close()
        } catch (error) { this.#error(error) }
        finally { this.#applying = false; this.#busy = false }
        await this.sync()
    }
    async sync() {
        if (!this.#repository || this.#conflict) return
        if (this.#busy) { this.#again = true; return }
        this.#busy = true
        clearTimeout(this.#timer)
        this.#status('正在同步…')
        try {
            if (this.#meta.dirty) globalThis.reader?.flushProgress()
            const storageRevision = this.#storageRevision
            const last = await getLastBook()
            // Existing Mac data is uploaded on first setup if the repository is empty.
            let local = this.#meta.current
            const initial = await this.#repository.readManifest()
            this.#manifest = initial.value
            if (!local && !initial.value.current && last) {
                this.#changed(last.id)
                local = this.#meta.current
            }
            const revision = JSON.stringify(local?.clock)
            const file = last?.file
            const localId = last?.id
            let uploadedBook
            const localCacheState = localId ? getTranslationSyncState(localId) : null
            let localEntries = []
            if (file && localId) {
                localEntries = await loadTranslations(localId)
                uploadedBook = initial.value.books[localId] ?? { ...await this.#repository.uploadBook(file,
                    ({ completed, total }) => this.#status(`首次同步书籍：已完成 ${completed}/${total} 块；网络较慢时请保持页面打开。`)),
                cacheGeneration: localCacheState.generation }
            }
            this.#status('正在同步译文与阅读位置…')
            let snapshot = initial
            for (let attempt = 0; attempt < 3; attempt++) {
                const manifest = snapshot.value
                const selected = selectCurrent(local, manifest.current)
                const books = { ...manifest.books }
                let mergedCache
                if (uploadedBook) {
                    const old = books[localId] ?? uploadedBook
                    const remoteEntries = await this.#repository.readTranslations(old)
                    mergedCache = mergeTranslationCaches(localCacheState, localEntries,
                        old.cacheGeneration ?? 'original', remoteEntries)
                    const translations = await this.#repository.uploadTranslations(mergedCache.entries.values())
                    books[localId] = { ...uploadedBook, translations, cacheGeneration: mergedCache.generation }
                }
                const next = { version: 1, books, current: selected }
                const unchanged = JSON.stringify(next) === JSON.stringify(manifest)
                if (!unchanged && !await this.#repository.writeManifest(next, snapshot.sha)) {
                    snapshot = await this.#repository.readManifest()
                    continue
                }
                if (mergedCache && acknowledgeTranslationSync(localId, mergedCache.generation, localCacheState)) {
                    if (mergedCache.replaceLocal) await clearTranslations(localId, { silent: true })
                    await saveTranslations(localId, [...mergedCache.entries.values()], { silent: true })
                }
                this.#manifest = next
                const options = Object.entries(books).map(([key, book]) => new Option(book.name, key))
                $('#sync-books').replaceChildren(...options)
                if (selected) $('#sync-books').value = selected.bookId
                if (JSON.stringify(this.#meta.current?.clock) === revision) {
                    if (selected && (JSON.stringify(selected.clock) !== JSON.stringify(local?.clock)
                        || last?.id !== selected.bookId || mergedCache?.replaceLocal)) {
                        // Current was clean or absent, otherwise selectCurrent would conflict.
                        this.#meta.dirty = false
                        await this.#apply(selected, next)
                    } else {
                        this.#meta.current = selected
                        this.#meta.dirty = false
                        this.#persist()
                    }
                } else this.#again = true
                if (this.#storageRevision !== storageRevision) this.#again = true
                this.#status(this.#meta.dirty || this.#again ? '本机有新内容，等待下一次同步。' : '已同步；可以在另一台设备继续阅读。')
                return
            }
            throw new Error('另一设备正在同步，请稍后重试；本地进度已保留。')
        } catch (error) { this.#error(error) }
        finally {
            this.#busy = false
            if (this.#again && !this.#conflict) {
                this.#again = false
                this.#timer = setTimeout(() => this.sync(), 2000)
            }
        }
    }
}
