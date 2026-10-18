import { randomId } from '../random-id.js'

const changed = detail => {
    if (globalThis.dispatchEvent && globalThis.CustomEvent)
        globalThis.dispatchEvent(new CustomEvent('foliate-storage-change', { detail }))
}

const databaseName = 'foliate-reader'
const storeName = 'books'
const lastBookKey = 'foliate:last-book'
const progressPrefix = 'foliate:progress:'
const modePrefix = 'foliate:mode:'
const maxCachedBookSize = 200 * 1024 * 1024

const openDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(storeName))
            db.createObjectStore(storeName)
    }
    request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => db.close()
        resolve(db)
    }
    request.onerror = () => reject(request.error)
})

const perform = async (mode, action) => {
    const db = await openDatabase()
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, mode)
            const request = action(transaction.objectStore(storeName))
            transaction.oncomplete = () => resolve(request?.result)
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
        })
    } finally {
        db.close()
    }
}

const translationDatabaseName = 'foliate-reader-translations'
const translationStoreName = 'entries'
const translationKey = (bookId, key) => `${bookId}\u0000${key}`
const translationRange = bookId => IDBKeyRange.bound(
    `${bookId}\u0000`, `${bookId}\u0000\uffff`)

const openTranslationDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(translationDatabaseName, 1)
    request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(translationStoreName))
            db.createObjectStore(translationStoreName)
    }
    request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => db.close()
        resolve(db)
    }
    request.onerror = () => reject(request.error)
})

const performTranslations = async (mode, action) => {
    const db = await openTranslationDatabase()
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(translationStoreName, mode)
            const request = action(transaction.objectStore(translationStoreName))
            transaction.oncomplete = () => resolve(request?.result)
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
        })
    } finally {
        db.close()
    }
}

export const loadTranslations = async bookId => {
    if (!bookId) return []
    const entries = await performTranslations('readonly',
        store => store.getAll(translationRange(bookId)))
    return entries.filter(entry => entry
        && typeof entry.key === 'string' && typeof entry.text === 'string')
}

export const saveTranslations = async (bookId, entries, { silent = false } = {}) => {
    if (!bookId || !entries?.length) return
    await performTranslations('readwrite', store => {
        for (const { key, text } of entries)
            if (typeof key === 'string' && typeof text === 'string')
                store.put({ key, text }, translationKey(bookId, key))
    })
    if (!silent) changed({ kind: 'translations', id: bookId })
}

export const clearTranslations = async (bookId, { silent = false } = {}) => {
    if (!bookId) return
    await performTranslations('readwrite',
        store => store.delete(translationRange(bookId)))
    if (!silent) {
        localStorage.setItem(`foliate:translation-sync:${bookId}`, JSON.stringify({ generation: randomId(), reset: true }))
        changed({ kind: 'translations-reset', id: bookId })
    }
}

export const getTranslationSyncState = id => {
    try {
        const value = JSON.parse(localStorage.getItem(`foliate:translation-sync:${id}`) ?? 'null')
        if (value && typeof value.generation === 'string') return value
    } catch { /* Older caches belong to the original generation. */ }
    return { generation: 'original', reset: false }
}

export const acknowledgeTranslationSync = (id, generation, previous) => {
    const now = getTranslationSyncState(id)
    if (now.generation !== previous.generation || now.reset !== previous.reset) return false
    localStorage.setItem(`foliate:translation-sync:${id}`, JSON.stringify({ generation, reset: false }))
    return true
}

export const bookId = file => file?.name && Number.isFinite(file.size)
    ? `${file.name}:${file.size}:${file.lastModified ?? 0}`
    : null

export const saveBook = async file => {
    const id = bookId(file)
    if (!id || file.size > maxCachedBookSize) return null
    const record = {
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        blob: file,
    }
    // Only the last book is cached, so opening a different book replaces the
    // previous blob instead of accumulating books in browser storage.
    await perform('readwrite', store => {
        store.clear()
        return store.put(record, id)
    })
    localStorage.setItem(lastBookKey, JSON.stringify({
        id,
        name: record.name,
        type: record.type,
        size: record.size,
        lastModified: record.lastModified,
    }))
    changed({ kind: 'book', id })
    return id
}

export const getLastBook = async () => {
    let metadata
    try { metadata = JSON.parse(localStorage.getItem(lastBookKey) ?? 'null') }
    catch { return null }
    if (!metadata?.id) return null
    const record = await perform('readonly', store => store.get(metadata.id))
    if (!record?.blob) return null
    const file = new File([record.blob], record.name ?? metadata.name, {
        type: record.type ?? metadata.type ?? '',
        lastModified: record.lastModified ?? metadata.lastModified ?? Date.now(),
    })
    return { id: metadata.id, file }
}

const getPosition = id => {
    if (!id) return null
    try {
        const value = localStorage.getItem(progressPrefix + id)
        if (!value) return null
        // Older versions stored a plain CFI string.
        return value.startsWith('{') ? JSON.parse(value) : { cfi: value }
    } catch { return null }
}

export const getProgress = id => getPosition(id)?.cfi ?? null
export const getTranslationPosition = id => getPosition(id)?.translation ?? null

export const saveProgress = (id, cfi, translation = null) => {
    if (!id || !cfi) return
    try {
        const value = JSON.stringify({ cfi, translation })
        if (localStorage.getItem(progressPrefix + id) === value) return
        localStorage.setItem(progressPrefix + id, value)
        changed({ kind: 'progress', id })
    }
    catch { /* Storage can be unavailable in private windows. */ }
}

export const getReadingMode = id => {
    if (!id) return null
    try { return localStorage.getItem(modePrefix + id) }
    catch { return null }
}

export const saveReadingMode = (id, mode) => {
    if (!id || !['original', 'bilingual', 'translation'].includes(mode)) return
    try {
        if (localStorage.getItem(modePrefix + id) === mode) return
        localStorage.setItem(modePrefix + id, mode)
        changed({ kind: 'mode', id })
    }
    catch { /* Storage can be unavailable in private windows. */ }
}

export const getReadingFlow = () => {
    try {
        return localStorage.getItem('foliate:flow') === 'scrolled' ? 'scrolled' : 'paginated'
    } catch { return 'paginated' }
}

export const saveReadingFlow = flow => {
    if (!['paginated', 'scrolled'].includes(flow)) return
    try { localStorage.setItem('foliate:flow', flow) }
    catch { /* Storage can be unavailable in private windows. */ }
}
