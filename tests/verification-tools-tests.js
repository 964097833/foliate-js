import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRun, processExists } from '../scripts/verification-run.js'
import { installHooks } from '../scripts/install-hooks.js'
import { attachFailureSnapshots } from './browser/diagnostics.js'

const exec = promisify(execFile)
const temporary = async action => {
    const directory = await mkdtemp(path.join(tmpdir(), 'foliate verification-'))
    try { await action(directory) }
    finally { await rm(directory, { recursive: true, force: true }) }
}
const git = (root, args) => exec('git', args, { cwd: root })
const initialize = async root => {
    await git(root, ['init', '-q'])
    await git(root, ['config', 'user.name', 'Verification Test'])
    await git(root, ['config', 'user.email', 'verification@example.invalid'])
    await git(root, ['config', 'commit.gpgsign', 'false'])
}

test('failure snapshots preserve evidence from multiple browser contexts', async () => {
    await temporary(async root => {
        const attachments = []
        const testInfo = {
            outputPath: name => path.join(root, name),
            attach: async (name, attachment) => attachments.push({ name, ...attachment }),
        }
        const context = state => ({ pages: () => [{
            isClosed: () => false,
            evaluate: async () => ({ state }),
            screenshot: async ({ path: file }) => writeFile(file, state),
        }] })
        await attachFailureSnapshots(context('persistent-reader'), testInfo)
        await attachFailureSnapshots(context('default-page'), testInfo)
        assert.equal(JSON.parse(await readFile(path.join(root, 'reader-state.json'), 'utf8')).state, 'persistent-reader')
        assert.equal(JSON.parse(await readFile(path.join(root, 'reader-state-1.json'), 'utf8')).state, 'default-page')
        assert.equal(await readFile(path.join(root, 'reader-failure-0.png'), 'utf8'), 'persistent-reader')
        assert.equal(await readFile(path.join(root, 'reader-failure-1.png'), 'utf8'), 'default-page')
        assert.equal(new Set(attachments.map(attachment => attachment.path)).size, 4)
    })
})

test('browser lock rejects a second run without touching the first report', async () => {
    await temporary(async root => {
        const first = await createRun(root, 'first test')
        const marker = path.join(first.directory, 'marker')
        await writeFile(marker, 'preserve')
        try {
            await assert.rejects(createRun(root, 'second test'), /浏览器验收已在运行/)
            assert.equal(await readFile(marker, 'utf8'), 'preserve')
        } finally { await first.release() }
        const next = await createRun(root, 'next test')
        assert.notEqual(next.id, first.id)
        await next.release()
    })
})

test('browser lock reclaims a dead owner and an old release cannot remove a new owner', async () => {
    await temporary(async root => {
        const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
        await new Promise(resolve => child.once('close', resolve))
        const directory = path.join(root, '.verification/browser.lock')
        await mkdir(directory, { recursive: true })
        await writeFile(path.join(directory, 'stale.json'), JSON.stringify({ pid: child.pid, token: 'stale' }))
        const first = await createRun(root, 'recovered')
        await first.release()
        const next = await createRun(root, 'replacement')
        try {
            await first.release()
            await assert.rejects(createRun(root, 'third'), /浏览器验收已在运行/)
        } finally { await next.release() }
    })
})

test('interrupted browser runner stops its child, releases the lock and records failure', async () => {
    await temporary(async root => {
        await initialize(root)
        await git(root, ['commit', '--allow-empty', '-qm', 'Seed runner test'])
        await mkdir(path.join(root, 'scripts'))
        for (const name of ['browser-check.js', 'verification-run.js', 'verification-summary.js'])
            await copyFile(new URL('../scripts/' + name, import.meta.url), path.join(root, 'scripts', name))
        await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
        const cliDirectory = path.join(root, 'node_modules/@playwright/test')
        await mkdir(cliDirectory, { recursive: true })
        await writeFile(path.join(cliDirectory, 'cli.js'), `
            console.info('FAKE_BROWSER_READY')
            process.on('SIGTERM', () => process.exit(143))
            setInterval(() => {}, 1000)
        `)
        const child = spawn(process.execPath, ['scripts/browser-check.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', data => stderr += data)
        const closed = new Promise(resolve => child.once('close', code => resolve(code)))
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Fake browser did not start')), 5000)
                child.stdout.on('data', data => {
                    if (data.toString().includes('FAKE_BROWSER_READY')) { clearTimeout(timer); resolve() }
                })
                child.once('error', reject)
                child.once('close', code => { clearTimeout(timer); reject(new Error(`Fake browser exited ${code}: ${stderr}`)) })
            })
            await assert.rejects(exec(process.execPath, ['scripts/browser-check.js'], { cwd: root }), error => {
                assert.match(error.stderr, /浏览器验收已在运行/)
                return true
            })
            child.kill('SIGTERM')
            assert.equal(await closed, 143)
            await assert.rejects(access(path.join(root, '.verification/browser.lock')), { code: 'ENOENT' })
            const latest = JSON.parse(await readFile(path.join(root, '.verification/latest.json'), 'utf8'))
            const summary = JSON.parse(await readFile(latest.file, 'utf8'))
            assert.equal(summary.status, 'failed')
            assert.equal(summary.phases.browser.status, 'failed')
            await assert.rejects(exec(process.execPath, ['scripts/verification-summary.js', '--json'], { cwd: root }), error => {
                assert.equal(JSON.parse(error.stdout).status, 'failed')
                return true
            })
        } finally { if (child.exitCode === null) { child.kill('SIGTERM'); await closed } }
    })
})

test('interrupting a gate run stops the nested browser before releasing its lock', async () => {
    await temporary(async root => {
        await initialize(root)
        await git(root, ['commit', '--allow-empty', '-qm', 'Seed gate test'])
        await mkdir(path.join(root, 'scripts'))
        await mkdir(path.join(root, 'tests/browser'), { recursive: true })
        for (const name of ['browser-check.js', 'verification-run.js'])
            await copyFile(new URL('../scripts/' + name, import.meta.url), path.join(root, 'scripts', name))
        await copyFile(new URL('./browser/check-gate.js', import.meta.url), path.join(root, 'tests/browser/check-gate.js'))
        await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
        const cliDirectory = path.join(root, 'node_modules/@playwright/test')
        await mkdir(cliDirectory, { recursive: true })
        const marker = path.join(root, 'browser-pid')
        await writeFile(path.join(cliDirectory, 'cli.js'), `
            require('node:fs').writeFileSync('browser-pid', String(process.pid))
            process.on('SIGTERM', () => setTimeout(() => process.exit(143), 100))
            setInterval(() => {}, 1000)
        `)
        const child = spawn(process.execPath, ['scripts/browser-check.js', '--gate'], { cwd: root, stdio: 'ignore' })
        const closed = new Promise(resolve => child.once('close', resolve))
        try {
            let pid
            const deadline = Date.now() + 5000
            while (!pid && Date.now() < deadline) {
                pid = Number(await readFile(marker, 'utf8').catch(() => ''))
                if (!pid) await new Promise(resolve => setTimeout(resolve, 20))
            }
            assert.ok(pid, 'Nested browser must start before the interruption')
            assert.ok(processExists(pid))
            child.kill('SIGTERM')
            assert.equal(await closed, 143)
            assert.equal(processExists(pid), false)
            await assert.rejects(access(path.join(root, '.verification/browser.lock')), { code: 'ENOENT' })
        } finally { if (child.exitCode === null) { child.kill('SIGTERM'); await closed } }
    })
})

test('repository hooks block bad commits and pushes using the configured npm checks', async () => {
    await temporary(async root => {
        await initialize(root)
        await mkdir(path.join(root, '.githooks'))
        for (const name of ['pre-commit', 'pre-push'])
            await copyFile(new URL('../.githooks/' + name, import.meta.url), path.join(root, '.githooks', name))
        const scripts = async (lint, check) => writeFile(path.join(root, 'package.json'), JSON.stringify({
            scripts: { lint: `node -e "process.exit(${lint})"`, check: `node -e "process.exit(${check})"` },
        }))
        await installHooks(root)
        await installHooks(root)
        assert.equal((await git(root, ['config', '--local', '--get', 'core.hooksPath'])).stdout.trim(), '.githooks')
        await scripts(1, 1)
        await git(root, ['add', 'package.json'])
        await assert.rejects(git(root, ['commit', '-qm', 'Must fail lint']))
        await scripts(0, 1)
        await git(root, ['add', 'package.json'])
        await git(root, ['commit', '-qm', 'Pass lint'])
        const remote = path.join(root, 'test-remote.git')
        await git(root, ['init', '--bare', '-q', remote])
        await git(root, ['remote', 'add', 'test', remote])
        await assert.rejects(git(root, ['push', 'test', 'HEAD:refs/heads/main']))
        await assert.rejects(git(remote, ['rev-parse', '--verify', 'refs/heads/main']))
        await scripts(0, 0)
        await git(root, ['push', 'test', 'HEAD:refs/heads/main'])
        assert.match((await git(remote, ['rev-parse', '--verify', 'refs/heads/main'])).stdout, /^[a-f0-9]{40}/)
    })
})

test('hook installation preserves an existing custom hooks configuration', async () => {
    await temporary(async root => {
        await initialize(root)
        await git(root, ['config', '--local', 'core.hooksPath', 'custom-hooks'])
        await assert.rejects(installHooks(root), /保留原设置/)
        assert.equal((await git(root, ['config', '--local', '--get', 'core.hooksPath'])).stdout.trim(), 'custom-hooks')
    })
})
