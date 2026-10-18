const status = document.getElementById('test-status')
const originalAssert = console.assert
let assertions = 0
let failures = 0
let finished = false
const report = () => {
    status.dataset.assertions = assertions
    status.dataset.failures = failures
    status.dataset.state = failures ? 'failed' : finished ? 'passed' : 'running'
    status.textContent = failures
        ? `Browser tests failed: ${failures} failures, ${assertions} assertions. Check the console.`
        : finished ? `Browser tests passed: ${assertions} assertions.` : 'Running browser tests…'
}
const fail = () => {
    failures++
    report()
}
// Keep listeners active after imports so late observer errors also fail the page.
window.addEventListener('error', fail)
window.addEventListener('unhandledrejection', fail)
console.assert = (condition, ...messages) => {
    assertions++
    if (!condition) failures++
    originalAssert.call(console, condition, ...messages)
    report()
}
try {
    await import('./epubcfi-tests.js')
    await import('./translation-tests.js')
    await import('./reader-storage-tests.js')
    await import('./paginator-tests.js')
} catch (error) {
    fail()
    console.error(error)
} finally {
    finished = true
    report()
}
