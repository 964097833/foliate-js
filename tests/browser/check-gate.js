// Prove that each guard rejects a broken run, rather than merely reporting green.
import { spawn } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getBrowserRun } from '../../scripts/verification-run.js'

const cli = fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url))
const run = await getBrowserRun()
const probes = []
let activeChild
let interrupted
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    interrupted = signal
    activeChild?.kill(signal)
})
const scenarios = [
    ['assertion', 'browser regressions', 'Injected acceptance failure'],
    ['runtime', 'original reading', 'Injected runtime failure'],
    ['rejection', 'original reading', 'Injected rejection failure'],
    ['timeout', 'browser regressions', '#never-completes'],
    ['position', 'paginated: translation, reload and book return', 'Restored translated reading position'],
    ['cache', 'paginated: translation, reload and book return', 'Reload/return must reuse cached translations'],
]
for (const [fault, grep, evidence] of scenarios) {
    if (interrupted) throw new Error(`Gate interrupted: ${interrupted}`)
    const directory = path.join(run.resultsDirectory, 'gate', fault)
    const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'test', '--grep', grep,
            '--reporter=line', '--output', directory], {
            env: { ...process.env, FOLIATE_TEST_FAULT: fault },
            signal: AbortSignal.timeout(90_000),
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        activeChild = child
        if (interrupted) child.kill(interrupted)
        let output = ''
        let failure
        child.stdout.on('data', data => output += data)
        child.stderr.on('data', data => output += data)
        child.on('error', error => { failure = error })
        child.on('close', code => {
            activeChild = null
            if (failure) reject(failure)
            else resolve({ code, output })
        })
    })
    if (interrupted) throw new Error(`Gate interrupted: ${interrupted}`)
    await mkdir(directory, { recursive: true })
    await writeFile(`${directory}/probe.log`, result.output)
    if (result.code !== 1 || !result.output.includes(evidence))
        throw new Error(`The ${fault} probe did not fail for the intended reason. See ${directory}/probe.log`)
    const artifacts = await readdir(directory, { recursive: true })
    if (!artifacts.some(file => file.endsWith('reader-state.json')))
        throw new Error(`The ${fault} probe did not preserve a reader failure snapshot.`)
    probes.push({ fault, status: 'passed', log: path.join(directory, 'probe.log') })
    await writeFile(path.join(run.directory, 'gate.json'), JSON.stringify({ probes }, null, 2) + '\n')
    console.info(`Verified rejection: ${fault}`)
}
