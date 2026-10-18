const endpoint = '/api/translation'
const session = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)

const request = async (path, options = {}) => {
    let response
    try {
        response = await fetch(`${endpoint}${path}`, {
            cache: 'no-store',
            ...options,
            headers: { 'X-Foliate-Session': session, ...options.headers },
        })
    } catch {
        throw new Error('无法连接本地翻译服务，请确认已运行 npm start，并保持服务进程开启。')
    }
    let data = null
    try { data = await response.json() } catch { /* The server may not be ours. */ }
    if (!response.ok)
        throw new Error(data?.error ?? `本地翻译服务返回错误（${response.status}）。`)
    return data
}

const json = value => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
})

export const createHTTPBridge = () => {
    const origin = globalThis.location
    if (!origin || !['http:', 'https:'].includes(origin.protocol)
        || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) return null
    return {
        getSettings: () => request('/settings'),
        saveSettings: settings => request('/settings', { method: 'PUT', ...json(settings) }),
        clearSettings: () => request('/settings', { method: 'DELETE' }),
        async translate({ id, text, segments }) {
            const data = await request('/translate', { method: 'POST', ...json({ id, text, segments }) })
            if (typeof data?.translation !== 'string') throw new Error('本地翻译服务未返回有效译文。')
            return data.translation
        },
        cancel: id => {
            request('/cancel', { method: 'POST', ...json({ id }) }).catch(() => {})
        },
        onSettingsChange: () => () => {},
    }
}
