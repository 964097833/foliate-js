import '../paginator.js'

// Restoring an already-aligned anchor emits no native scroll event. It must
// not leave a flag that swallows the reader's next real scroll and bookmark.
{
    const errors = []
    const onError = event => errors.push(event.error?.stack ?? event.message)
    window.addEventListener('error', onError)
    const renderer = document.createElement('foliate-paginator')
    renderer.style.cssText = 'width:800px;height:400px'
    renderer.setAttribute('flow', 'scrolled')
    document.body.append(renderer)
    const url = URL.createObjectURL(new Blob([
        `<html><head><title>Scroll regression</title></head><body>${
            Array.from({ length: 30 }, (_, i) => `<p style="height:100px;margin:0">Paragraph ${i}</p>`).join('')
        }</body></html>`,
    ], { type: 'text/html' }))
    renderer.open({ sections: [{ load: async () => url }] })
    try {
        await renderer.goTo({ index: 0, anchor: 0 })
        await new Promise(resolve => setTimeout(resolve, 350))
        await renderer.restoreAnchor(0)
        let scrolled = false
        renderer.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'scroll') scrolled = true
        })
        renderer.scrollBy(150, 0)
        for (let i = 0; i < 50 && !scrolled; i++)
            await new Promise(resolve => setTimeout(resolve, 20))
        console.assert(scrolled, 'A real scroll after an unchanged restored anchor updates the reading location')
        console.assert(renderer.start > 100, 'The scroll regression moved the reading viewport')
        const doc = renderer.getContents()[0].doc
        const point = doc.createRange()
        point.selectNodeContents(doc.querySelectorAll('p')[3].firstChild)
        point.collapse(true)
        await renderer.restoreAnchor(point, 12)
        const before = renderer.captureAnchorOffset(point)
        const inserted = doc.createElement('p')
        inserted.style.height = '100px'
        inserted.textContent = 'A later translation above the current passage'
        doc.body.prepend(inserted)
        await new Promise(resolve => setTimeout(resolve, 350))
        const after = renderer.captureAnchorOffset(point)
        console.assert(Math.abs(after - before) < 1,
            'Content expansion keeps the restored character at the same screen offset')
        // Destroy between a native scroll and its debounced relocation callback.
        const pendingScroll = new Promise(resolve => renderer.addEventListener('scroll',
            () => requestAnimationFrame(resolve), { once: true }))
        renderer.scrollBy(150, 0)
        await pendingScroll
    } finally {
        renderer.destroy()
        renderer.remove()
        await new Promise(resolve => setTimeout(resolve, 350))
        console.assert(errors.length === 0, 'Rendering and teardown leave no late observer exceptions', errors.join('\n'))
        window.removeEventListener('error', onError)
        URL.revokeObjectURL(url)
    }
}
