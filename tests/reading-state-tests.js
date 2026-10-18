import assert from 'node:assert/strict'
import test from 'node:test'
import { getProgress, getTranslationPosition, saveProgress, getReadingFlow, saveReadingFlow } from '../ui/reader-storage.js'

test('saved positions keep translated offsets and remain compatible with plain CFIs', () => {
    const previous = globalThis.localStorage
    const entries = new Map()
    globalThis.localStorage = {
        getItem: key => entries.get(key) ?? null,
        setItem: (key, value) => entries.set(key, value),
    }
    try {
        const cfi = 'epubcfi(/6/2!/4/2/1:12)'
        entries.set('foliate:progress:old', cfi)
        assert.equal(getProgress('old'), cfi)
        assert.equal(getTranslationPosition('old'), null)
        const translation = { key: '0:0:A paragraph', offset: 120, viewportOffset: -12 }
        saveProgress('new', cfi, translation)
        assert.equal(getProgress('new'), cfi)
        assert.deepEqual(getTranslationPosition('new'), translation)
        entries.set('foliate:progress:broken', '{bad json')
        assert.equal(getProgress('broken'), null)
    } finally {
        if (previous === undefined) delete globalThis.localStorage
        else globalThis.localStorage = previous
    }
})

test('reading flow survives reload and invalid or unavailable storage falls back to pagination', () => {
    const previous = globalThis.localStorage
    const entries = new Map()
    globalThis.localStorage = {
        getItem: key => entries.get(key) ?? null,
        setItem: (key, value) => entries.set(key, value),
    }
    try {
        assert.equal(getReadingFlow(), 'paginated')
        saveReadingFlow('scrolled')
        assert.equal(getReadingFlow(), 'scrolled')
        saveReadingFlow('invalid')
        assert.equal(getReadingFlow(), 'scrolled')
        entries.set('foliate:flow', 'corrupted')
        assert.equal(getReadingFlow(), 'paginated')
        globalThis.localStorage.getItem = () => { throw new Error('Storage unavailable') }
        assert.equal(getReadingFlow(), 'paginated')
    } finally {
        if (previous === undefined) delete globalThis.localStorage
        else globalThis.localStorage = previous
    }
})
