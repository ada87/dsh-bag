/**
 * Wire and engine vocabulary shared by the Host half, the Settings page and
 * the tests. No Node APIs here.
 */

export const SCHEMA_VERSION = 1 as const
export const BASE_PATH = '/dsh-bag'
export const STATE_DIR_NAME = 'dsh-bag'
export const CONFIG_FILE = 'config.json'
export const STATE_FILE = 'state.json'
export const JOURNAL_FILE = 'journal.json'
export const DEVICES_DIR = 'devices'
export const META_FILE = 'meta.json'

export const MAX_BODY_BYTES = 256 * 1024
export const MAX_DEVICE_FILE_BYTES = 2 * 1024 * 1024
export const MAX_ITEM_TEXT_BYTES = 256 * 1024
export const MAX_DEVICES = 64
export const PLAN_TTL_MS = 10 * 60 * 1000

/** How a synced item may affect the running Host. */
export type ItemClass = 'safe-live' | 'restart' | 'executable'

export type ItemKind = 'settings' | 'file'

export type ItemRelation = 'local-only' | 'remote-only' | 'converged' | 'conflict' | 'mergeable'

export type ConflictDecision = 'keep-local' | 'take-remote'

/** One dotted-path conflict inside a settings namespace. */
export interface PathConflict {
  path: string[]
  local?: unknown
  remote?: unknown
  base?: unknown
}

export interface PlanItem {
  id: string
  kind: ItemKind
  cls: ItemClass
  relation: ItemRelation
  label: string
  localHash?: string
  remoteHash?: string
  baseHash?: string
  /** Redacted unified preview for raw files. */
  preview?: string
  conflicts?: PathConflict[]
  /** Whether applying this item writes the local machine. */
  writes: boolean
  /** Settings namespace revision the plan was built at. */
  revision?: number
}

export interface SyncPlan {
  id: string
  createdAt: number
  syncDir: string
  items: PlanItem[]
  warnings: string[]
  executable: number
  conflicts: number
  writes: number
}

export interface StatusCounts {
  selectedNamespaces: number
  selectedFiles: number
  localItems: number
  remoteItems: number
  remoteDevices: number
}

export interface Status {
  schemaVersion: 1
  configured: boolean
  syncDir: string
  device: DeviceIdentity
  auth: 'trusted'
  settingsWritable: boolean
  journal: 'none' | 'incomplete'
  lastOperation: LastOperation | null
  counts: StatusCounts
  warnings: string[]
}

export interface DeviceIdentity {
  id: string
  name: string
}

export interface LastOperation {
  id: string
  op: 'apply' | 'push' | 'recover'
  at: string
  ok: boolean
  message?: string
}

export interface BaseItem {
  hash: string
  cls: ItemClass
  value: unknown
  updatedAt: number
}

export interface BaseState {
  items: Record<string, BaseItem>
}

export interface PersistedState {
  schemaVersion: 1
  base: BaseState
  /** Item id → remote hash the operator chose to keep local against. */
  rejected: Record<string, string>
  lastOperation: LastOperation | null
}

export interface PersistedConfig {
  schemaVersion: 1
  deviceId: string
  deviceName: string
  syncDir: string
  selectedNamespaces: string[]
  selectedFiles: string[]
  /** Namespace → dotted key prefixes that never leave this machine. */
  localOnlyKeys: Record<string, string[]>
  intervalMinutes: number
  autoApplySafe: boolean
}

export interface SnapshotItem {
  id: string
  kind: ItemKind
  cls: ItemClass
  hash: string
  value: unknown
  updatedAt: number
}

export interface DeviceFile {
  schemaVersion: 1
  device: DeviceIdentity
  updatedAt: number
  items: Record<string, Omit<SnapshotItem, 'id' | 'kind'>>
}

export interface DoctorIssue {
  code: string
  severity: 'info' | 'warn' | 'error'
  message: string
}

export interface DoctorReport {
  ok: boolean
  issues: DoctorIssue[]
}

export interface ApplyInput {
  planId: string
  ids?: string[]
  decisions?: Array<{ id: string; path: string[]; decision: ConflictDecision }>
  allowExecutable?: boolean
}

export interface ApplyResult {
  applied: string[]
  skipped: string[]
  conflicts: string[]
  restartRequired: string[]
  installRequired: string[]
  operation: LastOperation
}
