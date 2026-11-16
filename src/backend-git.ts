import { execFile } from 'node:child_process'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  mergeDeviceFiles,
  readDeviceFile,
  writeAtomic,
  type RemoteSnapshot,
  type SyncBackend,
} from './backend.js'
import { SyncError, messageOf } from './errors.js'
import { DEVICES_DIR, MAX_DEVICES, META_FILE, SCHEMA_VERSION, type DeviceFile, type SnapshotItem } from './protocol.js'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 120_000

/**
 * Git backend. The sidecar repository lives under the dsh-bag state directory,
 * never in the user's files. Authentication is delegated to the user's git
 * environment (credential helper / SSH agent); credentials are never stored.
 */
export class GitBackend implements SyncBackend {
  private ready: Promise<void> | undefined

  constructor(
    readonly repoDir: string,
    readonly remoteUrl: string,
    readonly branch: string,
    readonly deviceId: string,
    readonly deviceName: string,
  ) {}

  get devicesDir(): string {
    return join(this.repoDir, DEVICES_DIR)
  }

  get ownPath(): string {
    return join(this.devicesDir, `${this.deviceId}.json`)
  }

  async ensure(): Promise<void> {
    this.ready ??= this.initRepo()
    await this.ready
  }

  /** Non-mutating remote probe used by Doctor. */
  static async probe(remoteUrl: string, branch: string): Promise<void> {
    try {
      await execFileAsync('git', ['ls-remote', '--heads', remoteUrl, branch], {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      })
    } catch (error) {
      const detail = (error as { stderr?: string; stdout?: string; message?: string })
      const text = (detail.stderr || detail.stdout || detail.message || String(error)).trim()
      throw new SyncError('git', `git ls-remote failed: ${sanitize(text)}`)
    }
  }

  async readOwn(): Promise<DeviceFile | undefined> {
    return readDeviceFile(this.ownPath)
  }

  async readRemote(): Promise<RemoteSnapshot> {
    await this.ensure()
    await this.pull()
    let names: string[]
    try {
      names = (await readdir(this.devicesDir)).filter(name => name.endsWith('.json')).sort()
    } catch {
      return { items: new Map(), devices: 0, digest: 'empty' }
    }
    if (names.length > MAX_DEVICES) throw new SyncError('git', `the repository holds more than ${MAX_DEVICES} device snapshots`)
    const entries: Array<{ device: string; file: DeviceFile }> = []
    for (const name of names) {
      const file = await readDeviceFile(join(this.devicesDir, name))
      if (file !== undefined) entries.push({ device: file.device.id, file })
    }
    return mergeDeviceFiles(entries)
  }

  async writeOwn(items: Record<string, SnapshotItem>): Promise<DeviceFile> {
    await this.ensure()
    await this.pull()
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
    await mkdir(this.devicesDir, { recursive: true })
    await writeAtomic(this.ownPath, `${JSON.stringify(next, null, 2)}\n`)
    await this.commit(`dsh-bag: ${this.deviceName} ${new Date().toISOString()}`)
    await this.pushWithRetry()
    return next
  }

  private async initRepo(): Promise<void> {
    await mkdir(this.repoDir, { recursive: true })
    const gitDir = join(this.repoDir, '.git')
    const initialized = await stat(gitDir).then(info => info.isDirectory()).catch(() => false)
    if (!initialized) {
      try {
        await this.git(['init', '-b', this.branch])
      } catch {
        await this.git(['init'])
        await this.git(['checkout', '-b', this.branch])
      }
    }
    await this.ensureUser()
    const remotes = await this.git(['remote']).catch(() => '')
    if (remotes.split(/\s+/).includes('origin')) await this.git(['remote', 'set-url', 'origin', this.remoteUrl])
    else await this.git(['remote', 'add', 'origin', this.remoteUrl])
    await mkdir(this.devicesDir, { recursive: true })

    let fetched = false
    try {
      await this.git(['fetch', 'origin', this.branch])
      fetched = true
    } catch {
      // A brand-new remote has no ref yet.
    }
    const hasHead = await this.git(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false)
    if (fetched && !hasHead) {
      await this.git(['checkout', '-B', this.branch, 'FETCH_HEAD'])
    } else if (fetched) {
      await this.mergeFetched()
    }

    const metaPath = join(this.repoDir, META_FILE)
    if (await stat(metaPath).then(() => false).catch(() => true)) {
      await writeAtomic(metaPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, app: 'dsh-bag', updatedAt: Date.now() }, null, 2)}\n`)
    }
    await this.commit('dsh-bag: init')
    await this.pushWithRetry()
  }

  private async pull(): Promise<void> {
    try {
      await this.git(['fetch', 'origin', this.branch])
    } catch {
      return
    }
    const hasHead = await this.git(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false)
    if (!hasHead) {
      await this.git(['checkout', '-B', this.branch, 'FETCH_HEAD'])
      return
    }
    await this.mergeFetched()
  }

  private async mergeFetched(): Promise<void> {
    try {
      await this.git(['merge', '--ff-only', 'FETCH_HEAD'])
    } catch {
      try {
        await this.git(['merge', '--no-edit', 'FETCH_HEAD'])
      } catch (error) {
        throw new SyncError('git', `could not merge the remote branch: ${messageOf(error)}`)
      }
    }
  }

  private async commit(message: string): Promise<void> {
    await this.git(['add', '-A'])
    const status = await this.git(['status', '--porcelain'])
    if (status.trim() === '') return
    await this.git(['commit', '-m', message])
  }

  private async pushWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.git(['push', '-u', 'origin', `HEAD:${this.branch}`])
        return
      } catch (error) {
        if (attempt === 1) throw error
        await this.pull()
      }
    }
  }

  private async ensureUser(): Promise<void> {
    const name = await this.git(['config', '--get', 'user.name']).catch(() => '')
    if (name.trim() === '') await this.git(['config', 'user.name', 'dsh-bag'])
    const email = await this.git(['config', '--get', 'user.email']).catch(() => '')
    if (email.trim() === '') await this.git(['config', 'user.email', 'dsh-bag@localhost'])
  }

  private async git(args: readonly string[]): Promise<string> {
    try {
      const result = await execFileAsync('git', [...args], {
        cwd: this.repoDir,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
      })
      return result.stdout
    } catch (error) {
      const detail = (error as { stderr?: string; stdout?: string; message?: string })
      const text = (detail.stderr || detail.stdout || detail.message || String(error)).trim()
      throw new SyncError('git', `git ${args[0] ?? ''} failed: ${sanitize(text)}`)
    }
  }
}

/** Strip credentials that a git error message may echo. */
function sanitize(text: string): string {
  return text
    .replace(/https?:\/\/[^/@\s]+@/gi, 'https://***@')
    .replace(/([?&](?:token|access_token|password)=)[^&\s]+/gi, '$1***')
    .slice(0, 1200)
}
