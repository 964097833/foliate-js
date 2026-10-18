import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, 'out/ios-web')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
// Explicit assets only: never include server configuration, books, Git, or tokens.
for (const entry of await readdir(root))
    if (entry.endsWith('.js') && !entry.endsWith('.config.js') || ['reader.html', 'LICENSE', 'ui', 'vendor'].includes(entry))
        await cp(path.join(root, entry), path.join(output, entry), { recursive: true })
await cp(path.join(root, 'node_modules/@capacitor/core/dist/index.js'),
    path.join(output, 'ui/capacitor-runtime.js'))
await cp(path.join(root, 'reader.html'), path.join(output, 'index.html'))
const html = await readFile(path.join(output, 'index.html'), 'utf8')
if (!html.includes("script-src 'self'")) throw new Error('Reader CSP is missing')
await writeFile(path.join(output, 'index.html'), html)
console.info(`iOS assets prepared: ${output}`)
