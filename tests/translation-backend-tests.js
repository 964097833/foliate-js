import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Buffer } from 'node:buffer'
import { normalizeBaseURL, TranslationService } from '../server/translation.js'

const settings = { url: 'https://example.com/v1/', model: 'translation-model', apiKey: 'test-secret-key-only' }
const secureStorage = () => {
    const key = randomBytes(32)
    return {
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async value => {
            const iv = randomBytes(12)
            const cipher = createCipheriv('aes-256-gcm', key, iv)
            const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
            return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
        },
        decryptStringAsync: async value => {
            const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
            decipher.setAuthTag(value.subarray(12, 28))
            return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') }
        },
    }
}
const withService = async action => {
    const directory = await mkdtemp(path.join(tmpdir(), 'foliate-translation-test-'))
    const options = { directory, secureStorage: secureStorage() }
    try { await action(options, new TranslationService(options)) }
    finally { await rm(directory, { force: true, recursive: true }) }
}
const translated = (text = '译文', finishReason = 'stop') => new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: finishReason }],
}))

test('base URLs normalize a completion endpoint and reject embedded credentials', () => {
    assert.equal(normalizeBaseURL(' https://example.com/v1/// '), 'https://example.com/v1')
    assert.equal(normalizeBaseURL('http://localhost:1234/v1/chat/completions/'), 'http://localhost:1234/v1')
    for (const invalid of ['file:///tmp/key', 'https://secret@example.com/v1', 'https://example.com/v1?key=secret', 'no-url'])
        assert.throws(() => normalizeBaseURL(invalid))
})

test('disables thinking for Qwen 3 hybrid models only', async () => {
    await withService(async options => {
        let body
        const service = new TranslationService({
            ...options,
            fetch: async (_url, request) => {
                body = JSON.parse(request.body)
                return translated()
            },
        })
        await service.saveSettings({ ...settings, model: 'qwen3.8-flash' })
        assert.equal(await service.translate(1, { id: 'qwen', text: 'A passage' }), '译文')
        assert.equal(body.enable_thinking, false)
        await service.saveSettings({ url: settings.url, model: 'gpt-4o-mini' })
        assert.equal(await service.translate(1, { id: 'other', text: 'A passage' }), '译文')
        assert.equal('enable_thinking' in body, false)
    })
})

test('settings persist encrypted, reload without exposing the key, and use the saved endpoint', async () => {
    await withService(async (options, service) => {
        assert.deepEqual(await service.getSettings(), { url: '', model: '', hasKey: false })
        const expected = { url: 'https://example.com/v1', model: settings.model, hasKey: true }
        assert.deepEqual(await service.saveSettings(settings), expected)
        const file = path.join(options.directory, 'translation-settings.json')
        assert.equal((await stat(file)).mode & 0o777, 0o600)
        const saved = await readFile(file, 'utf8')
        assert.equal(saved.includes(settings.apiKey), false)
        assert.ok(JSON.parse(saved).encryptedKey)
        const reloaded = new TranslationService({
            ...options,
            fetch: async (url, request) => {
                assert.equal(url, 'https://example.com/v1/chat/completions')
                assert.equal(request.redirect, 'error')
                assert.equal(request.headers.Authorization, `Bearer ${settings.apiKey}`)
                const body = JSON.parse(request.body)
                assert.equal(body.model, settings.model)
                assert.equal(body.stream, false)
                assert.equal(body.messages[1].content, 'Untrusted book passage')
                return translated()
            },
        })
        assert.deepEqual(await reloaded.getSettings(), expected)
        assert.equal(await reloaded.translate(1, { id: 'paragraph-1', text: 'Untrusted book passage' }), '译文')
    })
})

test('changing the endpoint requires a new key and a failed save preserves working settings', async () => {
    await withService(async (options, service) => {
        await service.saveSettings(settings)
        await service.saveSettings({ url: settings.url, model: 'new-model', apiKey: '' })
        await assert.rejects(service.saveSettings({ url: 'https://other.example/v1', model: 'new-model' }), /重新填写/)
        assert.equal((await service.getSettings()).url, 'https://example.com/v1')
        options.secureStorage.isAsyncEncryptionAvailable = async () => false
        await assert.rejects(service.saveSettings({ ...settings, apiKey: 'replacement-key' }), /系统加密/)
        assert.equal((await service.getSettings()).model, 'new-model')
        const saved = await readFile(path.join(options.directory, 'translation-settings.json'), 'utf8')
        assert.equal(JSON.parse(saved).model, 'new-model')
        await assert.rejects(service.saveSettings({ ...settings, apiKey: 'key\r\nInjected: header' }), /API Key/)
    })
})

test('authentication, rate limiting, invalid output, and incomplete output are recoverable errors', async () => {
    await withService(async options => {
        let respond = () => new Response('server may echo a secret', { status: 401 })
        const service = new TranslationService({ ...options, fetch: async () => respond() })
        await service.saveSettings(settings)
        const request = () => service.translate(1, { id: 'test', text: 'A passage' })
        await assert.rejects(request(), /API Key/)
        respond = () => new Response('', { status: 429 })
        await assert.rejects(request(), /频繁或额度/)
        respond = () => translated('incomplete', 'length')
        await assert.rejects(request(), /未完整/)
        respond = () => new Response('not JSON')
        await assert.rejects(request(), /有效的 Chat Completions/)
        respond = () => translated('')
        await assert.rejects(request(), /有效译文/)
        respond = () => new Response('x'.repeat(1024 * 1024 + 1))
        await assert.rejects(request(), /响应过大/)
        respond = () => translated('后来恢复的译文')
        assert.equal(await request(), '后来恢复的译文')
    })
})

test('cancellation is isolated by window and settings changes cancel all active requests', async () => {
    await withService(async options => {
        const active = new Map()
        const service = new TranslationService({ ...options, fetch: (_url, request) => new Promise((resolve, reject) => {
            const text = JSON.parse(request.body).messages[1].content
            active.set(text, { resolve, signal: request.signal })
            request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }) })
        await service.saveSettings(settings)
        const one = service.translate(1, { id: 'same-id', text: 'window-one' })
        const oneCancelled = assert.rejects(one, /已取消/)
        const two = service.translate(2, { id: 'same-id', text: 'window-two' })
        await new Promise(resolve => setTimeout(resolve, 0))
        service.cancel(1, 'same-id')
        await oneCancelled
        assert.equal(active.get('window-two').signal.aborted, false)
        active.get('window-two').resolve(translated('other window'))
        assert.equal(await two, 'other window')
        const pending = service.translate(2, { id: 'next', text: 'cancel-on-settings' })
        const cancelled = assert.rejects(pending, /已取消/)
        await new Promise(resolve => setTimeout(resolve, 0))
        await service.saveSettings({ url: settings.url, model: 'updated-model' })
        await cancelled
    })
})

test('corrupted settings can be replaced and clear removes the encrypted record', async () => {
    await withService(async options => {
        const file = path.join(options.directory, 'translation-settings.json')
        await writeFile(file, '{invalid json')
        const changes = []
        const service = new TranslationService({ ...options, onSettingsChange: value => changes.push(value) })
        assert.deepEqual(await service.getSettings(), { url: '', model: '', hasKey: false })
        await service.saveSettings(settings)
        await service.clearSettings()
        assert.deepEqual(await service.getSettings(), { url: '', model: '', hasKey: false })
        assert.deepEqual(changes.map(value => value.hasKey), [true, false])
        assert.equal(changes.some(value => 'apiKey' in value || 'encryptedKey' in value), false)
        await assert.rejects(readFile(file), { code: 'ENOENT' })
    })
})
