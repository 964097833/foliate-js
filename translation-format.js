// Text-only protocol shared by the browser and local translation service.
export const validateSourceSegments = (text, segments) => {
    if (!Array.isArray(segments) || !segments.length || segments.length > 4096
        || segments.some((segment, id) => !segment || segment.id !== id
            || typeof segment.text !== 'string' || !segment.text.length)
        || segments.map(segment => segment.text).join('') !== text)
        throw new Error('翻译格式片段无效，请重试。')
}

export const parseTranslatedSegments = (value, segments) => {
    let translated
    try { translated = JSON.parse(value) } catch { /* Report one recoverable format error. */ }
    const fail = () => { throw new Error('译文格式不完整，请重试。') }
    if (!Array.isArray(translated) || translated.length !== segments.length) fail()
    const seen = new Set()
    const groups = []
    let group = 0
    for (const segment of segments) {
        // Whitespace-only breaks and preformatted indentation are fixed anchors.
        if (!segment.text.trim()) {
            groups.push(++group)
            group++
        } else groups.push(group)
    }
    let previousGroup = 0
    for (const segment of translated) {
        if (!segment || !Number.isInteger(segment.id) || !segments[segment.id]
            || seen.has(segment.id) || typeof segment.text !== 'string') fail()
        const source = segments[segment.id].text
        if (!source.trim() ? segment.text !== source : !segment.text.trim() || /[\r\n]/.test(segment.text)) fail()
        if (groups[segment.id] < previousGroup) fail()
        previousGroup = groups[segment.id]
        seen.add(segment.id)
    }
    return translated.map(({ id, text }) => ({ id, text }))
}
