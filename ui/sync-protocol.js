// Immutable data objects + one optimistic, SHA-guarded manifest commit.
// Vector clocks detect concurrent offline reading without trusting device clocks.
export const mergeClocks = (a = {}, b = {}) => Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key, Math.max(a[key] ?? 0, b[key] ?? 0)]))
export const dominates = (a = {}, b = {}) => Object.entries(b).every(([key, value]) => (a[key] ?? 0) >= value)
export class SyncConflict extends Error {
    constructor(local, remote) {
        super('两台设备都更新了阅读位置，请选择继续哪一端。')
        this.local = local
        this.remote = remote
    }
}
export const selectCurrent = (local, remote) => {
    if (!local) return remote
    if (!remote) return local
    if (dominates(remote.clock, local.clock)) return remote
    if (dominates(local.clock, remote.clock)) return local
    throw new SyncConflict(local, remote)
}
export const mergeTranslationCaches = (local, localEntries, remoteGeneration, remoteEntries) => {
    if (local.reset) return { generation: local.generation, entries: new Map(localEntries.map(entry => [entry.key, entry])), replaceLocal: false }
    if (local.generation !== remoteGeneration) return { generation: remoteGeneration, entries: remoteEntries, replaceLocal: true }
    const entries = new Map(remoteEntries)
    for (const entry of localEntries) if (!entries.has(entry.key)) entries.set(entry.key, entry)
    return { generation: remoteGeneration, entries, replaceLocal: false }
}
export const portablePosition = position => position && ({
    key: position.key, offset: position.offset,
})
export const encodeJSON = value => {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}
export const decodeJSON = value => JSON.parse(new TextDecoder('utf-8', { fatal: true })
    .decode(Uint8Array.from(atob(value.replace(/\s/g, '')), char => char.charCodeAt(0))))
export const digest = async bytes => {
    if (globalThis.crypto?.subtle)
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
            byte => byte.toString(16).padStart(2, '0')).join('')
    // WKWebView custom schemes may not expose SubtleCrypto.
    const { nativePlugin } = await import('./native-bridge.js')
    if (!nativePlugin) throw new Error('此环境不支持安全的同步校验。')
    let binary = ''
    for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
    return (await nativePlugin.digest({ base64: btoa(binary) })).hash
}
export const validateManifest = value => {
    if (!value || value.version !== 1 || !value.books || typeof value.books !== 'object'
        || Array.isArray(value.books) || Object.keys(value.books).length > 100)
        throw new Error('同步数据版本或书库无效。')
    const hashes = values => Array.isArray(values) && values.length <= 2048
        && values.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
    for (const [id, book] of Object.entries(value.books)) {
        if (id.length > 1024 || !book || typeof book.name !== 'string' || book.name.length > 512
            || !Number.isSafeInteger(book.size) || book.size < 0 || book.size > 50 * 1024 * 1024
            || !Number.isSafeInteger(book.lastModified) || typeof book.type !== 'string'
            || `${book.name}:${book.size}:${book.lastModified}` !== id
            || !hashes(book.chunks) || !hashes(book.translations)
            || book.cacheGeneration !== undefined && (typeof book.cacheGeneration !== 'string'
                || !/^[\w-]{1,64}$/.test(book.cacheGeneration)))
            throw new Error('同步书籍元数据无效。')
    }
    const current = value.current
    if (current && (!Object.hasOwn(value.books, current.bookId)
        || typeof current.cfi !== 'string' || current.cfi.length > 65536 || !/^epubcfi\(.+\)$/.test(current.cfi)
        || !['original', 'bilingual', 'translation'].includes(current.mode)
        || !current.clock || Array.isArray(current.clock) || Object.keys(current.clock).length > 64
        || Object.entries(current.clock).some(([key, counter]) => !/^[\w-]{1,64}$/.test(key)
            || !Number.isSafeInteger(counter) || counter < 0)
        || current.translation && (typeof current.translation.key !== 'string'
            || current.translation.key.length > 65536 || !Number.isSafeInteger(current.translation.offset)
            || current.translation.offset < 0))) throw new Error('同步阅读位置无效。')
    return value
}

export class SyncRepository {
    #request
    #known = new Set()
    #objects = new Map()
    constructor(request) { this.#request = request }
    async readManifest() {
        const response = await this.#request({ method: 'GET', path: 'reader-sync/manifest.json' })
        if (response.status === 404) return { value: { version: 1, books: {}, current: null }, sha: null }
        if (response.status !== 200) throw new Error(`读取同步清单失败（${response.status}）。`)
        if (typeof response.data?.content !== 'string' || response.data.content.length > 850000)
            throw new Error('同步清单内容无效或过大。')
        return { value: validateManifest(decodeJSON(response.data.content)), sha: response.data.sha }
    }
    async writeManifest(value, sha) {
        validateManifest(value)
        const content = encodeJSON(value)
        if (content.length > 700000) throw new Error('同步清单已满，请精简同步书库。')
        const response = await this.#request({ method: 'PUT', path: 'reader-sync/manifest.json',
            content, ...(sha ? { sha } : {}) })
        if ([409, 422].includes(response.status)) return false
        if (![200, 201].includes(response.status)) throw new Error(`保存同步清单失败（${response.status}）。`)
        return true
    }
    async putObject(value) {
        const text = JSON.stringify(value)
        const hash = await digest(new TextEncoder().encode(text))
        if (!this.#known.has(hash)) {
            const path = `reader-sync/objects/${hash}.json`
            const existing = await this.#request({ method: 'GET', path })
            if (existing.status === 404) {
                const result = await this.#request({ method: 'PUT', path, content: encodeJSON(value) })
                if (![200, 201, 409, 422].includes(result.status)) throw new Error('上传同步数据失败。')
                // Concurrent creation is valid only if the object now has the expected hash.
                if ([409, 422].includes(result.status)) await this.getObject(hash)
            } else if (existing.status === 200) {
                const actual = await digest(new TextEncoder().encode(JSON.stringify(decodeJSON(existing.data.content))))
                if (actual !== hash) throw new Error('已有同步数据校验失败。')
            } else throw new Error(`读取同步数据失败（${existing.status}）。`)
            this.#known.add(hash)
        }
        return hash
    }
    async getObject(hash) {
        if (this.#objects.has(hash)) return this.#objects.get(hash)
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('同步对象编号无效。')
        const result = await this.#request({ method: 'GET', path: `reader-sync/objects/${hash}.json` })
        if (result.status !== 200) throw new Error('同步数据尚未完整上传，请稍后重试。')
        if (typeof result.data?.content !== 'string' || result.data.content.length > 850000)
            throw new Error('同步对象内容无效或过大。')
        const value = decodeJSON(result.data.content)
        if (await digest(new TextEncoder().encode(JSON.stringify(value))) !== hash)
            throw new Error('同步数据校验失败。')
        this.#known.add(hash)
        this.#objects.set(hash, value)
        return value
    }
    async uploadBook(file, onProgress = () => {}) {
        if (file.size > 50 * 1024 * 1024) throw new Error('GitHub 同步目前支持 50 MB 以内的书籍；本地阅读不受影响。')
        const chunks = []
        const total = Math.ceil(file.size / 240000)
        onProgress({ completed: 0, total })
        for (let offset = 0; offset < file.size; offset += 240000) {
            const bytes = new Uint8Array(await file.slice(offset, offset + 240000).arrayBuffer())
            let binary = ''
            for (const byte of bytes) binary += String.fromCharCode(byte)
            chunks.push(await this.putObject({ kind: 'book', bytes: btoa(binary) }))
            onProgress({ completed: chunks.length, total })
        }
        return { name: file.name, size: file.size, type: file.type,
            lastModified: file.lastModified, chunks, translations: [] }
    }
    async downloadBook(book, onProgress = () => {}) {
        const parts = new Array(book.chunks.length)
        let size = 0, next = 0, completed = 0, failure
        onProgress({ completed: 0, total: book.chunks.length })
        const worker = async () => {
            while (!failure && next < book.chunks.length) {
                const index = next++
                try {
                    const value = await this.getObject(book.chunks[index])
                    if (value.kind !== 'book' || typeof value.bytes !== 'string' || value.bytes.length > 320000)
                        throw new Error('同步书籍分块无效。')
                    const bytes = Uint8Array.from(atob(value.bytes), char => char.charCodeAt(0))
                    size += bytes.length
                    if (size > book.size) throw new Error('同步书籍大小校验失败。')
                    parts[index] = bytes
                    onProgress({ completed: ++completed, total: book.chunks.length })
                } catch (error) { failure ??= error }
            }
        }
        // Reads are independent; preserve file order even when requests finish out of order.
        // Settle active reads before reporting failure so late progress cannot hide the error.
        await Promise.all(Array.from({ length: Math.min(4, book.chunks.length) }, worker))
        if (failure) throw failure
        if (size !== book.size) throw new Error('同步书籍不完整。')
        return new File(parts, book.name, { type: book.type, lastModified: book.lastModified })
    }
    async readTranslations(book) {
        const entries = new Map()
        let bytes = 0
        for (const hash of book.translations) {
            const object = await this.getObject(hash)
            if (object.kind !== 'translations' || !Array.isArray(object.entries)
                || object.entries.some(entry => typeof entry?.key !== 'string' || typeof entry?.text !== 'string'))
                throw new Error('同步译文数据无效。')
            bytes += new TextEncoder().encode(JSON.stringify(object)).length
            if (bytes > 64 * 1024 * 1024) throw new Error('这本书的同步译文超过 64 MB，请精简缓存后重试。')
            for (const entry of object.entries) if (!entries.has(entry.key)) entries.set(entry.key, entry)
        }
        return entries
    }
    async uploadTranslations(entries) {
        const hashes = []
        let batch = [], size = 0
        for (const entry of [...entries].sort((a, b) => a.key.localeCompare(b.key))) {
            const length = new TextEncoder().encode(JSON.stringify(entry)).length
            if (length > 400000) throw new Error('单段译文过大，无法同步。')
            if (size + length > 400000 && batch.length) {
                hashes.push(await this.putObject({ kind: 'translations', entries: batch }))
                batch = []; size = 0
            }
            batch.push(entry); size += length
        }
        if (batch.length) hashes.push(await this.putObject({ kind: 'translations', entries: batch }))
        return hashes
    }
}
