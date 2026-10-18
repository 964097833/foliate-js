import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'
import { createSecureStorage } from '../server/secure-storage.js'
import { createWebServer } from '../server/web.js'
import { createHTTPBridge } from '../ui/http-bridge.js'

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

const deferred = () => {
    let resolve
    const promise = new Promise(done => resolve = done)
    return { promise, resolve }
}

const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
    })
})

const closeServer = server => new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(() => resolve())
})

const startUpstream = async () => {
    const requests = []
    let respond = async () => ({ content: '译文' })
    const server = createServer(async (req, res) => {
        try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            requests.push({ url: req.url, headers: req.headers, body })
            const result = await respond()
            if (res.destroyed || res.writableEnded) return
            if (result.status) {
                res.writeHead(result.status, { 'Content-Type': 'application/json' })
                res.end('{}')
                return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                choices: [{
                    message: { content: result.content ?? '译文' },
                    finish_reason: result.finishReason ?? 'stop',
                }],
            }))
        } catch {
            if (!res.headersSent) res.writeHead(500)
            res.end()
        }
    })
    await listen(server)
    return {
        server,
        requests,
        url: `http://127.0.0.1:${server.address().port}/v1`,
        setRespond: value => respond = value,
    }
}

const startWeb = async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'foliate-web-test-'))
    const app = await createWebServer({ directory, secureStorage: secureStorage(), port: 0 })
    return { app, directory, base: app.url.slice(0, -'/reader.html'.length) }
}

const api = async (base, path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${base}/api/translation${path}`, {
        method,
        headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, data: await response.json().catch(() => null) }
}

const raw = (port, path, headers = {}) => new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => body += chunk)
        response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.on('error', reject)
    request.end()
})

test('serves only reader assets on the loopback interface', async () => {
    const { app, directory, base } = await startWeb()
    try {
        const html = await fetch(app.url)
        assert.equal(html.status, 200)
        assert.match(html.headers.get('content-type'), /text\/html/)
        assert.match(await html.text(), /<title>/)
        const script = await fetch(`${base}/ui/http-bridge.js`)
        assert.equal(script.status, 200)
        assert.match(script.headers.get('content-type'), /text\/javascript/)
        const head = await fetch(`${base}/vendor/pdfjs/pdf.worker.mjs`, { method: 'HEAD' })
        assert.equal(head.status, 200)
        assert.equal(await head.text(), '')
        assert.equal((await fetch(`${base}/package.json`)).status, 404)
        assert.equal((await fetch(`${base}/README.md`)).status, 404)
        assert.equal((await raw(app.port, '/%2e%2e/package.json')).status, 404)
        assert.equal((await raw(app.port, '/reader.html', { Host: 'evil.example' })).status, 403)
    } finally {
        await app.close()
        await rm(directory, { recursive: true, force: true })
    }
})

test('persists encrypted settings and translates through the configured service', async () => {
    const upstream = await startUpstream()
    const { app, directory, base } = await startWeb()
    try {
        assert.deepEqual((await api(base, '/settings')).data,
            { url: '', model: '', hasKey: false })
        const invalid = await api(base, '/settings', {
            method: 'PUT',
            body: { url: 'javascript:alert(1)', model: 'mock-model', apiKey: 'key' },
        })
        assert.equal(invalid.status, 400)
        assert.match(invalid.data.error, /http 或 https/)
        const key = 'test-secret-key-only'
        const saved = await api(base, '/settings', {
            method: 'PUT',
            body: { url: upstream.url, model: 'mock-model', apiKey: key },
        })
        assert.deepEqual(saved.data, { url: upstream.url, model: 'mock-model', hasKey: true })
        const file = path.join(directory, 'translation-settings.json')
        assert.equal((await stat(file)).mode & 0o777, 0o600)
        const stored = await readFile(file, 'utf8')
        assert.equal(stored.includes(key), false)
        assert.equal(JSON.stringify((await api(base, '/settings')).data).includes(key), false)

        const translated = await api(base, '/translate', {
            method: 'POST',
            body: { id: 'paragraph-1', text: 'Untrusted passage' },
        })
        assert.deepEqual(translated.data, { translation: '译文' })
        const request = upstream.requests.at(-1)
        assert.equal(request.headers.authorization, `Bearer ${key}`)
        assert.equal(request.body.model, 'mock-model')
        assert.equal(request.body.stream, false)
        assert.equal(request.body.messages[1].content, 'Untrusted passage')
        assert.match(request.body.messages[0].content, /untrusted book content/)

        const kept = await api(base, '/settings', {
            method: 'PUT',
            body: { url: upstream.url, model: 'new-model' },
        })
        assert.equal(kept.data.hasKey, true)
        const changed = await api(base, '/settings', {
            method: 'PUT',
            body: { url: 'http://127.0.0.1:1/v1', model: 'new-model' },
        })
        assert.equal(changed.status, 400)
        assert.match(changed.data.error, /重新填写/)
        const cleared = await api(base, '/settings', { method: 'DELETE' })
        assert.equal(cleared.data.hasKey, false)
        await assert.rejects(stat(file), { code: 'ENOENT' })
    } finally {
        await app.close()
        await closeServer(upstream.server)
        await rm(directory, { recursive: true, force: true })
    }
})

test('rejects cross-origin, non-JSON, oversized, and duplicate requests', async () => {
    const upstream = await startUpstream()
    const { app, directory, base } = await startWeb()
    try {
        await api(base, '/settings', {
            method: 'PUT',
            body: { url: upstream.url, model: 'mock-model', apiKey: 'key' },
        })
        const crossOrigin = await api(base, '/settings', {
            method: 'PUT',
            headers: { Origin: 'https://evil.example' },
            body: { url: upstream.url, model: 'other', apiKey: 'key' },
        })
        assert.equal(crossOrigin.status, 403)
        const wrongType = await api(base, '/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body: { url: upstream.url, model: 'other', apiKey: 'key' },
        })
        assert.equal(wrongType.status, 415)
        const oversized = await api(base, '/translate', {
            method: 'POST',
            body: { id: 'large', text: 'x'.repeat(1024 * 1024 + 1) },
        })
        assert.equal(oversized.status, 413)
        assert.equal((await api(base, '/translate')).status, 405)
        assert.equal((await api(base, '/unknown')).status, 404)

        const received = deferred()
        upstream.setRespond(async () => {
            received.resolve()
            await delay(500)
            return { content: 'late' }
        })
        const first = api(base, '/translate', {
            method: 'POST',
            body: { id: 'duplicate', text: 'one' },
        })
        await received.promise
        const second = await api(base, '/translate', {
            method: 'POST',
            body: { id: 'duplicate', text: 'two' },
        })
        assert.equal(second.status, 400)
        assert.match(second.data.error, /重复/)
        assert.equal((await first).status, 200)
    } finally {
        await app.close()
        await closeServer(upstream.server)
        await rm(directory, { recursive: true, force: true })
    }
})

test('separate browser sessions can use the same paragraph id', async () => {
    const upstream = await startUpstream()
    const { app, directory, base } = await startWeb()
    try {
        await api(base, '/settings', {
            method: 'PUT',
            body: { url: upstream.url, model: 'mock-model', apiKey: 'key' },
        })
        upstream.setRespond(async () => {
            await delay(300)
            return { content: '译文' }
        })
        const one = api(base, '/translate', {
            method: 'POST',
            headers: { 'X-Foliate-Session': 'tab-a' },
            body: { id: 'shared', text: 'one' },
        })
        const two = api(base, '/translate', {
            method: 'POST',
            headers: { 'X-Foliate-Session': 'tab-b' },
            body: { id: 'shared', text: 'two' },
        })
        const deadline = Date.now() + 5000
        while (upstream.requests.length < 2 && Date.now() < deadline) await delay(50)
        assert.equal(upstream.requests.length, 2)
        assert.equal((await one).status, 200)
        assert.equal((await two).status, 200)
    } finally {
        await app.close()
        await closeServer(upstream.server)
        await rm(directory, { recursive: true, force: true })
    }
})

test('cancels an in-flight translation', async () => {
    const upstream = await startUpstream()
    const { app, directory, base } = await startWeb()
    try {
        await api(base, '/settings', {
            method: 'PUT',
            body: { url: upstream.url, model: 'mock-model', apiKey: 'key' },
        })
        const received = deferred()
        upstream.setRespond(async () => {
            received.resolve()
            await delay(300)
            return { content: 'late' }
        })
        const pending = api(base, '/translate', {
            method: 'POST',
            body: { id: 'cancel-me', text: 'slow passage' },
        })
        await received.promise
        const cancelled = await api(base, '/cancel', {
            method: 'POST',
            body: { id: 'cancel-me' },
        })
        assert.equal(cancelled.status, 200)
        const result = await pending
        assert.equal(result.status, 400)
        assert.match(result.data.error, /取消/)
    } finally {
        await app.close()
        await closeServer(upstream.server)
        await rm(directory, { recursive: true, force: true })
    }
})

test('the browser bridge uses the local API and keeps the key server-side', async () => {
    const upstream = await startUpstream()
    const { app, directory, base } = await startWeb()
    const nativeFetch = globalThis.fetch
    const nativeLocation = globalThis.location
    globalThis.location = { protocol: 'https:', hostname: 'example.com' }
    assert.equal(createHTTPBridge(), null)
    globalThis.location = { protocol: 'http:', hostname: '127.0.0.1' }
    globalThis.fetch = (url, options) => nativeFetch(new URL(url, base), options)
    try {
        const bridge = createHTTPBridge()
        assert.ok(bridge)
        assert.deepEqual(await bridge.getSettings(), { url: '', model: '', hasKey: false })
        const saved = await bridge.saveSettings({
            url: upstream.url,
            model: 'bridge-model',
            apiKey: 'bridge-key',
        })
        assert.deepEqual(saved, { url: upstream.url, model: 'bridge-model', hasKey: true })
        assert.equal(await bridge.translate({ id: 'bridge-1', text: 'Bridge passage' }), '译文')
        assert.equal(upstream.requests.at(-1).headers.authorization, 'Bearer bridge-key')
        const segments = [{ id: 0, text: 'Bridge ' }, { id: 1, text: 'emphasis' }]
        const structured = [{ id: 0, text: '桥接' }, { id: 1, text: '强调' }]
        upstream.setRespond(async () => ({ content: JSON.stringify(structured) }))
        assert.deepEqual(JSON.parse(await bridge.translate({
            id: 'bridge-format', text: 'Bridge emphasis', segments,
        })), structured)
        assert.deepEqual(JSON.parse(upstream.requests.at(-1).body.messages[1].content), {
            text: 'Bridge emphasis', segments,
        })
        await assert.rejects(bridge.saveSettings({ url: 'not-a-url', model: 'other' }),
            /http 或 https/)
        await bridge.clearSettings()
        assert.deepEqual(await bridge.getSettings(), { url: '', model: '', hasKey: false })
    } finally {
        globalThis.fetch = nativeFetch
        if (nativeLocation === undefined) delete globalThis.location
        else globalThis.location = nativeLocation
        await app.close()
        await closeServer(upstream.server)
        await rm(directory, { recursive: true, force: true })
    }
})

test('encrypts with a configured master key without the Keychain', async () => {
    const storage = createSecureStorage({
        env: { FOLIATE_WEB_MASTER_KEY: randomBytes(32).toString('base64') },
        platform: 'linux',
    })
    assert.equal(await storage.isAsyncEncryptionAvailable(), true)
    const encrypted = await storage.encryptStringAsync('secret value')
    assert.equal(encrypted.includes(Buffer.from('secret value')), false)
    assert.equal((await storage.decryptStringAsync(encrypted)).result, 'secret value')
})
