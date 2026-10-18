// Isolated browser-validation fixture: generated EPUB, encrypted temporary
// settings and a simulated model. No real API key or paid service is used.
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { createWebServer } from '../server/web.js'
import { createSecureStorage } from '../server/secure-storage.js'

export const createReaderFixture = async ({ readerPort = 0, modelPort = 0 } = {}) => {
    const directory = await mkdtemp(tmpdir() + '/foliate-web-validation-')
    const source = 'A quiet room changes the way we notice the world. Reading is rarely a race. We pause because each sentence helps us understand another voice. '
    const translated = '安静的房间会改变我们观察世界的方式。阅读很少是一场竞赛，我们在句子之间停留，理解另一种声音。'
    let requests = 0
    const upstream = createServer(async (req, res) => {
        if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ requests }))
            return
        }
        try {
            let body = ''
            for await (const chunk of req) body += chunk
            const text = JSON.parse(body).messages.at(-1).content
            requests++
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ choices: [{
                finish_reason: 'stop',
                message: { content: text.length > 150 ? translated.repeat(35) : `测试译文：${text}` },
            }] }))
        } catch {
            res.writeHead(400)
            res.end()
        }
    })
    let app
    let closing
    const close = () => closing ??= (async () => {
        try { await app?.close() }
        finally {
            upstream.closeAllConnections()
            try { await new Promise(resolve => upstream.close(resolve)) }
            finally { await rm(directory, { recursive: true, force: true }) }
        }
    })()
    try {
        await new Promise((resolve, reject) => {
            upstream.once('error', reject)
            upstream.listen(modelPort, '127.0.0.1', resolve)
        })
        app = await createWebServer({
            port: readerPort,
            directory,
            secureStorage: createSecureStorage({
                env: { FOLIATE_WEB_MASTER_KEY: randomBytes(32).toString('base64') },
            }),
        })
        const archive = {
            mimetype: 'application/epub+zip',
            'META-INF/container.xml': `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
                <rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
            'book.opf': `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
                <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">web-validation</dc:identifier>
                <dc:title>网页阅读回归测试</dc:title><dc:language>en</dc:language></metadata>
                <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
                <item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>
                <item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest>
                <spine><itemref idref="one"/><itemref idref="two"/></spine></package>`,
            'nav.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
                <head><title>Contents</title></head><body><nav epub:type="toc"><ol>
                <li><a href="one.xhtml">Chapter One</a></li><li><a href="two.xhtml">Chapter Two</a></li>
                </ol></nav></body></html>`,
            'one.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title></head><body>
                <h1>Chapter One</h1>${Array.from({ length: 6 }, (_, i) =>
        `<p id="p${i}">Passage ${i + 1}. ${source.repeat(6)}</p>`).join('')}</body></html>`,
            'two.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter Two</title></head><body>
                <h1>Chapter Two</h1><p>${source.repeat(12)}</p></body></html>`,
        }
        const book = directory + '/reader-validation.epub'
        await writeFile(book, zipSync(Object.fromEntries(Object.entries(archive)
            .map(([name, text]) => [name, strToU8(text)]))))
        const otherBook = directory + '/other-book.epub'
        const otherArchive = Object.fromEntries(Object.entries(archive).map(([name, text]) =>
            [name, strToU8(text.replaceAll('web-validation', 'other-book')
                .replaceAll('网页阅读回归测试', 'Another Book'))]))
        await writeFile(otherBook, zipSync(otherArchive))
        const formattedBook = directory + '/formatted-validation.epub'
        const formattedArchive = { ...archive,
            'book.opf': archive['book.opf'].replaceAll('web-validation', 'formatted-validation')
                .replaceAll('网页阅读回归测试', '网页格式回归测试'),
            'one.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Formatting</title></head><body>
                <h1 id="heading" style="font-weight:bold;text-align:center">Formatting title</h1>
                <h2 id="subheading">Formatting section</h2>
                <p id="emphasis" style="font-weight:bold;font-style:italic;text-align:center">Whole styled paragraph.</p>
                <p id="lines">First verse<br/><br/>Second verse</p>
                <pre id="pre">  Alpha\n\tBeta</pre>
                <p id="long"><strong>Risk-taking:</strong> First passage. ${source.repeat(6)}<br/>Second passage. ${source.repeat(6)}</p>
                </body></html>`,
        }
        await writeFile(formattedBook, zipSync(Object.fromEntries(Object.entries(formattedArchive)
            .map(([name, text]) => [name, strToU8(text)]))))
        const actualModelPort = upstream.address().port
        return {
            url: app.url, modelURL: `http://127.0.0.1:${actualModelPort}/v1`, book, otherBook, formattedBook,
            model: 'local-validation', testKey: 'local-test-only',
            stats: `http://127.0.0.1:${actualModelPort}/stats`,
            getRequests: () => requests,
            close,
        }
    } catch (error) {
        await close()
        throw error
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const readerPort = Number(process.argv[2] ?? 18790)
    const modelPort = Number(process.argv[3] ?? 18791)
    for (const port of [readerPort, modelPort])
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new Error('Ports must be integers between 1 and 65535.')
    const fixture = await createReaderFixture({ readerPort, modelPort })
    console.info(JSON.stringify(fixture, null, 2))
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        fixture.close().then(() => process.exit(0)).catch(error => {
            console.error(error)
            process.exit(1)
        })
    })
}
