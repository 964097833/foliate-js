import { createTranslationRequest } from '../translation-request.js'
import { validateSourceSegments, parseTranslatedSegments } from '../translation-format.js'

export let nativePlugin = null
if (globalThis.Capacitor?.isNativePlatform?.()) {
    // Copied from the pinned Capacitor dependency by prepare-ios; never fetched remotely.
    const { registerPlugin } = await import('./capacitor-runtime.js')
    nativePlugin = registerPlugin('FoliateNative')
}

export const createNativeBridge = (plugin = nativePlugin) => {
    if (!plugin) return null
    let settings
    return {
        getSettings: async () => (settings = await plugin.settings({ scope: 'translation', method: 'GET' })),
        saveSettings: async input => (settings = await plugin.settings({ scope: 'translation', method: 'PUT', input })),
        clearSettings: async () => (settings = await plugin.settings({ scope: 'translation', method: 'DELETE' })),
        async translate(input) {
            if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 50000)
                throw new Error('翻译段落无效或过长。')
            if (input.segments !== undefined) validateSourceSegments(input.text, input.segments)
            settings ??= await plugin.settings({ scope: 'translation', method: 'GET' })
            const response = await plugin.translate({ id: input.id, body: createTranslationRequest(settings, input) })
            if (response.status !== 200) {
                if (response.status === 429) throw new Error('服务请求过于频繁或额度不足，请稍后重试。')
                throw new Error(`翻译请求失败（${response.status}），请检查网络、密钥和模型设置。`)
            }
            const choice = response.data?.choices?.[0]
            const text = choice?.message?.content
            if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error('译文未完整生成，请重试。')
            if (typeof text !== 'string' || !text.trim()) throw new Error('翻译服务未返回有效译文。')
            return input.segments ? JSON.stringify(parseTranslatedSegments(text.trim(), input.segments)) : text.trim()
        },
        cancel: id => { plugin.cancel({ id }).catch(() => {}) },
        onSettingsChange: () => () => {},
    }
}

export const createSyncBridge = () => {
    if (nativePlugin) return {
        getSettings: () => nativePlugin.settings({ scope: 'sync', method: 'GET' }),
        saveSettings: input => nativePlugin.settings({ scope: 'sync', method: 'PUT', input }),
        clearSettings: () => nativePlugin.settings({ scope: 'sync', method: 'DELETE' }),
        request: input => nativePlugin.github(input),
    }
    if (!['http:', 'https:'].includes(globalThis.location?.protocol)
        || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return null
    const request = async (path, method = 'GET', input) => {
        const response = await fetch(`/api/sync/${path}`, { method, cache: 'no-store',
            ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? '无法连接本地同步服务。')
        return data
    }
    return { getSettings: () => request('settings'), saveSettings: input => request('settings', 'PUT', input),
        clearSettings: () => request('settings', 'DELETE'), request: input => request('request', 'POST', input) }
}

// IDPF font deobfuscation needs SHA-1 even if WebKit does not expose SubtleCrypto.
export const nativeSHA1 = plugin => async text => {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    const { hash } = await plugin.digest({ algorithm: 'SHA-1', base64: btoa(binary) })
    if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error('字体校验失败。')
    return Uint8Array.from(hash.match(/../g), byte => parseInt(byte, 16))
}
