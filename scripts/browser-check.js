import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { createRun } from './verification-run.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const mode = args[0] === '--all' ? 'all' : args[0] === '--gate' ? 'gate' : 'browser'
if (mode !== 'browser') args.shift()
if (args.some(arg => /^(?:--(?:output|reporter|config)(?:=|$)|-c$)/.test(arg))
    || mode !== 'browser' && args.length) {
    console.error('输出目录和 reporter 由验收入口管理；筛选测试请使用 npm run test:browser -- --grep ...')
    process.exit(2)
}

let run
let child
let interrupted
const stop = signal => { interrupted = signal; child?.kill(signal) }
const onInterrupt = () => stop('SIGINT')
const onTerminate = () => stop('SIGTERM')
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onTerminate)
const summary = { scope: mode, args, status: 'running', phases: {} }

const phase = async (name, command, arguments_) => {
    const started = Date.now()
    let output = ''
    const result = await new Promise((resolve, reject) => {
        child = spawn(command, arguments_, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
            ...process.env, FOLIATE_VERIFICATION_TOKEN: run.token,
        } })
        child.stdout.on('data', data => { process.stdout.write(data); output = (output + data).slice(-4 * 1024 * 1024) })
        child.stderr.on('data', data => { process.stderr.write(data); output = (output + data).slice(-4 * 1024 * 1024) })
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
        if (interrupted) child.kill(interrupted)
    })
    child = null
    const log = path.join(run.directory, `${name}.log`)
    await writeFile(log, output)
    summary.phases[name] = { status: result.code === 0 ? 'passed' : 'failed',
        ...result, durationMs: Date.now() - started, log }
    if (name === 'node') summary.nodeTests = Number(stripVTControlCharacters(output).match(/(?:ℹ|#) tests (\d+)/)?.[1] ?? 0)
    if (result.code !== 0) throw new Error(`${name} 检查失败（${result.signal ?? result.code}）。`)
}

const browserTotals = report => {
    let assertions = 0
    const walk = value => {
        if (!value || typeof value !== 'object') return
        if (value.name === 'browser-assertions' && value.body) {
            const body = Buffer.from(value.body, 'base64').toString()
            assertions += Number(body.match(/(\d+) assertions/)?.[1] ?? 0)
        }
        for (const item of Object.values(value)) {
            if (Array.isArray(item)) item.forEach(walk)
            else if (item && typeof item === 'object') walk(item)
        }
    }
    walk(report)
    return { passed: report.stats.expected, failed: report.stats.unexpected,
        skipped: report.stats.skipped, flaky: report.stats.flaky, assertions }
}

try {
    run = await createRun(root, `npm run ${mode === 'all' ? 'check' : mode === 'gate' ? 'test:browser:gate' : 'test:browser'}`)
    Object.assign(summary, { id: run.id, startedAt: run.startedAt, node: process.version,
        reportDirectory: run.reportDirectory, resultsDirectory: run.resultsDirectory })
    summary.revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    summary.dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
    console.info(`验收 ${run.id}\n报告：${run.reportDirectory}`)
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    if (mode === 'all') {
        await phase('lint', npm, ['run', 'lint'])
        await phase('node', npm, ['test'])
    }
    if (mode !== 'gate') {
        await phase('browser', process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...args])
        const report = JSON.parse(await readFile(path.join(run.directory, 'browser.json'), 'utf8'))
        summary.browser = browserTotals(report)
    }
    if (mode !== 'browser') {
        await phase('gate', process.execPath, [path.join(root, 'tests/browser/check-gate.js')])
        summary.gate = JSON.parse(await readFile(path.join(run.directory, 'gate.json'), 'utf8'))
    }
    summary.status = 'passed'
} catch (error) {
    summary.status = 'failed'
    summary.error = error.message
    console.error(error.message)
    process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted ? 143 : 1
} finally {
    if (run) {
        try {
            if (!summary.browser) {
                try { summary.browser = browserTotals(JSON.parse(await readFile(path.join(run.directory, 'browser.json'), 'utf8'))) }
                catch { /* Earlier phases or startup failures may not produce a browser report. */ }
            }
            summary.finishedAt = new Date().toISOString()
            const file = path.join(run.directory, 'summary.json')
            await writeFile(file, JSON.stringify(summary, null, 2) + '\n')
            await writeFile(path.join(root, '.verification/latest.json'), JSON.stringify({ file }) + '\n')
            console.info(`结果：${summary.status}；汇总：${file}`)
        } finally { await run.release() }
    }
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
}
