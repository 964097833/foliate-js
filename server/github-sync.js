import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export const validateSyncSettings = input => {
    const repository = typeof input?.repository === 'string' ? input.repository.trim() : ''
    const branch = typeof input?.branch === 'string' ? input.branch.trim() : 'main'
    if (!/^[\w-]+\/[\w.-]+$/.test(repository) || repository.split('/')[1] === '..')
        throw new Error('仓库格式应为 用户名/仓库名。')
    if (!/^[\w./-]{1,100}$/.test(branch) || branch.includes('..'))
        throw new Error('分支名称无效。')
    return { repository, branch }
}

export const validateSyncRequest = input => {
    if (!['GET', 'PUT'].includes(input?.method)
        || !/^reader-sync\/(?:manifest\.json|objects\/[a-f0-9]{64}\.json)$/.test(input?.path))
        throw new Error('同步请求无效。')
    if (input.method === 'PUT' && (typeof input.content !== 'string'
        || input.content.length > 800000 || !/^[A-Za-z0-9+/=]*$/.test(input.content)
        || input.sha !== undefined && !/^[a-f0-9]{40,64}$/.test(input.sha)))
        throw new Error('同步内容无效或过大。')
    return input
}

export class GitHubSyncService {
    #file
    #storage
    #fetch
    #writes = Promise.resolve()
    constructor({ directory, secureStorage, fetch = globalThis.fetch }) {
        this.#file = path.join(directory, 'github-sync.json')
        this.#storage = secureStorage
        this.#fetch = fetch
    }
    async #load() {
        try { return JSON.parse(await readFile(this.#file, 'utf8')) }
        catch (error) {
            if (error.code === 'ENOENT') return null
            throw new Error('无法读取 GitHub 配置，请重新保存。')
        }
    }
    async getSettings() {
        const value = await this.#load()
        return value ? { repository: value.repository, branch: value.branch, hasToken: true }
            : { repository: '', branch: 'main', hasToken: false }
    }
    saveSettings(input) {
        const operation = this.#writes.catch(() => {}).then(async () => {
            const settings = validateSyncSettings(input)
            const old = await this.#load()
            if (input.token !== undefined && typeof input.token !== 'string') throw new Error('GitHub Token 无效。')
            const token = input.token?.trim()
            if (token !== undefined && (typeof token !== 'string' || /[\r\n]/.test(token) || token.length > 8192))
                throw new Error('GitHub Token 无效。')
            if (!token && (!old || old.repository !== settings.repository))
                throw new Error('首次配置或更换仓库时请填写 GitHub Token。')
            const encryptedToken = token
                ? (await this.#storage.encryptStringAsync(token)).toString('base64') : old.encryptedToken
            const temporary = `${this.#file}.${randomUUID()}.tmp`
            try {
                await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 })
                await writeFile(temporary, JSON.stringify({ ...settings, encryptedToken }), { mode: 0o600, flag: 'wx' })
                await rename(temporary, this.#file)
            } finally { await rm(temporary, { force: true }).catch(() => {}) }
            return { ...settings, hasToken: true }
        })
        this.#writes = operation
        return operation
    }
    async clearSettings() {
        await this.#writes.catch(() => {})
        await rm(this.#file, { force: true })
        return this.getSettings()
    }
    async request(input) {
        validateSyncRequest(input)
        const settings = await this.#load()
        if (!settings) throw new Error('请先配置 GitHub 同步。')
        const { repository, branch } = validateSyncSettings(settings)
        const token = (await this.#storage.decryptStringAsync(Buffer.from(settings.encryptedToken, 'base64'))).result
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Foliate-Personal-Reader' }
        const base = `https://api.github.com/repos/${repository}`
        // Refuse public repositories before uploading personal books or translations.
        const info = await this.#fetch(base, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) })
        if (!info.ok) throw new Error('无法访问 GitHub 仓库，请检查仓库名及 Token 权限。')
        if ((await info.json()).private !== true) throw new Error('书籍同步仅支持私有仓库。')
        const url = `${base}/contents/${input.path}${input.method === 'GET' ? `?ref=${encodeURIComponent(branch)}` : ''}`
        const body = input.method === 'PUT' ? JSON.stringify({
            message: 'Sync personal reader', branch, content: input.content, ...(input.sha ? { sha: input.sha } : {}),
        }) : undefined
        const response = await this.#fetch(url, { method: input.method, headers: { ...headers,
            ...(body ? { 'Content-Type': 'application/json' } : {}) }, body,
        redirect: 'error', signal: AbortSignal.timeout(45000) })
        if (![200, 201, 404, 409, 422].includes(response.status))
            throw new Error(`GitHub 同步失败（${response.status}），请检查权限、网络或请求额度。`)
        return { status: response.status, data: await response.json() }
    }
}
