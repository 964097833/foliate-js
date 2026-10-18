import { execFileSync } from 'node:child_process'
import { chmod, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const installHooks = async root => {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    let configured = ''
    try { configured = git(['config', '--get', 'core.hooksPath']) } catch { /* Git returns 1 when unset. */ }
    if (configured && configured !== '.githooks')
        throw new Error(`已有 hooksPath=${configured}，保留原设置；请先整合现有 hooks。`)
    if (!configured) {
        const directory = path.resolve(root, git(['rev-parse', '--git-path', 'hooks']))
        const files = await readdir(directory).catch(error => {
            if (error.code === 'ENOENT') return []
            throw error
        })
        if (files.some(file => !file.endsWith('.sample')))
            throw new Error(`已有本地 hooks，保留原设置；请先整合 ${directory}`)
    }
    for (const name of ['pre-commit', 'pre-push']) await chmod(path.join(root, '.githooks', name), 0o755)
    git(['config', '--local', 'core.hooksPath', '.githooks'])
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await installHooks(fileURLToPath(new URL('../', import.meta.url)))
        console.info('已启用本仓库 hooks：提交前严格 lint，推送前完整 npm run check。')
    } catch (error) { console.error(error.message); process.exitCode = 1 }
}
