import { hostname } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { writeAtomic } from './backend.js'
import { SyncError } from './errors.js'
import {
  assertBackend,
  assertGitBranch,
  assertGitUrl,
  assertLocalOnlyMap,
  assertSelectedFiles,
  assertSelectedNamespaces,
  assertSelectedPresets,
  assertSelectedSkills,
  assertSkillRoot,
  assertSyncHooks,
  assertSyncDir,
} from './policy.js'
import { CONFIG_FILE, JOURNAL_FILE, SCHEMA_VERSION, STATE_DIR_NAME, STATE_FILE, type PersistedConfig, type PersistedState } from './protocol.js'
import { isPlainObject, randomId } from './util.js'

export interface Paths {
  stateDir: string
  config: string
  state: string
  journal: string
  backups: string
}

export function bagPaths(home: string): Paths {
  const stateDir = join(home, 'state', STATE_DIR_NAME)
  return {
    stateDir,
    config: join(stateDir, CONFIG_FILE),
    state: join(stateDir, STATE_FILE),
    journal: join(stateDir, JOURNAL_FILE),
    backups: join(stateDir, 'backups'),
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export function defaultConfig(): PersistedConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: randomId(6),
    deviceName: safeHostname(),
    backend: 'folder',
    syncDir: '',
    gitUrl: '',
    gitBranch: 'main',
    selectedNamespaces: [],
    selectedFiles: [],
    selectedSkills: [],
    selectedPresets: [],
    syncHooks: false,
    skillRoot: 'dsh',
    localOnlyKeys: {},
    intervalMinutes: 0,
    autoApplySafe: false,
  }
}

export function defaultState(): PersistedState {
  return { schemaVersion: SCHEMA_VERSION, base: { items: {} }, rejected: {}, lastOperation: null }
}

export async function loadConfig(paths: Paths): Promise<PersistedConfig> {
  const raw = await readJsonFile(paths.config)
  if (raw === undefined) return defaultConfig()
  if (!isPlainObject(raw) || raw.schemaVersion !== SCHEMA_VERSION) {
    throw new SyncError('schema', `${CONFIG_FILE} uses an unsupported schema version`)
  }
  const fallback = defaultConfig()
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId.length >= 4 ? raw.deviceId : fallback.deviceId,
    deviceName: typeof raw.deviceName === 'string' && raw.deviceName.trim() !== '' ? raw.deviceName : fallback.deviceName,
    backend: raw.backend === 'git' ? 'git' : 'folder',
    syncDir: typeof raw.syncDir === 'string' ? raw.syncDir : '',
    gitUrl: typeof raw.gitUrl === 'string' ? raw.gitUrl : '',
    gitBranch: typeof raw.gitBranch === 'string' && raw.gitBranch.trim() !== '' ? raw.gitBranch : 'main',
    selectedNamespaces: Array.isArray(raw.selectedNamespaces) ? raw.selectedNamespaces.filter((ns): ns is string => typeof ns === 'string') : [],
    selectedFiles: Array.isArray(raw.selectedFiles) ? raw.selectedFiles.filter((id): id is string => typeof id === 'string') : [],
    selectedSkills: Array.isArray(raw.selectedSkills) ? raw.selectedSkills.filter((name): name is string => typeof name === 'string') : [],
    selectedPresets: Array.isArray(raw.selectedPresets) ? raw.selectedPresets.filter((id): id is string => typeof id === 'string') : [],
    syncHooks: raw.syncHooks === true,
    skillRoot: raw.skillRoot === 'agents' ? 'agents' : 'dsh',
    localOnlyKeys: isPlainObject(raw.localOnlyKeys) ? (raw.localOnlyKeys as Record<string, string[]>) : {},
    intervalMinutes: typeof raw.intervalMinutes === 'number' && raw.intervalMinutes >= 0 ? Math.floor(raw.intervalMinutes) : 0,
    autoApplySafe: raw.autoApplySafe === true,
  }
}

export async function saveConfig(paths: Paths, config: PersistedConfig): Promise<void> {
  await ensureDir(paths.stateDir)
  await writeAtomic(paths.config, `${JSON.stringify(config, null, 2)}\n`)
}

/** Validate a partial config patch from the Settings page. */
export function normalizeConfigPatch(
  current: PersistedConfig,
  patch: unknown,
  home: string,
): PersistedConfig {
  if (!isPlainObject(patch)) throw new SyncError('validation', 'config patch must be an object')
  const next: PersistedConfig = { ...current }
  if (patch.backend !== undefined) next.backend = assertBackend(patch.backend)
  if (patch.gitUrl !== undefined) {
    next.gitUrl = typeof patch.gitUrl === 'string' && patch.gitUrl.trim() === '' ? '' : assertGitUrl(patch.gitUrl)
  }
  if (patch.gitBranch !== undefined) next.gitBranch = assertGitBranch(patch.gitBranch)
  if (patch.syncDir !== undefined) {
    next.syncDir = patch.syncDir === '' ? '' : assertSyncDir(patch.syncDir, home)
  }
  if (patch.selectedNamespaces !== undefined) {
    next.selectedNamespaces = assertSelectedNamespaces(patch.selectedNamespaces)
  }
  if (patch.selectedFiles !== undefined) {
    next.selectedFiles = assertSelectedFiles(patch.selectedFiles)
  }
  if (patch.selectedSkills !== undefined) {
    next.selectedSkills = assertSelectedSkills(patch.selectedSkills)
  }
  if (patch.selectedPresets !== undefined) {
    next.selectedPresets = assertSelectedPresets(patch.selectedPresets)
  }
  if (patch.syncHooks !== undefined) {
    next.syncHooks = assertSyncHooks(patch.syncHooks)
  }
  if (patch.skillRoot !== undefined) {
    next.skillRoot = assertSkillRoot(patch.skillRoot)
  }
  if (patch.localOnlyKeys !== undefined) {
    next.localOnlyKeys = assertLocalOnlyMap(patch.localOnlyKeys)
  }
  if (patch.intervalMinutes !== undefined) {
    if (typeof patch.intervalMinutes !== 'number' || !Number.isFinite(patch.intervalMinutes) || patch.intervalMinutes < 0) {
      throw new SyncError('validation', 'intervalMinutes must be a non-negative number')
    }
    next.intervalMinutes = Math.min(24 * 60, Math.floor(patch.intervalMinutes))
  }
  if (patch.autoApplySafe !== undefined) {
    if (typeof patch.autoApplySafe !== 'boolean') throw new SyncError('validation', 'autoApplySafe must be a boolean')
    next.autoApplySafe = patch.autoApplySafe
  }
  if (patch.deviceName !== undefined) {
    if (typeof patch.deviceName !== 'string' || patch.deviceName.trim() === '') {
      throw new SyncError('validation', 'deviceName must be a non-empty string')
    }
    next.deviceName = patch.deviceName.trim().slice(0, 64)
  }
  return next
}

export async function loadState(paths: Paths): Promise<PersistedState> {
  const raw = await readJsonFile(paths.state)
  if (raw === undefined) return defaultState()
  if (!isPlainObject(raw) || raw.schemaVersion !== SCHEMA_VERSION) {
    throw new SyncError('schema', `${STATE_FILE} uses an unsupported schema version`)
  }
  const base = isPlainObject(raw.base) && isPlainObject(raw.base.items) ? raw.base : { items: {} }
  return {
    schemaVersion: SCHEMA_VERSION,
    base: base as unknown as PersistedState['base'],
    rejected: isPlainObject(raw.rejected)
      ? Object.fromEntries(
        Object.entries(raw.rejected).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
      : {},
    lastOperation: isPlainObject(raw.lastOperation)
      ? (raw.lastOperation as unknown as PersistedState['lastOperation'])
      : null,
  }
}

export async function saveState(paths: Paths, state: PersistedState): Promise<void> {
  await ensureDir(paths.stateDir)
  await writeAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`)
}

async function readJsonFile(path: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new SyncError('schema', `${path} is not valid JSON`)
  }
}

function safeHostname(): string {
  try {
    const name = hostname()
    return name.length > 0 ? name.slice(0, 64) : 'device'
  } catch {
    return 'device'
  }
}
