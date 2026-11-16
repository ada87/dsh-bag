import { readFile, rm } from 'node:fs/promises'
import { writeAtomic } from './backend.js'
import { SCHEMA_VERSION } from './protocol.js'
import type { SettingsPathOpLike } from './host.js'
import { isPlainObject } from './util.js'

export interface JournalFileEntry {
  id: string
  livePath: string
  backupPath: string
  hashBefore: string | null
  existed: boolean
}

export interface JournalSettingsEntry {
  ns: string
  expectedRevision: number
  ops: SettingsPathOpLike[]
  compensation: SettingsPathOpLike[]
}

export interface JournalDirEntry {
  id: string
  livePath: string
  backupPath: string
  existed: boolean
}

export interface Journal {
  schemaVersion: 1
  operationId: string
  op: 'apply'
  startedAt: string
  status: 'APPLYING' | 'DONE'
  files: JournalFileEntry[]
  dirs?: JournalDirEntry[]
  settings: JournalSettingsEntry[]
}

export async function readJournal(path: string): Promise<Journal | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isPlainObject(value) || value.schemaVersion !== SCHEMA_VERSION) return undefined
  if (typeof value.operationId !== 'string' || !Array.isArray(value.files) || !Array.isArray(value.settings)) return undefined
  return value as unknown as Journal
}

export async function writeJournal(path: string, journal: Journal): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(journal, null, 2)}\n`)
}

export async function clearJournal(path: string): Promise<void> {
  await rm(path, { force: true })
}

export function journalIncomplete(journal: Journal | undefined): boolean {
  return journal !== undefined && journal.status !== 'DONE'
}
