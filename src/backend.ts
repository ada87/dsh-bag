import { hostname } from 'node:os'
import { mkdir, readFile, readdir, rename, stat, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { SyncError } from './errors.js'
import { DEVICES_DIR, MAX_DEVICE_FILE_BYTES, MAX_DEVICES, META_FILE, SCHEMA_VERSION, type DeviceFile, type ItemClass, type SnapshotItem } from './protocol.js'
import { canonicalJson, hashValue, isPlainObject, randomId, sha256 } from './util.js'

export interface RemoteItem {
  id: string
  hash: string
  cls: ItemClass
  value: unknown
  updatedAt: number
  device: string
}

export interface RemoteSnapshot {
  items: Map<string, RemoteItem>
  devices: number
  digest: string
}

const CLASSES: readonly ItemClass[] = ['safe-live', 'restart', 'executable']

/** Folder backend: each device owns one snapshot file, so no write collides. */
export class FolderBackend {
  constructor(
    readonly syncDir: string,
    readonly deviceId: string,
    readonly deviceName: string = safeHostname(),
  ) {}

  get devicesDir(): string {
    return join(this.syncDir, DEVICES_DIR)
  }

  get ownPath(): string {
    return join(this.devicesDir, `${this.deviceId}.json`)
  }

  async ensure(): Promise<void> {
    await mkdir(this.devicesDir, { recursive: true })
    const metaPath = join(this.syncDir, META_FILE)
    try {
      await stat(metaPath)
    } catch {
      await writeAtomic(metaPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, app: 'dsh-bag', updatedAt: Date.now() }, null, 2)}\n`)
    }
  }

  async readOwn(): Promise<DeviceFile | undefined> {
    return readDeviceFile(this.ownPath)
  }

  /** Merge every device snapshot, newest item timestamp wins. */
  async readRemote(): Promise<RemoteSnapshot> {
    const metaPath = join(this.syncDir, META_FILE)
    let metaRaw: string
    try {
      metaRaw = await readFile(metaPath, 'utf8')
    } catch {
      return { items: new Map(), devices: 0, digest: sha256('empty') }
    }
    let meta: unknown
    try {
      meta = JSON.parse(metaRaw)
    } catch {
      throw new SyncError('backend', `${META_FILE} is not valid JSON`)
    }
    if (!isPlainObject(meta) || meta.schemaVersion !== SCHEMA_VERSION) {
      throw new SyncError('schema', `${META_FILE} uses an unsupported schema version`)
    }

    let names: string[]
    try {
      names = (await readdir(this.devicesDir)).filter(name => name.endsWith('.json')).sort()
    } catch {
      return { items: new Map(), devices: 0, digest: sha256('empty') }
    }
    if (names.length > MAX_DEVICES) {
      throw new SyncError('backend', `the sync folder holds more than ${MAX_DEVICES} device snapshots`)
    }

    const items = new Map<string, RemoteItem>()
    const digestParts: string[] = []
    let devices = 0
    for (const name of names) {
      const path = join(this.devicesDir, name)
      const file = await readDeviceFile(path)
      if (file === undefined) continue
      devices += 1
      const device = file.device.id === this.deviceId ? this.deviceId : file.device.id
      digestParts.push(`${device}:${file.updatedAt}:${Object.keys(file.items).length}`)
      for (const [id, entry] of Object.entries(file.items)) {
        const current = items.get(id)
        if (current === undefined || entry.updatedAt > current.updatedAt
          || (entry.updatedAt === current.updatedAt && device > current.device)) {
          items.set(id, { id, hash: entry.hash, cls: entry.cls, value: entry.value, updatedAt: entry.updatedAt, device })
        }
      }
    }
    return { items, devices, digest: sha256(digestParts.join('|')) }
  }

  /**
   * Write this device's snapshot. An item whose hash did not change keeps its
   * previous timestamp, so a push does not make every key look newer.
   */
  async writeOwn(items: Record<string, SnapshotItem>): Promise<DeviceFile> {
    await this.ensure()
    const previous = await this.readOwn()
    const now = Date.now()
    const next: DeviceFile = {
      schemaVersion: SCHEMA_VERSION,
      device: previous?.device ?? { id: this.deviceId, name: this.deviceName },
      updatedAt: now,
      items: {},
    }
    for (const [id, item] of Object.entries(items)) {
      const before = previous?.items[id]
      next.items[id] = {
        hash: item.hash,
        cls: item.cls,
        value: item.value,
        updatedAt: before !== undefined && before.hash === item.hash ? before.updatedAt : now,
      }
    }
    const text = `${JSON.stringify(next, null, 2)}\n`
    if (Buffer.byteLength(text) > MAX_DEVICE_FILE_BYTES) {
      throw new SyncError('backend', 'the device snapshot is too large')
    }
    await writeAtomic(this.ownPath, text)
    return next
  }

  /** Digest of the local item set, used for persistence only. */
  static digestOf(items: Record<string, unknown>): string {
    return hashValue(items)
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

async function readDeviceFile(path: string): Promise<DeviceFile | undefined> {
  let info
  try {
    info = await stat(path)
  } catch {
    return undefined
  }
  if (!info.isFile() || info.size > MAX_DEVICE_FILE_BYTES) return undefined
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isPlainObject(value) || value.schemaVersion !== SCHEMA_VERSION) return undefined
  const device = value.device
  if (!isPlainObject(device) || typeof device.id !== 'string' || device.id.length < 1 || device.id.length > 64) return undefined
  if (typeof value.updatedAt !== 'number' || !isPlainObject(value.items)) return undefined
  const items: DeviceFile['items'] = {}
  for (const [id, entry] of Object.entries(value.items)) {
    if (!isValidId(id) || !isPlainObject(entry)) continue
    const hash = entry.hash
    const cls = entry.cls
    const updatedAt = entry.updatedAt
    if (typeof hash !== 'string' || hash.length !== 64) continue
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue
    if (typeof cls !== 'string' || !CLASSES.includes(cls as ItemClass)) continue
    const text = canonicalJson(entry.value)
    if (Buffer.byteLength(text) > MAX_DEVICE_FILE_BYTES) continue
    items[id] = { hash, cls: cls as ItemClass, value: entry.value, updatedAt }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    device: { id: device.id, name: typeof device.name === 'string' ? device.name : device.id },
    updatedAt: value.updatedAt,
    items,
  }
}

function isValidId(id: string): boolean {
  return id.startsWith('settings:') || id.startsWith('file:') || id.startsWith('skill:')
    || id.startsWith('preset:') || id === 'hooks'
}

/** Write a sibling temp file then rename, retrying Windows transient locks. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomId(4)}.tmp`
  try {
    await writeFile(temp, text, 'utf8')
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, path)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
        await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
      }
    }
  } catch (error) {
    try {
      await unlink(temp)
    } catch {
      // Already gone.
    }
    throw error
  }
}
