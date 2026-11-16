import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto'
import { SyncError, messageOf } from './errors.js'
import { isPlainObject } from './util.js'

/**
 * Single-file encrypted backup for dsh-bag.
 *
 * Envelope: PBKDF2-SHA256(password, salt) -> AES-256-GCM.
 * AAD binds the ciphertext to this format and version, so an envelope cannot
 * be replayed as another product's payload.
 */

export const BUNDLE_FORMAT = 'dsh-bag-bundle'
export const BUNDLE_VERSION = 1
export const PAYLOAD_FORMAT = 'dsh-bag-payload'
export const PAYLOAD_VERSION = 1
export const KDF_ITERATIONS = 600_000
export const MIN_PASSWORD_LENGTH = 8
export const MAX_ENVELOPE_BYTES = 24 * 1024 * 1024

const SALT_BYTES = 16
const NONCE_BYTES = 12
const TAG_BYTES = 16
const AAD = Buffer.from('dsh-bag:payload:1', 'utf8')

export interface BundleItem {
  cls: string
  hash: string
  value: unknown
}

export interface BundlePayload {
  format: typeof PAYLOAD_FORMAT
  version: typeof PAYLOAD_VERSION
  schemaVersion: number
  createdAt: string
  device: { id: string; name: string }
  items: Record<string, BundleItem>
  warnings?: string[]
}

export interface BundleEnvelope {
  format: typeof BUNDLE_FORMAT
  version: typeof BUNDLE_VERSION
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string }
  cipher: { name: 'AES-256-GCM'; nonce: string; tag: string }
  ciphertext: string
}

export async function encryptBundle(payload: BundlePayload, password: string): Promise<BundleEnvelope> {
  assertPassword(password)
  const salt = randomBytes(SALT_BYTES)
  const nonce = randomBytes(NONCE_BYTES)
  const key = await derive(password, salt, KDF_ITERATIONS)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(AAD)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    kdf: { name: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: salt.toString('base64') },
    cipher: {
      name: 'AES-256-GCM',
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    },
    ciphertext: ciphertext.toString('base64'),
  }
}

export async function decryptBundle(text: string, password: string): Promise<BundlePayload> {
  if (typeof text !== 'string' || text.trim() === '') throw new SyncError('bundle', 'the bundle file is empty')
  if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES) {
    throw new SyncError('bundle', 'the bundle file is too large')
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new SyncError('bundle', 'the bundle file is not valid JSON')
  }
  if (!isPlainObject(envelope)) throw new SyncError('bundle', 'the bundle envelope is malformed')
  if (envelope.format !== BUNDLE_FORMAT) throw new SyncError('bundle', 'this is not a dsh-bag bundle')
  if (envelope.version !== BUNDLE_VERSION) throw new SyncError('bundle-version', 'the bundle was written by a newer dsh-bag')
  if (!isPlainObject(envelope.kdf) || !isPlainObject(envelope.cipher)) {
    throw new SyncError('bundle', 'the bundle envelope is missing KDF or cipher fields')
  }
  const kdf = envelope.kdf
  const cipherInfo = envelope.cipher
  if (kdf.name !== 'PBKDF2-SHA256') throw new SyncError('bundle', 'unsupported KDF')
  if (typeof kdf.iterations !== 'number' || kdf.iterations < 100_000 || kdf.iterations > 2_000_000) {
    throw new SyncError('bundle', 'unsupported KDF iteration count')
  }
  if (cipherInfo.name !== 'AES-256-GCM') throw new SyncError('bundle', 'unsupported cipher')
  const salt = decodeBase64(kdf.salt, SALT_BYTES, 'salt')
  const nonce = decodeBase64(cipherInfo.nonce, NONCE_BYTES, 'nonce')
  const tag = decodeBase64(cipherInfo.tag, TAG_BYTES, 'tag')
  const ciphertext = decodeBase64(envelope.ciphertext, undefined, 'ciphertext')
  if (password === '') throw new SyncError('password', 'a password is required')

  const key = await derive(password, salt, kdf.iterations)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (error) {
    throw new SyncError('password', 'the password is wrong or the file was modified')
  }
  let payload: unknown
  try {
    payload = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new SyncError('bundle', 'the decrypted payload is not valid JSON')
  }
  return validatePayload(payload)
}

function validatePayload(value: unknown): BundlePayload {
  if (!isPlainObject(value)) throw new SyncError('bundle', 'the payload is malformed')
  if (value.format !== PAYLOAD_FORMAT) throw new SyncError('bundle', 'the payload format is unknown')
  if (value.version !== PAYLOAD_VERSION) throw new SyncError('bundle-version', 'the payload version is newer than this dsh-bag')
  if (typeof value.schemaVersion !== 'number') throw new SyncError('bundle', 'the payload schema version is missing')
  if (typeof value.createdAt !== 'string') throw new SyncError('bundle', 'the payload timestamp is missing')
  if (!isPlainObject(value.device) || typeof value.device.id !== 'string') {
    throw new SyncError('bundle', 'the payload device identity is missing')
  }
  if (!isPlainObject(value.items)) throw new SyncError('bundle', 'the payload has no items')
  const items: Record<string, BundleItem> = {}
  for (const [id, entry] of Object.entries(value.items)) {
    if (!isPlainObject(entry)) throw new SyncError('bundle', `item ${id} is malformed`)
    if (typeof entry.cls !== 'string') throw new SyncError('bundle', `item ${id} has no class`)
    if (typeof entry.hash !== 'string') throw new SyncError('bundle', `item ${id} has no hash`)
    items[id] = { cls: entry.cls, hash: entry.hash, value: entry.value }
  }
  return {
    format: PAYLOAD_FORMAT,
    version: PAYLOAD_VERSION,
    schemaVersion: value.schemaVersion,
    createdAt: value.createdAt,
    device: { id: value.device.id, name: typeof value.device.name === 'string' ? value.device.name : value.device.id },
    items,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((w): w is string => typeof w === 'string').slice(0, 50) : [],
  }
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new SyncError('password', `the password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
}

function decodeBase64(value: unknown, expected: number | undefined, label: string): Buffer {
  if (typeof value !== 'string') throw new SyncError('bundle', `the ${label} is missing`)
  const buffer = Buffer.from(value, 'base64')
  if (expected !== undefined && buffer.length !== expected) {
    throw new SyncError('bundle', `the ${label} has the wrong length`)
  }
  return buffer
}

function derive(password: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, 32, 'sha256', (error, key) => {
      if (error) {
        reject(new SyncError('bundle', `key derivation failed: ${messageOf(error)}`))
        return
      }
      resolve(key)
    })
  })
}
