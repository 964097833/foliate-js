import js from '@eslint/js'
import globals from 'globals'

export default [js.configs.recommended, { ignores: ['vendor', 'out', 'test-results', 'playwright-report'] }, {
    languageOptions: {
        globals: globals.browser,
    },
    linterOptions: {
        reportUnusedDisableDirectives: true,
    },
    rules: {
        semi: ['error', 'never'],
        indent: ['warn', 4, { flatTernaryExpressions: true, SwitchCase: 1 }],
        quotes: ['warn', 'single', { avoidEscape: true }],
        'comma-dangle': ['warn', 'always-multiline'],
        'no-trailing-spaces': 'warn',
        'no-unused-vars': 'warn',
        'no-console': ['warn', { allow: ['debug', 'warn', 'error', 'assert'] }],
        'no-constant-condition': ['error', { checkLoops: false }],
        'no-empty': ['error', { allowEmptyCatch: true }],
    },
}, {
    files: ['server/*.js', 'tests/translation-backend-tests.js',
        'tests/web-server-tests.js', 'tests/reading-state-tests.js', 'tests/web-reader-fixture.js',
        'tests/browser/*.js', 'playwright.config.js'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': ['warn', { allow: ['info', 'warn', 'error', 'assert'] }] },
}]
