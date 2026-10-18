import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TranslationService } from './translation.js'
import { createSecureStorage } from './secure-storage.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const defaultPort = 8787
const maxBody = 1024 * 1024
const defaultOwner = 'web'
const debug = process.env.FOLIATE_WEB_DEBUG === '1'
const assets = /^(?:reader\.html|[^/]+\.js|(?:ui|vendor)\/.+)$/
const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.ico', 'image/x-icon'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
    ['.ttf', 'font/ttf'],
    ['.otf', 'font/otf'],
    ['.wasm', 'application/wasm'],
    ['.bcmap', 'application/octet-stream'],
])

export const defaultDataDirectory = () => process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', 'Foliate Reader Web')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'foliate-reader-web')

const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
    })
    res.end(body)
}

const sendJSON = (res, status, value, headers = {}) => {
    const body = JSON.stringify(value)
    send(res, status, body, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
    })
}

const fail = (res, status, message) => sendJSON(res, status, { error: message })

const statusError = (status, message) => Object.assign(new Error(message), { status })

const methodNotAllowed = (res, allow) => {
    res.setHeader('Allow', allow.join(', '))
    return fail(res, 405, '不支持此请求方法。')
}

const readJSON = async req => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
        size += chunk.length
        if (size > maxBody) {
            req.resume()
            throw statusError(413, '请求内容过大。')
        }
        chunks.push(chunk)
    }
    if (!chunks.length) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw statusError(400, '请求内容不是有效的 JSON。') }
}

const requireJSON = req => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? ''))
        throw statusError(415, '请求内容必须为 JSON。')
}

const allowedHosts = server => {
    const port = server.address()?.port
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`])
}

const isLocalRequest = (req, server) => allowedHosts(server).has(req.headers.host ?? '')

const isSameOrigin = (req, server) => {
    const site = req.headers['sec-fetch-site']
    if (site && !['same-origin', 'none'].includes(site)) return false
    const origin = req.headers.origin
    if (!origin) return true
    const port = server.address()?.port
    return [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)
}

const serveAsset = async (req, res, pathname, rootReal) => {
    let decoded
    try { decoded = decodeURIComponent(pathname) }
    catch { return fail(res, 400, '路径无效。') }
    if (decoded.includes('\0')) return fail(res, 400, '路径无效。')
    let relative = path.posix.normalize(decoded === '/' ? '/reader.html' : decoded)
        .replace(/^\/+/, '')
    if (!relative || relative.startsWith('../') || relative.includes('/../') || !assets.test(relative))
        return fail(res, 404, 'Not found')
    const file = path.resolve(root, relative)
    const inside = path.relative(root, file)
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside))
        return fail(res, 404, 'Not found')
    try {
        const real = await realpath(file)
        if (real !== rootReal && !real.startsWith(rootReal + path.sep))
            return fail(res, 404, 'Not found')
        const info = await stat(real)
        if (!info.isFile()) return fail(res, 404, 'Not found')
        const body = req.method === 'HEAD' ? null : await readFile(real)
        send(res, 200, body, {
            'Content-Type': contentTypes.get(path.extname(relative).toLowerCase()) ?? 'application/octet-stream',
            'Content-Length': info.size,
            'Cache-Control': 'no-cache',
        })
    } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code))
            return fail(res, 404, 'Not found')
        throw error
    }
}

const handleAPI = async (req, res, pathname, service, owner) => {
    if (pathname === '/api/translation/health') {
        if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
        return sendJSON(res, 200, { ok: true })
    }
    if (pathname === '/api/translation/settings') {
        if (req.method === 'GET') return sendJSON(res, 200, await service.getSettings())
        if (req.method === 'DELETE') return sendJSON(res, 200, await service.clearSettings())
        if (req.method !== 'PUT') return methodNotAllowed(res, ['GET', 'PUT', 'DELETE'])
        requireJSON(req)
        return sendJSON(res, 200, await service.saveSettings(await readJSON(req)))
    }
    if (pathname === '/api/translation/translate') {
        if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
        requireJSON(req)
        const body = await readJSON(req)
        const length = typeof body?.text === 'string' ? body.text.length : 0
        const started = Date.now()
        try {
            const translation = await service.translate(owner, { id: body?.id, text: body?.text })
            if (debug) console.info(`[translate] ${length} chars in ${Date.now() - started}ms`)
            return sendJSON(res, 200, { translation })
        } catch (error) {
            if (debug) console.warn(`[translate] ${length} chars failed in ${Date.now() - started}ms: ${error.message}`)
            throw error
        }
    }
    if (pathname === '/api/translation/cancel') {
        if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
        requireJSON(req)
        const body = await readJSON(req)
        if (typeof body?.id !== 'string' || body.id.length > 128)
            throw statusError(400, '请求编号无效。')
        service.cancel(owner, body.id)
        return sendJSON(res, 200, { ok: true })
    }
    return fail(res, 404, '接口不存在。')
}

const handle = async (req, res, { service, server, rootReal }) => {
    let api = false
    try {
        if (!isLocalRequest(req, server)) {
            req.resume()
            return fail(res, 403, '只允许本机访问。')
        }
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        api = pathname === '/api' || pathname.startsWith('/api/')
        if (api) {
            if (['POST', 'PUT', 'DELETE'].includes(req.method) && !isSameOrigin(req, server)) {
                req.resume()
                return fail(res, 403, '请求来源无效。')
            }
            const session = req.headers['x-foliate-session']
            const owner = typeof session === 'string' && /^[\w-]{1,64}$/.test(session)
                ? session : defaultOwner
            return await handleAPI(req, res, pathname, service, owner)
        }
        if (!['GET', 'HEAD'].includes(req.method)) {
            res.setHeader('Allow', 'GET, HEAD')
            return fail(res, 405, '不支持此请求方法。')
        }
        return await serveAsset(req, res, pathname, rootReal)
    } catch (error) {
        req.resume()
        if (res.headersSent) {
            res.destroy()
            return
        }
        const status = error.status ?? (api ? 400 : 500)
        if (status >= 500) console.error(error)
        fail(res, status, status >= 500 ? '服务器内部错误。' : error.message)
    }
}

export const createWebServer = async ({
    directory = process.env.FOLIATE_WEB_DATA_DIR || defaultDataDirectory(),
    secureStorage = createSecureStorage(),
    fetch,
    port = defaultPort,
} = {}) => {
    const rootReal = await realpath(root)
    const service = new TranslationService({
        directory,
        secureStorage,
        fetch,
        onSettingsChange: () => {},
    })
    let server
    server = createServer((req, res) => handle(req, res, { service, server, rootReal }))
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject)
            resolve()
        })
    })
    const actual = server.address().port
    const close = async () => {
        service.cancelAll()
        server.closeAllConnections?.()
        await new Promise(resolve => server.close(() => resolve()))
    }
    return {
        server,
        service,
        port: actual,
        url: `http://127.0.0.1:${actual}/reader.html`,
        close,
    }
}

const usage = `Usage: node server/web.js [options]

Options:
  -p, --port <port>       Port to listen on (default: ${defaultPort})
      --data-dir <path>   Directory for translation settings
  -h, --help              Show this help
`

const parseArgs = args => {
    const options = {
        port: Number(process.env.PORT ?? defaultPort),
        directory: process.env.FOLIATE_WEB_DATA_DIR || defaultDataDirectory(),
    }
    for (let index = 0; index < args.length; index++) {
        const argument = args[index]
        if (argument === '-h' || argument === '--help') return { help: true }
        if (argument === '-p' || argument === '--port') options.port = Number(args[++index])
        else if (argument === '--data-dir') options.directory = path.resolve(args[++index] ?? '')
        else throw new Error(`Unknown option: ${argument}`)
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
        throw new Error('Port must be an integer between 0 and 65535.')
    return options
}

const start = async () => {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        console.info(usage)
        return
    }
    let app
    try { app = await createWebServer(options) }
    catch (error) {
        if (error.code === 'EADDRINUSE')
            throw new Error(`Port ${options.port} is in use. Choose another port with --port.`)
        throw error
    }
    console.info(`Foliate Reader Web: ${app.url}`)
    console.info(`Translation settings: ${options.directory}`)
    const storage = process.env.FOLIATE_WEB_MASTER_KEY
        ? 'FOLIATE_WEB_MASTER_KEY'
        : process.platform === 'darwin'
            ? 'macOS Keychain'
            : 'unavailable (set FOLIATE_WEB_MASTER_KEY)'
    console.info(`API key encryption: ${storage}`)
    let closing = false
    const shutdown = async () => {
        if (closing) return
        closing = true
        await app.close()
        process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    start().catch(error => {
        console.error(error.message)
        process.exit(1)
    })
