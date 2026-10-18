// Prove that each guard rejects a broken run, rather than merely reporting green.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url))
const scenarios = [
    ['assertion', 'browser regressions', 'Injected acceptance failure'],
    ['runtime', 'original reading', 'Injected runtime failure'],
    ['rejection', 'original reading', 'Injected rejection failure'],
    ['timeout', 'browser regressions', '#never-completes'],
    ['position', 'paginated:', 'Restored translated reading position'],
    ['cache', 'paginated:', 'Reload/return must reuse cached translations'],
]
for (const [fault, grep, evidence] of scenarios) {
    const directory = `test-results/gate/${fault}`
    const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'test', '--grep', grep,
            '--reporter=line', '--output', directory], {
            env: { ...process.env, FOLIATE_TEST_FAULT: fault },
            signal: AbortSignal.timeout(90_000),
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        child.stdout.on('data', data => output += data)
        child.stderr.on('data', data => output += data)
        child.on('error', reject)
        child.on('close', code => resolve({ code, output }))
    })
    await mkdir(directory, { recursive: true })
    await writeFile(`${directory}/probe.log`, result.output)
    if (result.code !== 1 || !result.output.includes(evidence))
        throw new Error(`The ${fault} probe did not fail for the intended reason. See ${directory}/probe.log`)
    console.info(`Verified rejection: ${fault}`)
}
