import { isAbsolute, relative, resolve } from 'node:path'
import { SyncError } from './errors.js'
import type { ItemClass } from './protocol.js'
import { SKILL_NAME_RE } from './skills.js'
import { isPlainObject } from './util.js'

export interface FileSpec {
  id: string
  rel: string
  cls: ItemClass
  label: string
}

/**
 * Positive allowlist: every synced file is enumerated here. The plugin never
 * walks the dsh home and subtracts a deny list.
 */
export const FILE_SPECS: readonly FileSpec[] = [
  {
    id: 'file:profiles/web/package.json',
    rel: 'profiles/web/package.json',
    cls: 'restart',
    label: 'Web profile plugins',
  },
  {
    id: 'file:profiles/web/cordis.patch.yml',
    rel: 'profiles/web/cordis.patch.yml',
    cls: 'executable',
    label: 'Web profile patch',
  },
  {
    id: 'file:profiles/headless/package.json',
    rel: 'profiles/headless/package.json',
    cls: 'restart',
    label: 'Headless profile plugins',
  },
  {
    id: 'file:profiles/headless/cordis.patch.yml',
    rel: 'profiles/headless/cordis.patch.yml',
    cls: 'executable',
    label: 'Headless profile patch',
  },
  {
    id: 'file:cordis.patch.yml',
    rel: 'cordis.patch.yml',
    cls: 'executable',
    label: 'Home patch',
  },
  {
    id: 'file:AGENTS.md',
    rel: 'AGENTS.md',
    cls: 'executable',
    label: 'Global instructions',
  },
]

const BY_ID = new Map(FILE_SPECS.map(spec => [spec.id, spec]))

export const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function fileSpec(id: string): FileSpec | undefined {
  return BY_ID.get(id)
}

export function settingsItemId(ns: string): string {
  return `settings:${ns}`
}

export function parseItemId(id: string): { kind: 'settings'; ns: string } | { kind: 'file'; spec: FileSpec } | { kind: 'skill'; name: string } | { kind: 'preset'; id: string } | { kind: 'hooks' } | undefined {
  if (id.startsWith('settings:')) {
    const ns = id.slice('settings:'.length)
    if (!NAMESPACE_RE.test(ns)) return undefined
    return { kind: 'settings', ns }
  }
  if (id.startsWith('skill:')) {
    const name = id.slice('skill:'.length)
    if (!SKILL_NAME_RE.test(name)) return undefined
    return { kind: 'skill', name }
  }
  if (id.startsWith('preset:')) {
    const preset = id.slice('preset:'.length)
    if (!PRESET_ID_RE.test(preset)) return undefined
    return { kind: 'preset', id: preset }
  }
  if (id === 'hooks') return { kind: 'hooks' }
  const spec = BY_ID.get(id)
  if (spec !== undefined) return { kind: 'file', spec }
  return undefined
}

export function assertSelectedSkills(input: unknown): string[] {
  if (!Array.isArray(input)) throw new SyncError('validation', 'selectedSkills must be an array')
  return [...new Set(input.map(name => {
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
      throw new SyncError('validation', `invalid skill id: ${String(name)}`)
    }
    return name
  }))]
}

export function assertSkillRoot(input: unknown): 'dsh' | 'agents' {
  if (input !== 'dsh' && input !== 'agents') throw new SyncError('validation', 'skillRoot must be "dsh" or "agents"')
  return input
}

export function assertSelectedPresets(input: unknown): string[] {
  if (!Array.isArray(input)) throw new SyncError('validation', 'selectedPresets must be an array')
  return [...new Set(input.map(id => {
    if (typeof id !== 'string' || !PRESET_ID_RE.test(id)) {
      throw new SyncError('validation', `invalid preset id: ${String(id)}`)
    }
    return id
  }))]
}

export function assertSyncHooks(input: unknown): boolean {
  if (typeof input !== 'boolean') throw new SyncError('validation', 'syncHooks must be a boolean')
  return input
}

export type BackendKind = 'folder' | 'git'

export function assertBackend(input: unknown): BackendKind {
  if (input !== 'folder' && input !== 'git') throw new SyncError('validation', 'backend must be "folder" or "git"')
  return input
}

export function assertGitUrl(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') throw new SyncError('validation', 'gitUrl is required')
  const url = input.trim()
  if (/\s/.test(url)) throw new SyncError('validation', 'gitUrl must not contain whitespace')
  if (/^https?:\/\/[^/]*@/i.test(url)) {
    throw new SyncError('validation', 'gitUrl must not embed credentials; use a credential helper or SSH')
  }
  const allowed = /^(?:https?|ssh|git|file):\/\//i.test(url)
    || /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(url)
  if (!allowed) throw new SyncError('validation', 'gitUrl must be https://, ssh://, git://, file:// or user@host:path')
  return url
}

export function assertGitBranch(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') throw new SyncError('validation', 'gitBranch is required')
  const branch = input.trim()
  if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,120}$/.test(branch)) {
    throw new SyncError('validation', `invalid git branch: ${branch}`)
  }
  return branch
}

export function assertNamespace(ns: unknown): string {
  if (typeof ns !== 'string' || !NAMESPACE_RE.test(ns)) {
    throw new SyncError('validation', `invalid settings namespace: ${String(ns)}`)
  }
  return ns
}

/** Refuse a sync directory that is the dsh home or sits inside it. */
export function assertSyncDir(raw: unknown, home: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SyncError('validation', 'sync directory is required')
  }
  if (!isAbsolute(raw.trim())) {
    throw new SyncError('validation', 'sync directory must be an absolute path')
  }
  const dir = resolve(raw.trim())
  const rel = relative(resolve(home), dir)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new SyncError('validation', 'sync directory must be outside the dsh home')
  }
  const relHome = relative(dir, resolve(home))
  if (relHome === '' || (!relHome.startsWith('..') && !isAbsolute(relHome))) {
    throw new SyncError('validation', 'sync directory must not contain the dsh home')
  }
  return dir
}

/** Remove dotted local-only prefixes from a settings user layer. */
export function stripLocalOnly(value: unknown, prefixes: readonly string[]): unknown {
  if (prefixes.length === 0) return value
  const paths = prefixes
    .map(prefix => prefix.split('.').filter(Boolean))
    .filter(path => path.length > 0)
  if (paths.length === 0) return value
  return stripAt(value, paths, [])
}

function stripAt(value: unknown, paths: string[][], here: string[]): unknown {
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const next = [...here, key]
    if (paths.some(path => samePrefix(path, next))) continue
    if (paths.some(path => startsWith(path, next))) {
      out[key] = stripAt(child, paths, next)
      continue
    }
    out[key] = child
  }
  return out
}

function samePrefix(path: string[], prefix: string[]): boolean {
  return path.length === prefix.length && path.every((part, index) => part === prefix[index])
}

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => part === path[index])
}

export function assertLocalOnlyMap(input: unknown): Record<string, string[]> {
  if (input === undefined || input === null) return {}
  if (!isPlainObject(input)) throw new SyncError('validation', 'localOnlyKeys must be an object')
  const out: Record<string, string[]> = {}
  for (const [ns, value] of Object.entries(input)) {
    assertNamespace(ns)
    if (!Array.isArray(value)) throw new SyncError('validation', `localOnlyKeys.${ns} must be an array`)
    const keys = value.map(entry => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new SyncError('validation', `localOnlyKeys.${ns} contains a non-string key`)
      }
      if (entry.split('.').some(part => part === '')) {
        throw new SyncError('validation', `localOnlyKeys.${ns} contains an empty path segment: ${entry}`)
      }
      return entry
    })
    out[ns] = [...new Set(keys)]
  }
  return out
}

export function assertSelectedFiles(input: unknown): string[] {
  if (!Array.isArray(input)) throw new SyncError('validation', 'selectedFiles must be an array')
  const ids: string[] = []
  for (const value of input) {
    if (typeof value !== 'string' || BY_ID.get(value) === undefined) {
      throw new SyncError('validation', `unknown file item: ${String(value)}`)
    }
    ids.push(value)
  }
  return [...new Set(ids)]
}

export function assertSelectedNamespaces(input: unknown): string[] {
  if (!Array.isArray(input)) throw new SyncError('validation', 'selectedNamespaces must be an array')
  return [...new Set(input.map(assertNamespace))]
}
