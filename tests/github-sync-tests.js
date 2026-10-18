import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { SyncRepository, SyncConflict, mergeClocks, selectCurrent,
    portablePosition, mergeTranslationCaches, encodeJSON, decodeJSON, validateManifest } from '../ui/sync-protocol.js'
import { GitHubSyncService, validateSyncRequest } from '../server/github-sync.js'
import { createSecureStorage } from '../server/secure-storage.js'
import { createNativeBridge } from '../ui/native-bridge.js'
import { createTranslationRequest } from '../translation-request.js'

const memoryGitHub = () => {
    const files = new Map()
    let revision = 0
    let writes = 0
    const request = async input => {
        const old = files.get(input.path)
        if (input.method === 'GET') return old ? { status: 200, data: old } : { status: 404, data: {} }
        if (old?.sha !== input.sha) return { status: 409, data: {} }
        const data = { content: input.content, sha: (++revision).toString(16).padStart(40, '0') }
        files.set(input.path, data); writes++
        return { status: old ? 200 : 201, data }
    }
    return { files, request, writes: () => writes }
}
const bookRecord = { name: 'test.epub', size: 1, type: 'application/epub+zip', lastModified: 0, chunks: [], translations: [] }
const bookKey = 'test.epub:1:0'
const current = clock => ({ bookId: bookKey, cfi: 'epubcfi(/6/2!/4/2)', mode: 'translation', clock })

test('causal positions follow newer reading and detect concurrent offline reading', () => {
    const mac = current({ mac: 2 })
    const phone = current({ mac: 2, phone: 1 })
    assert.equal(selectCurrent(mac, phone), phone)
    assert.equal(selectCurrent(phone, mac), phone)
    assert.throws(() => selectCurrent(current({ mac: 3 }), phone), SyncConflict)
    assert.deepEqual(mergeClocks({ mac: 3 }, { mac: 2, phone: 1 }), { mac: 3, phone: 1 })
    assert.equal(selectCurrent(null, phone), phone)
    assert.deepEqual(portablePosition({ key: 'p', offset: 45, viewportOffset: -120 }), { key: 'p', offset: 45 })
})

test('repository preserves binary book identity and structured cache entries across devices', async () => {
    const github = memoryGitHub()
    const mac = new SyncRepository(github.request)
    const bytes = randomBytes(480025)
    const file = new File([bytes], 'my book.epub', { type: 'application/epub+zip', lastModified: 12345678 })
    const book = await mac.uploadBook(file)
    assert.equal(book.chunks.length, 3)
    const entries = [{ key: 'url\u0000format:2:strong', text: '[{"id":1,"text":"中文粗体"}]' },
        { key: 'other', text: '保留换行\n和斜体' }]
    book.translations = await mac.uploadTranslations(entries)
    const afterUpload = github.writes()
    await mac.uploadBook(file)
    await mac.uploadTranslations(entries)
    assert.equal(github.writes(), afterUpload, 'unchanged objects are not committed again')
    const phone = new SyncRepository(github.request)
    const restored = await phone.downloadBook(book)
    assert.equal(restored.name, file.name)
    assert.equal(restored.lastModified, file.lastModified)
    assert.equal(restored.type, file.type)
    assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes)
    assert.deepEqual(new Map((await phone.readTranslations(book))), new Map(entries.map(entry => [entry.key, entry])))
    const id = `${file.name}:${file.size}:${file.lastModified}`
    const manifest = { version: 1, books: { [id]: book }, current: { ...current({ phone: 1 }), bookId: id } }
    assert.equal(await mac.writeManifest(manifest, null), true)
    assert.deepEqual((await phone.readManifest()).value, manifest)
})

test('manifest SHA prevents an offline writer from replacing a newer commit', async () => {
    const github = memoryGitHub()
    const repo = new SyncRepository(github.request)
    const manifest = { version: 1, books: { [bookKey]: bookRecord }, current: current({ mac: 1 }) }
    const first = await repo.readManifest()
    assert.equal(await repo.writeManifest(manifest, first.sha), true)
    assert.equal(await repo.writeManifest({ ...manifest, current: current({ phone: 1 }) }, first.sha), false)
    assert.deepEqual((await repo.readManifest()).value.current.clock, { mac: 1 })
})

test('corrupted or oversized remote data fails before replacing local storage', async () => {
    const github = memoryGitHub()
    const repo = new SyncRepository(github.request)
    const hash = await repo.putObject({ kind: 'translations', entries: [{ key: 'a', text: '中' }] })
    github.files.get(`reader-sync/objects/${hash}.json`).content = encodeJSON({ malicious: true })
    await assert.rejects(new SyncRepository(github.request).getObject(hash), /校验失败/)
    assert.throws(() => validateManifest({ version: 2, books: {} }), /版本/)
    assert.throws(() => validateManifest({ version: 1, books: { [bookKey]: { ...bookRecord, size: 100000000 } } }), /元数据/)
    assert.throws(() => validateManifest({ version: 1, books: { [bookKey]: bookRecord }, current: current({ mac: -1 }) }), /位置/)
    assert.throws(() => validateSyncRequest({ method: 'GET', path: '../translation-settings.json' }), /无效/)
    assert.throws(() => validateSyncRequest({ method: 'DELETE', path: 'reader-sync/manifest.json' }), /无效/)
    assert.deepEqual(decodeJSON(encodeJSON({ text: '中文📚\n' })), { text: '中文📚\n' })
})

test('Mac sync encrypts token, refuses public repositories and constrains credential destinations', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'foliate-sync-'))
    const calls = []
    let isPrivate = false
    const secureStorage = createSecureStorage({ env: { FOLIATE_WEB_MASTER_KEY: randomBytes(32).toString('base64') } })
    const fetch = async (url, options) => {
        calls.push({ url, options })
        return new Response(JSON.stringify(url.endsWith('/owner/data') ? { private: isPrivate } : {}), { status: 200 })
    }
    try {
        const service = new GitHubSyncService({ directory, secureStorage, fetch })
        const settings = await service.saveSettings({ repository: 'owner/data', branch: 'main', token: 'test-github-secret' })
        assert.deepEqual(settings, { repository: 'owner/data', branch: 'main', hasToken: true })
        assert.ok(!(await readFile(path.join(directory, 'github-sync.json'), 'utf8')).includes('test-github-secret'))
        await assert.rejects(service.request({ method: 'GET', path: 'reader-sync/manifest.json' }), /私有/)
        assert.equal(calls.length, 1, 'public repository receives no book requests')
        isPrivate = true
        assert.equal((await service.request({ method: 'GET', path: 'reader-sync/manifest.json' })).status, 200)
        assert.ok(calls.every(call => call.url.startsWith('https://api.github.com/repos/owner/data')))
        assert.ok(calls.every(call => call.options.redirect === 'error'))
        assert.equal((await service.getSettings()).token, undefined)
        await assert.rejects(service.saveSettings({ repository: 'owner/other', branch: 'main' }), /Token/)
        await service.clearSettings()
        assert.equal((await service.getSettings()).hasToken, false)
    } finally { await rm(directory, { recursive: true, force: true }) }
})

test('iPhone transport uses the same request protocol, preserves segments and rejects truncated output', async () => {
    const settings = { url: 'https://example.com/v1', model: 'qwen3.8-flash', hasKey: true }
    const segments = [{ id: 0, text: 'Hello ' }, { id: 1, text: 'world' }]
    const input = { id: 'native-job', text: 'Hello world', segments }
    let finish = 'stop'
    let cancelled
    const bridge = createNativeBridge({
        settings: async () => settings,
        translate: async request => {
            assert.deepEqual(request.body, createTranslationRequest(settings, input))
            assert.equal(request.body.enable_thinking, false)
            return { status: 200, data: { choices: [{ finish_reason: finish, message: {
                content: '[{"id":0,"text":"你好"},{"id":1,"text":"世界"}]',
            } }] } }
        },
        cancel: async ({ id }) => { cancelled = id },
    })
    assert.deepEqual(JSON.parse(await bridge.translate(input)), [{ id: 0, text: '你好' }, { id: 1, text: '世界' }])
    finish = 'length'
    await assert.rejects(bridge.translate(input), /完整/)
    bridge.cancel('native-job')
    assert.equal(cancelled, 'native-job')
})

test('sync HTTP endpoints enforce local origin and never expose the stored token', async () => {
    const { createWebServer } = await import('../server/web.js')
    const directory = await mkdtemp(path.join(tmpdir(), 'foliate-sync-http-'))
    const secureStorage = createSecureStorage({ env: { FOLIATE_WEB_MASTER_KEY: randomBytes(32).toString('base64') } })
    const app = await createWebServer({ directory, secureStorage, port: 0,
        fetch: async url => new Response(JSON.stringify(url.endsWith('/owner/data') ? { private: true } : {}), { status: 200 }),
    })
    const url = new URL('/api/sync/settings', app.url)
    const put = { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository: 'owner/data', branch: 'main', token: 'http-test-secret' }) }
    try {
        assert.equal((await fetch(url, { ...put, headers: { ...put.headers, Origin: 'https://untrusted.example' } })).status, 403)
        const response = await fetch(url, put)
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { repository: 'owner/data', branch: 'main', hasToken: true })
        const exposed = await (await fetch(url)).text()
        assert.ok(!exposed.includes('http-test-secret'))
        const request = await fetch(new URL('/api/sync/request', app.url), { method: 'POST', headers: put.headers,
            body: JSON.stringify({ method: 'GET', path: 'reader-sync/manifest.json' }) })
        assert.equal(request.status, 200)
        assert.equal((await request.json()).status, 200)
        assert.equal((await fetch(new URL('/github-sync.json', app.url))).status, 404)
        assert.equal((await fetch(url, { method: 'DELETE' })).status, 200)
        assert.equal((await (await fetch(url)).json()).hasToken, false)
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native fallback hashes IDPF identifiers without changing the font key bytes', async () => {
    const { nativeSHA1 } = await import('../ui/native-bridge.js')
    const { createHash } = await import('node:crypto')
    const sha1 = nativeSHA1({ digest: async ({ algorithm, base64 }) => {
        assert.equal(algorithm, 'SHA-1')
        return { hash: createHash('sha1').update(Buffer.from(base64, 'base64')).digest('hex') }
    } })
    assert.deepEqual(await sha1('urn:uuid:个人阅读器'), new Uint8Array(createHash('sha1').update('urn:uuid:个人阅读器').digest()))
})

test('cache reset generations prevent old offline translations from being resurrected', () => {
    const old = { key: 'paragraph', text: '旧译文' }
    const fresh = { key: 'paragraph', text: '新译文' }
    const remote = new Map([[old.key, old]])
    const reset = mergeTranslationCaches({ generation: 'reset-A', reset: true }, [fresh], 'original', remote)
    assert.equal(reset.generation, 'reset-A')
    assert.deepEqual([...reset.entries.values()], [fresh])
    const staleDevice = mergeTranslationCaches({ generation: 'original', reset: false }, [old],
        'reset-A', new Map([[fresh.key, fresh]]))
    assert.equal(staleDevice.replaceLocal, true)
    assert.deepEqual([...staleDevice.entries.values()], [fresh])
    const same = mergeTranslationCaches({ generation: 'reset-A', reset: false }, [old, { key: 'next', text: '后文' }],
        'reset-A', new Map([[fresh.key, fresh]]))
    assert.deepEqual([...same.entries.values()], [fresh, { key: 'next', text: '后文' }])
})
