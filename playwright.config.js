import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { getBrowserRun } from './scripts/verification-run.js'

const run = await getBrowserRun()

export default defineConfig({
    testDir: './tests/browser',
    timeout: 45_000,
    globalTimeout: 240_000,
    expect: { timeout: 10_000 },
    forbidOnly: true,
    failOnFlakyTests: true,
    retries: 0,
    workers: 1,
    outputDir: path.join(run.resultsDirectory, 'browser'),
    reporter: [['list'], ['html', { open: 'never', outputFolder: run.reportDirectory }],
        ['json', { outputFile: path.join(run.directory, 'browser.json') }]],
    use: {
        browserName: 'chromium',
        channel: 'chromium',
        viewport: { width: 1280, height: 900 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
})
