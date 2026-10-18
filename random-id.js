// getRandomValues also works in WKWebView custom-scheme contexts where
// randomUUID is unavailable. Keep cancellation IDs cryptographically random.
export const randomId = () => globalThis.crypto.randomUUID?.()
    ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
