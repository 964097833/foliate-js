import { test, expect, openBook, ready, position, configureTranslation, translated } from './fixtures.js'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test('phone viewport supports reading, translation and reload continuity', async ({ page, fixture }, testInfo) => {
    await page.goto(fixture.url)
    await openBook(page, fixture.richBook, '网页局部强调回归测试')
    const original = await position(page)
    await page.locator('#right-button').tap()
    await expect.poll(async () => (await position(page)).cfi).not.toBe(original.cfi)
    await configureTranslation(page, fixture)
    await page.locator('#reading-mode').selectOption('translation')
    await translated(page)
    await page.locator('#right-button').tap()
    await translated(page)
    await expect.poll(async () => (await position(page)).translation?.offset ?? 0).toBeGreaterThan(0)
    await page.waitForLoadState('networkidle')
    const before = await position(page)
    const requests = fixture.getRequests()
    const layout = await page.evaluate(() => ({
        width: innerWidth, documentWidth: document.documentElement.scrollWidth,
        controls: ['#reading-mode', '#menu-button', '#left-button', '#right-button'].map(selector => {
            const { left, right, top, bottom } = document.querySelector(selector).getBoundingClientRect()
            return { selector, left, right, top, bottom }
        }),
    }))
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.width)
    for (const control of layout.controls) {
        expect(control.left).toBeGreaterThanOrEqual(0)
        expect(control.right).toBeLessThanOrEqual(layout.width)
        expect(control.top).toBeGreaterThanOrEqual(0)
        expect(control.bottom).toBeLessThanOrEqual(844)
    }
    await page.reload()
    await ready(page)
    await translated(page)
    await page.waitForLoadState('networkidle')
    await expect.poll(() => position(page)).toEqual(before)
    expect(fixture.getRequests()).toBe(requests)
    await testInfo.attach('phone-layout-and-resume', {
        body: JSON.stringify({ layout, before, after: await position(page), requests }, null, 2), contentType: 'application/json',
    })
})
