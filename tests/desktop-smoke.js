import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'

const root = fileURLToPath(new URL('../', import.meta.url))
const executable = path.join(root, `out/Foliate Reader-darwin-${process.arch}/Foliate Reader.app/Contents/MacOS/Foliate Reader`)
const temporary = await mkdtemp(path.join(tmpdir(), 'foliate-smoke-'))
const profile = path.join(temporary, 'profile')
const fixturePath = process.argv[2]
const bookPath = fixturePath ? path.resolve(fixturePath) : path.join(temporary, '阅读测试 #1.epub')
const archive = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': `<?xml version="1.0"?>
        <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
        <rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    'book.opf': `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="id">smoke-test</dc:identifier><dc:title>Mac 阅读验证</dc:title>
        <dc:language>zh</dc:language><dc:creator>Foliate Test</dc:creator></metadata>
        <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="one" href="one.xhtml" media-type="application/xhtml+xml"/>
        <item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest>
        <spine><itemref idref="one"/><itemref idref="two"/></spine></package>`,
    'nav.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
        <head><title>Contents</title></head><body><nav epub:type="toc"><ol>
        <li><a href="one.xhtml">第一章</a></li><li><a href="two.xhtml">第二章</a></li></ol></nav></body></html>`,
}
for (const [name, title] of [['one', '第一章'], ['two', '第二章']])
    archive[`${name}.xhtml`] = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
        <body><h1>${title}</h1><script>parent.__bookScriptExecuted = true</script>
        ${Array.from({ length: 80 }, (_, i) => `<p>${title}，第 ${i + 1} 段。离线电子书阅读与分页验证。</p>`).join('')}</body></html>`
if (!fixturePath) await writeFile(bookPath, zipSync(Object.fromEntries(
    Object.entries(archive).map(([name, text]) => [name, strToU8(text)]))))

const waitFor = async (action, description) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
        const result = await action()
        if (result) return result
        await delay(100)
    }
    throw new Error(`Timed out: ${description}`)
}

// Drive the packaged Chromium renderer through its loopback-only debugging port.
const child = spawn(executable, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, bookPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
})
let logs = ''
child.stderr.on('data', chunk => logs += chunk)
let socket
let evaluate
const consoleErrors = []
try {
    const port = await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`App exited: ${logs}`)
        try { return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] }
        catch { return null }
    }, 'app debugging port')
    const targets = await waitFor(async () => {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        return targets.find(target => target.type === 'page' && target.url.startsWith('foliate://app/reader.html'))
    }, 'reader window')
    socket = new WebSocket(targets.webSocketDebuggerUrl)
    await once(socket, 'open')
    let id = 0
    const pending = new Map()
    const exceptions = []
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data)
        if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
        if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
            consoleErrors.push(message.params.args.map(arg => arg.description ?? arg.value).join(' '))
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        if (message.error) request.reject(new Error(JSON.stringify(message.error)))
        else request.resolve(message.result)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const requestId = ++id
        pending.set(requestId, { resolve, reject })
        socket.send(JSON.stringify({ id: requestId, method, params }))
    })
    evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
        return result.result.value
    }
    await send('Runtime.enable')
    const hasChapter = chapter => evaluate(`globalThis.reader?.view?.renderer?.getContents()
        .some(({ doc }) => doc.body?.textContent.includes('${chapter}'))`)
    const hasContent = () => evaluate(`globalThis.reader?.view?.renderer?.getContents()
        .some(({ doc }) => doc.body && (doc.body.textContent.trim()
            || doc.images.length || doc.querySelector('svg image')))`)
    await waitFor(hasContent, 'book rendering')
    await waitFor(() => evaluate('!!reader.view.lastLocation'), 'reading location')
    const title = await evaluate('document.title')
    assert.ok(title.trim() && title !== 'E-Book Reader', 'Book metadata supplies the window title')
    if (!fixturePath) assert.equal(title, 'Mac 阅读验证')
    assert.deepEqual(await evaluate(`({ node: typeof process, require: typeof require,
        secure: isSecureContext && !!crypto.subtle, script: !!globalThis.__bookScriptExecuted })`), {
        node: 'undefined', require: 'undefined', secure: true, script: false,
    })
    if (fixturePath) {
        const toc = await evaluate(`(() => {
            const flatten = items => items.flatMap(({ label, href, subitems }) =>
                [{ label, href }, ...flatten(subitems ?? [])])
            return flatten(reader.view.book.toc ?? [])
        })()`)
        assert.ok(toc.length > 1, 'Book has a navigable table of contents')
        const images = new Set()
        for (const item of toc) {
            const index = await evaluate(`(async () => {
                const target = await reader.view.resolveNavigation(${JSON.stringify(item.href)})
                await reader.view.goTo(${JSON.stringify(item.href)})
                return target.index
            })()`)
            await waitFor(async () => {
                await evaluate(`reader.view.goTo(${JSON.stringify(item.href)})`)
                return evaluate(`reader.view.renderer.getContents().some(content =>
                    content.index === ${index} && content.doc.body?.textContent.trim()
                    && Array.from(content.doc.images).every(image => image.complete && image.naturalWidth > 0))`)
            }, `chapter and images: ${item.label}`)
            const sources = await evaluate(`reader.view.renderer.getContents()
                .flatMap(({ doc }) => Array.from(doc.images, image => image.src))`)
            for (const source of sources) images.add(source)
        }
        console.info(`PASS: ${title}: ${await evaluate('reader.view.book.sections.length')} sections; ${toc.length} TOC entries navigated; ${images.size} chapter images loaded.`)
        const chapter = toc.find(item => /^chapter\s+1\b/i.test(item.label)) ?? toc[0]
        await evaluate(`reader.view.goTo(${JSON.stringify(chapter.href)})`)
    }
    const before = await evaluate('reader.view.lastLocation.cfi')
    await waitFor(async () => {
        await evaluate('reader.view.goRight()')
        return (await evaluate('reader.view.lastLocation.cfi')) !== before
    }, 'next page')
    if (!fixturePath) {
        await evaluate('reader.view.goTo(reader.view.book.toc[1].href)')
        await waitFor(() => hasChapter('第二章'), 'table of contents navigation')
    }
    for (const resource of ['electron/main.js', 'package.json', 'vendor/%2e%2e%2fpackage.json', 'book/unselected.epub'])
        assert.equal(await evaluate(`fetch('foliate://app/${resource}').then(response => response.status)`), 404)
    for (const resource of ['vendor/pdfjs/pdf.mjs', 'vendor/pdfjs/pdf.worker.mjs', 'vendor/pdfjs/text_layer_builder.css'])
        assert.equal(await evaluate(`fetch('foliate://app/${resource}').then(response => response.status)`), 200)

    await send('Page.navigate', { url: 'foliate://app/reader.html' })
    await waitFor(() => evaluate('!!document.querySelector(\'#file-input\') && !location.search'), 'empty reader')
    const { root: document } = await send('DOM.getDocument')
    const { nodeId } = await send('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' })
    await send('DOM.setFileInputFiles', { nodeId, files: [bookPath] })
    await waitFor(hasContent, 'file picker reading')
    assert.equal(await evaluate('document.title'), title)
    assert.deepEqual(exceptions, [], 'No uncaught renderer exceptions')
    assert.deepEqual(consoleErrors, [], 'No renderer console errors')
    console.info('PASS: packaged app opens the EPUB, renders pages, turns pages, navigates chapters, and opens a selected file.')
    console.info('PASS: secure context, Node isolation, restricted local files, and bundled PDF.js assets.')
    if (!fixturePath) console.info('PASS: embedded book scripts are blocked.')
} catch (error) {
    console.error(logs)
    console.error(consoleErrors)
    if (evaluate) console.error(await evaluate(`({ title: document.title,
        contents: globalThis.reader?.view?.renderer?.getContents().map(({ index, doc }) => ({
            index, textLength: doc.body?.textContent.trim().length,
            images: Array.from(doc.images, image => ({ complete: image.complete, width: image.naturalWidth })),
        })),
    })`))
    throw error
} finally {
    socket?.close()
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    if (child.exitCode === null) await exited
    await rm(temporary, { recursive: true, force: true })
}
