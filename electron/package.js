import { packager } from '@electron/packager'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('Build the macOS app on a Mac.')

const output = await packager({
    dir: fileURLToPath(new URL('../', import.meta.url)),
    name: 'Foliate Reader',
    executableName: 'Foliate Reader',
    appBundleId: 'io.github.foliate-js.reader',
    appCategoryType: 'public.app-category.books',
    platform: 'darwin',
    arch: process.arch,
    out: 'out',
    overwrite: true,
    asar: true,
    ignore: [
        /^\/(out|tests|rollup|node_modules|\.git|\.idea|\.github)(\/|$)/,
        /^\/(AGENTS\.md|eslint\.config\.js|rollup\.config\.js|package-lock\.json)$/,
        /^\/electron\/package\.js$/,
    ],
    extendInfo: {
        CFBundleDocumentTypes: [{
            CFBundleTypeName: 'E-book',
            CFBundleTypeRole: 'Viewer',
            LSHandlerRank: 'Alternate',
            CFBundleTypeExtensions: ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'cbz', 'pdf'],
        }],
    },
})

for (const directory of output) console.info(`${directory}/Foliate Reader.app`)
