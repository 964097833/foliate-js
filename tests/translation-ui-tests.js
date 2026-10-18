import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { TranslationUI } from '../ui/translation.js'

const deferred = () => {
    let resolve
    const promise = new Promise(done => resolve = done)
    return { promise, resolve }
}

const fixture = (bridge, withBook = true) => {
    const previousDocument = globalThis.document
    const elements = new Map()
    const element = selector => {
        if (!elements.has(selector)) elements.set(selector, {
            value: '', hidden: true, disabled: false, open: false,
            textContent: '', dataset: {}, listeners: new Map(),
            classList: { remove() {} },
            addEventListener(type, listener) { this.listeners.set(type, listener) },
            showModal() { this.open = true },
            close() { this.open = false; this.listeners.get('close')?.() },
        })
        return elements.get(selector)
    }
    globalThis.document = { querySelector: element }
    const renderer = new EventTarget()
    renderer.setStyles = () => {}
    renderer.restoreAnchor = () => Promise.resolve()
    renderer.getContents = () => []
    const view = { renderer, book: {}, lastLocation: null }
    const ui = new TranslationUI(withBook ? view : undefined, {
        bridge: { cancel() {}, onSettingsChange: () => () => {}, ...bridge },
    })
    return { ui, view, element, close() {
        ui.destroy()
        if (previousDocument === undefined) delete globalThis.document
        else globalThis.document = previousDocument
    } }
}

const unconfigured = { url: '', model: '', hasKey: false }

test('global settings can save and clear without a book, and survive attaching the reader', async () => {
    let settings = unconfigured
    let translations = 0
    const test = fixture({
        getSettings: () => Promise.resolve(settings),
        saveSettings: input => {
            settings = { url: input.url, model: input.model, hasKey: !!input.apiKey }
            return Promise.resolve(settings)
        },
        clearSettings: () => { settings = unconfigured; return Promise.resolve(settings) },
        translate: () => { translations++; return Promise.resolve('unused') },
    }, false)
    try {
        assert.equal(test.ui.translation, null)
        await test.ui.openSettings()
        assert.equal(test.element('#translation-settings').open, true)
        assert.equal(test.element('#save-translation-settings').textContent, '保存设置')
        test.element('#api-url').value = 'https://example.com/v1'
        test.element('#api-model').value = 'global-model'
        test.element('#api-key').value = 'mock-test-key'
        test.element('#translation-settings-form').listeners.get('submit')({ preventDefault() {} })
        await delay(0)
        assert.equal(test.element('#translation-settings').open, false)
        assert.equal(test.element('#api-key').value, '')
        assert.equal(settings.hasKey, true)
        assert.equal(translations, 0)

        test.ui.attach(test.view)
        await test.ui.setMode('bilingual')
        assert.equal(test.ui.translation.mode, 'bilingual')
        assert.equal(test.element('#translation-settings').open, false,
            'The book uses the configuration saved before it opened')
        await test.ui.setMode('original')
        await test.ui.openSettings()
        await test.element('#clear-translation-settings').listeners.get('click')()
        assert.equal(settings.hasKey, false)
        assert.equal(test.ui.translation.mode, 'original')
        assert.equal(translations, 0)
    } finally { test.close() }
})

test('global settings can be cleared before opening a book', async () => {
    const test = fixture({
        getSettings: () => Promise.resolve({ url: 'https://example.com/v1', model: 'global-model', hasKey: true }),
        clearSettings: () => Promise.resolve(unconfigured),
    }, false)
    try {
        await test.ui.openSettings()
        await test.element('#clear-translation-settings').listeners.get('click')()
        assert.equal(test.ui.translation, null)
        assert.equal(test.element('#api-url').value, '')
        assert.equal(test.element('#api-model').value, '')
        assert.equal(test.element('#api-key').value, '')
        assert.equal(test.element('#clear-translation-settings').disabled, true)
    } finally { test.close() }
})

test('choosing original cancels a delayed first-use settings dialog and its translation intent', async () => {
    const delayedSettings = deferred()
    const secondLookup = deferred()
    let lookups = 0
    let configured = false
    const settings = { url: 'https://example.com/v1', model: 'test-model', hasKey: true }
    const test = fixture({
        getSettings: () => {
            if (++lookups === 2) {
                secondLookup.resolve()
                return delayedSettings.promise
            }
            return Promise.resolve(configured ? settings : unconfigured)
        },
        saveSettings: () => { configured = true; return Promise.resolve(settings) },
    })
    try {
        const enabling = test.ui.setMode('bilingual')
        await secondLookup.promise
        await test.ui.setMode('original')
        delayedSettings.resolve(unconfigured)
        await enabling
        assert.equal(test.ui.translation.mode, 'original')
        assert.equal(test.element('#translation-settings').open, false)

        // A later explicit Settings action must work without resurrecting the
        // cancelled "save and start translating" intent.
        await test.ui.openSettings()
        assert.equal(test.element('#translation-settings').open, true)
        assert.equal(test.element('#save-translation-settings').textContent, '保存设置')
        test.element('#api-url').value = settings.url
        test.element('#api-model').value = settings.model
        test.element('#api-key').value = 'mock-test-key'
        test.element('#translation-settings-form').listeners.get('submit')({ preventDefault() {} })
        await delay(0)
        assert.equal(test.element('#translation-settings').open, false)
        assert.equal(test.ui.translation.mode, 'original',
            'Saving explicit settings must not reactivate the cancelled bilingual mode')
    } finally { test.close() }
})

test('explicit settings opens normally and first-use translation keeps its requested mode', async () => {
    const test = fixture({ getSettings: () => Promise.resolve(unconfigured) })
    try {
        await test.ui.openSettings()
        assert.equal(test.element('#translation-settings').open, true)
        assert.equal(test.element('#save-translation-settings').textContent, '保存设置')
        test.element('#translation-settings').close()
        await test.ui.setMode('translation')
        assert.equal(test.element('#translation-settings').open, true)
        assert.equal(test.element('#save-translation-settings').textContent, '保存并开始翻译')
        assert.equal(test.ui.translation.mode, 'original')
    } finally { test.close() }
})

test('a delayed close event cannot cancel a newly reopened translation dialog', async () => {
    let configured = false
    const settings = { url: 'https://example.com/v1', model: 'test-model', hasKey: true }
    const test = fixture({
        getSettings: () => Promise.resolve(configured ? settings : unconfigured),
        saveSettings: () => { configured = true; return Promise.resolve(settings) },
    })
    try {
        await test.ui.setMode('bilingual')
        // The browser queues dialog close events; an earlier event may be
        // delivered after a new first-use dialog has already been opened.
        test.element('#translation-settings').listeners.get('close')()
        test.element('#api-key').value = 'test-key'
        test.element('#translation-settings-form').listeners.get('submit')({ preventDefault() {} })
        await delay(0)
        assert.equal(test.ui.translation.mode, 'bilingual')
    } finally { test.close() }
})

test('switching books clears the previous book translation status', () => {
    const test = fixture({ getSettings: () => Promise.resolve(unconfigured) })
    try {
        test.element('#translation-status-bar').hidden = false
        test.element('#translation-status-bar').dataset.state = 'error'
        test.element('#translation-status').textContent = 'Previous book failed'
        test.ui.attach(test.view)
        assert.equal(test.element('#translation-status-bar').hidden, true)
        assert.equal(test.element('#translation-status-bar').dataset.state, 'idle')
        assert.equal(test.element('#translation-status').textContent, '')
    } finally { test.close() }
})
