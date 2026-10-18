import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const security = '/usr/bin/security'
const service = 'io.github.foliate-js.reader.web'
const account = 'translation-master-key'

const decodeKey = value => {
    if (typeof value !== 'string') throw new Error('Invalid master key')
    const key = Buffer.from(value.trim(), 'base64')
    if (key.length !== 32) throw new Error('Invalid master key')
    return key
}

const readKeychainKey = async () => {
    const { stdout } = await exec(security, ['find-generic-password',
        '-s', service, '-a', account, '-w'])
    return decodeKey(stdout)
}

const createKeychainKey = async () => {
    const key = randomBytes(32)
    // The master key is passed as an argument because security(1) has no
    // non-interactive stdin option. It is random and local to this Mac; the
    // API key itself never leaves this process in plain text.
    await exec(security, ['add-generic-password', '-s', service, '-a', account,
        '-U', '-w', key.toString('base64')])
    return key
}

export const createSecureStorage = ({ env = process.env, platform = process.platform } = {}) => {
    let keyPromise
    const getKey = () => {
        if (keyPromise) return keyPromise
        if (env.FOLIATE_WEB_MASTER_KEY) {
            try { keyPromise = Promise.resolve(decodeKey(env.FOLIATE_WEB_MASTER_KEY)) }
            catch (error) { keyPromise = Promise.reject(error) }
        } else if (platform !== 'darwin') {
            keyPromise = Promise.reject(new Error('The macOS Keychain is not available'))
        } else {
            keyPromise = readKeychainKey().catch(async error => {
                if (error.code !== 44) throw error
                return createKeychainKey()
            })
        }
        keyPromise.catch(error => console.warn(`Secure storage unavailable: ${error.message}`))
        return keyPromise
    }
    return {
        async isAsyncEncryptionAvailable() {
            try { await getKey(); return true }
            catch { return false }
        },
        async encryptStringAsync(value) {
            const key = await getKey()
            const iv = randomBytes(12)
            const cipher = createCipheriv('aes-256-gcm', key, iv)
            const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
            return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
        },
        async decryptStringAsync(value) {
            const key = await getKey()
            const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
            decipher.setAuthTag(value.subarray(12, 28))
            return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') }
        },
    }
}
