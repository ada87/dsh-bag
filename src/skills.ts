import { cp, mkdir, readFile, readdir, rm, stat, lstat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { SyncError } from './errors.js'
import type { SkillFile, SkillValue } from './protocol.js'
import { canonicalJson, sha256 } from './util.js'

export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const MAX_SKILL_BYTES = 2 * 1024 * 1024
export const MAX_SKILL_FILES = 200
export const MAX_SKILL_FILE_BYTES = 1024 * 1024
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store'])

export function skillItemId(name: string): string {
  return `skill:${name}`
}

export function parseSkillItemId(id: string): string | undefined {
  if (!id.startsWith('skill:')) return undefined
  const name = id.slice('skill:'.length)
  return SKILL_NAME_RE.test(name) ? name : undefined
}

export function agentsHome(): string {
  const configured = process.env.DSH_AGENTS_HOME
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.agents')
}

export function resolveSkillsRoot(home: string, mode: 'dsh' | 'agents'): string {
  return mode === 'agents' ? join(agentsHome(), 'skills') : join(home, 'skills')
}

/** Read one skill directory as an atomic snapshot. */
export async function readSkillDir(root: string, name: string): Promise<SkillValue | undefined> {
  if (!SKILL_NAME_RE.test(name)) throw new SyncError('validation', `invalid skill name: ${name}`)
  const dir = join(root, name)
  let info
  try {
    info = await stat(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isDirectory()) return undefined
  const files: Record<string, SkillFile> = {}
  let count = 0
  let bytes = 0
  await walk(dir, '', async (rel, absolute) => {
    count += 1
    if (count > MAX_SKILL_FILES) throw new SyncError('skill', `skill ${name} has more than ${MAX_SKILL_FILES} files`)
    const buffer = await readFile(absolute)
    bytes += buffer.byteLength
    if (buffer.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new SyncError('skill', `${rel} in skill ${name} is larger than ${MAX_SKILL_FILE_BYTES} bytes`)
    }
    if (bytes > MAX_SKILL_BYTES) throw new SyncError('skill', `skill ${name} is larger than ${MAX_SKILL_BYTES} bytes`)
    const text = decodeText(buffer)
    files[rel] = text === undefined
      ? { encoding: 'base64', hash: sha256(buffer.toString('base64')), data: buffer.toString('base64') }
      : { encoding: 'utf8', hash: sha256(buffer.toString('utf8')), data: text }
  })
  if (!hasInstructionFile(name, files)) return undefined
  return { name, files }
}

export function skillHash(value: SkillValue): string {
  const list = Object.entries(value.files)
    .map(([rel, file]) => [rel, file.hash])
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
  return sha256(canonicalJson([value.name, list]))
}

export function skillBytes(value: SkillValue): number {
  let total = 0
  for (const file of Object.values(value.files)) total += Buffer.byteLength(file.data)
  return total
}

export function assertSkillValue(value: unknown): SkillValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyncError('skill', 'a skill snapshot must be an object')
  }
  const candidate = value as Partial<SkillValue>
  if (typeof candidate.name !== 'string' || !SKILL_NAME_RE.test(candidate.name)) {
    throw new SyncError('skill', 'a skill snapshot has an invalid name')
  }
  if (candidate.files === null || typeof candidate.files !== 'object' || Array.isArray(candidate.files)) {
    throw new SyncError('skill', 'a skill snapshot has no files')
  }
  const files: Record<string, SkillFile> = {}
  let total = 0
  for (const [rel, raw] of Object.entries(candidate.files)) {
    assertRelPath(rel)
    if (raw === null || typeof raw !== 'object') throw new SyncError('skill', `skill file ${rel} is malformed`)
    const file = raw as Partial<SkillFile>
    if (file.encoding !== 'utf8' && file.encoding !== 'base64') throw new SyncError('skill', `skill file ${rel} has no encoding`)
    if (typeof file.data !== 'string') throw new SyncError('skill', `skill file ${rel} has no data`)
    const buffer = file.encoding === 'base64' ? Buffer.from(file.data, 'base64') : Buffer.from(file.data, 'utf8')
    if (buffer.byteLength > MAX_SKILL_FILE_BYTES) throw new SyncError('skill', `skill file ${rel} is too large`)
    total += buffer.byteLength
    if (total > MAX_SKILL_BYTES) throw new SyncError('skill', `skill ${candidate.name} is too large`)
    files[rel] = {
      encoding: file.encoding,
      data: file.data,
      hash: typeof file.hash === 'string' && file.hash.length === 64 ? file.hash : sha256(buffer.toString(file.encoding === 'base64' ? 'base64' : 'utf8')),
    }
  }
  if (!hasInstructionFile(candidate.name, files)) {
    throw new SyncError('skill', `skill ${candidate.name} has no SKILL.md`)
  }
  return { name: candidate.name, files }
}

/** Replace one skill directory with the snapshot. */
export async function writeSkillDir(root: string, value: SkillValue): Promise<void> {
  const target = join(root, value.name)
  await rm(target, { recursive: true, force: true })
  for (const [rel, file] of Object.entries(value.files)) {
    assertRelPath(rel)
    const path = join(target, ...rel.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.encoding === 'base64' ? Buffer.from(file.data, 'base64') : file.data, 'utf8')
  }
}

/** Copy a directory tree without following symlinks. */
export async function copyDirSafe(source: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true })
  await cp(source, target, {
    recursive: true,
    force: true,
    filter: async path => {
      const info = await lstat(path).catch(() => undefined)
      return info !== undefined && !info.isSymbolicLink()
    },
  })
}

export function assertRelPath(rel: string): void {
  if (rel === '' || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new SyncError('skill', `invalid skill file path: ${rel}`)
  }
  const normalized = posix.normalize(rel)
  if (normalized !== rel || normalized.startsWith('../') || normalized === '..') {
    throw new SyncError('skill', `skill file path escapes the directory: ${rel}`)
  }
  for (const part of rel.split('/')) {
    if (part === '' || part === '.' || part === '..') throw new SyncError('skill', `invalid skill file path: ${rel}`)
  }
}

async function walk(
  root: string,
  rel: string,
  visit: (rel: string, absolute: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(join(root, rel), { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(root, next, visit)
      continue
    }
    if (entry.isFile()) await visit(next, join(root, next))
  }
}

function hasInstructionFile(name: string, files: Record<string, SkillFile>): boolean {
  return Object.hasOwn(files, 'SKILL.md') || Object.hasOwn(files, `${name}.md`)
}

function decodeText(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) return undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    if (Buffer.byteLength(text, 'utf8') !== buffer.byteLength) return undefined
    return text
  } catch {
    return undefined
  }
}
