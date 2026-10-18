import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const processExists = pid => {
    try { process.kill(pid, 0); return true }
    catch (error) { return error.code === 'EPERM' }
}

const ownerOf = async directory => {
    const files = await readdir(directory)
    if (files.length !== 1) throw new Error(`验收锁正在初始化或记录无效，请检查 ${directory}`)
    const file = path.join(directory, files[0])
    const owner = JSON.parse(await readFile(file, 'utf8'))
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string')
        throw new Error(`验收锁记录无效：${directory}`)
    return { owner, file }
}
const removeOwner = async (directory, file) => {
    try { await unlink(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
    // Another owner has a different token filename, so it keeps this nonempty.
    try { await rmdir(directory) }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
}

export const createRun = async (root, command) => {
    const directory = path.join(root, '.verification')
    const lockDirectory = path.join(directory, 'browser.lock')
    await mkdir(directory, { recursive: true })
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    const run = { id, token: randomUUID(), pid: process.pid, command,
        startedAt: new Date().toISOString(), root,
        directory: path.join(directory, 'runs', id),
        resultsDirectory: path.join(root, 'test-results', id),
        reportDirectory: path.join(root, 'playwright-report', id),
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        try { await mkdir(lockDirectory) }
        catch (error) {
            if (error.code !== 'EEXIST') throw error
            const { owner, file } = await ownerOf(lockDirectory)
            if (processExists(owner.pid)) throw new Error(
                `浏览器验收已在运行（PID ${owner.pid}，${owner.command}）。\n报告：${owner.reportDirectory}`)
            await removeOwner(lockDirectory, file)
            continue
        }
        const identity = await stat(lockDirectory)
        const file = path.join(lockDirectory, run.token + '.json')
        try {
            await writeFile(file, JSON.stringify(run), { flag: 'wx' })
            const current = await stat(lockDirectory)
            if (identity.ino !== current.ino || identity.dev !== current.dev)
                throw new Error('验收锁在初始化时被更新，请重新运行。')
            await mkdir(run.directory, { recursive: true })
            return { ...run, release: () => removeOwner(lockDirectory, file) }
        } catch (error) { await removeOwner(lockDirectory, file); throw error }
    }
    throw new Error('验收锁被其他进程更新，请重新运行。')
}

export const getBrowserRun = async () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    let run
    try { ({ owner: run } = await ownerOf(path.join(root, '.verification/browser.lock'))) }
    catch { /* Give direct Playwright invocations one actionable error. */ }
    if (!run || run.token !== process.env.FOLIATE_VERIFICATION_TOKEN || !processExists(run.pid))
        throw new Error('请使用 npm run test:browser -- [Playwright 参数] 或 npm run check，验收入口会保护报告目录。')
    return run
}
