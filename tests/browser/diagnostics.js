import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const records = new WeakMap()
export const observePage = page => {
    const record = { requests: 0, finished: 0, failed: 0, events: [] }
    records.set(page, record)
    const isTranslation = request => new URL(request.url()).pathname === '/api/translation/translate'
    const event = (type, extra = {}) => {
        record.events.push({ time: Date.now(), type, ...extra })
        if (record.events.length > 25) record.events.shift()
    }
    page.on('request', request => { if (isTranslation(request)) { record.requests++; event('translation-request') } })
    page.on('requestfinished', request => { if (isTranslation(request)) { record.finished++; event('translation-finished') } })
    page.on('requestfailed', request => { if (isTranslation(request)) { record.failed++; event('translation-failed') } })
    page.on('pageerror', error => event('pageerror', { message: error.message }))
}

export const collectReaderState = async page => {
    if (page.isClosed()) return { closed: true, transport: records.get(page) }
    let timer
    try {
        const state = await Promise.race([page.evaluate(() => {
            const reader = globalThis.reader
            const view = reader?.view
            const location = view?.lastLocation
            const range = location?.range
            const node = range?.startContainer
            const position = reader?.translation?.getPosition()
            const clip = view?.getBoundingClientRect()
            return {
                state: document.documentElement.dataset.readerState ?? 'not-a-reader',
                generation: document.documentElement.dataset.readerGeneration,
                events: globalThis.__foliateReaderEvents ?? [],
                title: document.querySelector('#header-title')?.textContent,
                mode: document.querySelector('#reading-mode')?.value,
                flow: view?.renderer?.getAttribute('flow'), cfi: location?.cfi,
                range: node ? { nodeType: node.nodeType, tag: node.localName ?? node.parentElement?.localName,
                    offset: range.startOffset, textLength: node.nodeType === 3 ? node.length : undefined } : null,
                position: position ? { paragraph: position.key.split(':').slice(0, 2).join(':'),
                    offset: position.offset, viewportOffset: position.viewportOffset } : null,
                translation: reader?.translation?.getDiagnostics(),
                frames: (view?.renderer?.getContents() ?? []).map(({ doc, index }) => {
                    const frame = doc.defaultView.frameElement.getBoundingClientRect()
                    const images = Array.from(doc.querySelectorAll('img'))
                    return { index, readyState: doc.readyState, fonts: doc.fonts?.status,
                        images: { total: images.length, loaded: images.filter(image => image.complete && image.naturalWidth).length },
                        visible: Array.from(doc.querySelectorAll('[data-foliate-paragraph]')).flatMap(element => {
                            const rects = Array.from(element.getClientRects()).map(rect => ({
                                left: frame.left + rect.left, top: frame.top + rect.top,
                                width: rect.width, height: rect.height,
                            })).filter(rect => clip && rect.left < clip.right && rect.left + rect.width > clip.left
                                && rect.top < clip.bottom && rect.top + rect.height > clip.top)
                            return rects.length ? [{ paragraph: element.getAttribute('data-foliate-paragraph'),
                                tag: element.localName, complete: element.hasAttribute('data-foliate-complete'), rects: rects.slice(0, 3) }] : []
                        }).slice(0, 20) }
                }),
            }
        }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reader snapshot timed out')), 3000) })])
        return { ...state, transport: records.get(page) }
    } catch (error) { return { error: error.message, transport: records.get(page) } }
    finally { clearTimeout(timer) }
}

const snapshotCounts = new WeakMap()
export const attachFailureSnapshots = async (context, testInfo) => {
    for (const page of context.pages()) {
        const index = snapshotCounts.get(testInfo) ?? 0
        snapshotCounts.set(testInfo, index + 1)
        const filename = index ? `reader-state-${index}.json` : 'reader-state.json'
        const file = testInfo.outputPath(filename)
        try {
            await mkdir(path.dirname(file), { recursive: true })
            await writeFile(file, JSON.stringify(await collectReaderState(page), null, 2) + '\n')
            await testInfo.attach(filename, { path: file, contentType: 'application/json' })
            if (!page.isClosed()) {
                const screenshot = testInfo.outputPath(`reader-failure-${index}.png`)
                await page.screenshot({ path: screenshot, timeout: 3000 })
                await testInfo.attach('reader-failure', { path: screenshot, contentType: 'image/png' })
            }
        } catch { /* Diagnostics must not replace the original test failure. */ }
    }
}
