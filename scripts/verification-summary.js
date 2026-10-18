import { readFile } from 'node:fs/promises'

try {
    const latest = JSON.parse(await readFile(new URL('../.verification/latest.json', import.meta.url), 'utf8'))
    const summary = JSON.parse(await readFile(latest.file, 'utf8'))
    if (process.argv.includes('--json')) console.info(JSON.stringify(summary, null, 2))
    else {
        console.info(`结果：${summary.status}；范围：${summary.scope}；运行：${summary.id}`)
        for (const [name, phase] of Object.entries(summary.phases))
            console.info(`${name}: ${phase.status} (${phase.durationMs}ms)`)
        if (summary.nodeTests !== undefined) console.info(`Node 测试：${summary.nodeTests} 项`)
        if (summary.browser) console.info(`浏览器：${summary.browser.passed} 通过，${summary.browser.failed} 失败，${summary.browser.assertions} 项模块断言`)
        if (summary.gate) console.info(`故障拦截：${summary.gate.probes.length} 类通过`)
        console.info(`报告：${summary.reportDirectory}\nJSON：${latest.file}`)
    }
    if (summary.status !== 'passed') process.exitCode = 1
} catch (error) {
    console.error(`尚无可读验收汇总，请先运行 npm run check。${error.code === 'ENOENT' ? '' : error.message}`)
    process.exitCode = 1
}
