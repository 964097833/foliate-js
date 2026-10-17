import { app, BrowserWindow, dialog, Menu, net, protocol, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const appURL = 'foliate://app/reader.html'
const extensions = ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'zip', 'cbz', 'pdf']
const pendingFiles = []

app.setName('Foliate Reader')
protocol.registerSchemesAsPrivileged([{
    scheme: 'foliate',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])

const openExternal = url => {
    if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol))
        shell.openExternal(url).catch(error => console.error(error))
}

// Each window can read only its selected book and the bundled reader resources.
const handleRequest = bookPath => async request => {
    try {
        const url = new URL(request.url)
        if (url.host !== 'app' || !['GET', 'HEAD'].includes(request.method))
            return new Response('Not found', { status: 404 })

        const pathname = decodeURIComponent(url.pathname)
        const isBook = bookPath && pathname === `/book/${path.basename(bookPath)}`
        let filePath
        if (isBook) filePath = bookPath
        else {
            const root = app.getAppPath()
            filePath = path.resolve(root, `.${pathname}`)
            const relative = path.relative(root, filePath)
            const isAsset = /^(reader\.html|[^/]+\.js|(?:ui|vendor)\/.+)$/.test(relative)
            if (!isAsset || relative.startsWith('..') || path.isAbsolute(relative))
                return new Response('Not found', { status: 404 })
        }
        const response = await net.fetch(pathToFileURL(filePath).href, { method: request.method })
        const headers = new Headers(response.headers)
        headers.set('X-Content-Type-Options', 'nosniff')
        if (isBook) headers.set('Content-Type', 'application/octet-stream')
        return new Response(response.body, { status: response.status, headers })
    } catch {
        return new Response('Not found', { status: 404 })
    }
}

const createWindow = bookPath => {
    const readerSession = session.fromPartition(`reader-${randomUUID()}`)
    readerSession.protocol.handle('foliate', handleRequest(bookPath))
    readerSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    readerSession.setPermissionCheckHandler(() => false)
    const window = new BrowserWindow({
        width: 1100,
        height: 800,
        minWidth: 600,
        minHeight: 400,
        title: 'Foliate Reader',
        backgroundColor: '#ffffff',
        webPreferences: {
            session: readerSession,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
        },
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url)
        return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
        event.preventDefault()
        openExternal(url)
    })
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.on('closed', () => readerSession.protocol.unhandle('foliate'))

    const url = new URL(appURL)
    if (bookPath) url.searchParams.set('url', `foliate://app/book/${encodeURIComponent(path.basename(bookPath))}`)
    window.loadURL(url.href).catch(error => dialog.showErrorBox('Unable to load reader', error.message))
    return window
}

const openBook = async filePath => {
    try {
        if (!(await stat(filePath)).isFile()) throw new Error('Please select an e-book file.')
        createWindow(path.resolve(filePath))
    } catch (error) {
        dialog.showErrorBox('Unable to open book', error.message)
    }
}

const chooseBook = async () => {
    const options = {
        title: 'Open E-Book',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'E-books', extensions }, { name: 'All Files', extensions: ['*'] }],
    }
    const window = BrowserWindow.getFocusedWindow()
    const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options))
    for (const filePath of result.filePaths) await openBook(filePath)
}

app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (app.isReady()) openBook(filePath)
    else pendingFiles.push(filePath)
})

app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        {
            label: 'File',
            submenu: [
                { label: 'Open E-Book…', accelerator: 'CmdOrCtrl+O', click: chooseBook },
                { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
                { type: 'separator' },
                { role: 'close' },
            ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
    ]))
    const args = process.argv.slice(app.isPackaged ? 1 : 2)
    pendingFiles.push(...args.filter(arg => path.isAbsolute(arg) && extensions.includes(path.extname(arg).slice(1).toLowerCase())))
    if (pendingFiles.length) pendingFiles.splice(0).forEach(filePath => openBook(filePath))
    else createWindow()
    app.on('activate', () => {
        if (!BrowserWindow.getAllWindows().length) createWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
