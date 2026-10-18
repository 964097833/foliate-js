import { bookId, saveBook, getLastBook, getProgress, saveProgress,
    getReadingMode, saveReadingMode, getTranslationPosition,
    loadTranslations, saveTranslations, clearTranslations } from '../ui/reader-storage.js'

// Run on a separate test origin, as documented in README, so these fixture
// books never replace the reader's real cached book.
const previous = await getLastBook()
const first = new File(['first book'], 'storage-regression-first.epub', { lastModified: 1 })
const second = new File(['second book'], 'storage-regression-second.epub', { lastModified: 2 })
const firstId = bookId(first), secondId = bookId(second)
try {
    await saveBook(first)
    const cfi = 'epubcfi(/6/2!/4/2/1:12)'
    const translation = { key: '0:0:A paragraph', offset: 120 }
    saveProgress(firstId, cfi, translation)
    saveReadingMode(firstId, 'translation')
    await saveTranslations(firstId, [{ key: translation.key, text: '保存的译文。' }])
    const restored = await getLastBook()
    console.assert(restored.id === firstId && await restored.file.text() === 'first book',
        'IndexedDB restores the last local book and its contents')
    console.assert(getProgress(firstId) === cfi
        && getTranslationPosition(firstId).offset === 120
        && getReadingMode(firstId) === 'translation',
    'Reading position, translated offset and mode survive a storage round trip')
    console.assert((await loadTranslations(firstId))[0].text === '保存的译文。',
        'Completed translations survive an IndexedDB round trip')
    await saveBook(second)
    console.assert((await getLastBook()).id === secondId, 'A newly selected book becomes the cached book')
    console.assert(getProgress(firstId) === cfi && (await loadTranslations(firstId)).length === 1,
        'Switching books keeps earlier reading progress and translations')
    await clearTranslations(firstId)
    console.assert((await loadTranslations(firstId)).length === 0, 'Translation cache can be cleared')
} finally {
    await clearTranslations(firstId)
    for (const id of [firstId, secondId]) {
        localStorage.removeItem('foliate:progress:' + id)
        localStorage.removeItem('foliate:mode:' + id)
    }
    if (previous) await saveBook(previous.file)
    else localStorage.removeItem('foliate:last-book')
}
