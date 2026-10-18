import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: './tests/browser',
    timeout: 45_000,
    globalTimeout: 240_000,
    expect: { timeout: 10_000 },
    forbidOnly: true,
    failOnFlakyTests: true,
    retries: 0,
    workers: 1,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        browserName: 'chromium',
        channel: 'chromium',
        viewport: { width: 1280, height: 900 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
})
