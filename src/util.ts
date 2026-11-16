import { createHash, randomBytes } from 'node:crypto'

/** Stable JSON with sorted object keys, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value))
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** One spelling of a text file on every platform. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export function randomId(bytes = 8): string {
  return randomBytes(bytes).toString('hex')
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** Split "a.b.c" into ["a","b","c"]; empty segments are refused by policy. */
export function dottedPath(path: string): string[] {
  return path.split('.').filter(part => part.length > 0)
}
