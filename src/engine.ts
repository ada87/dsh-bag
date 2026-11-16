import { copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { FolderBackend, writeAtomic, type RemoteItem, type RemoteSnapshot } from './backend.js'
import {
  decryptBundle,
  encryptBundle,
  PAYLOAD_FORMAT,
  PAYLOAD_VERSION,
  type BundlePayload,
} from './bundle.js'
import { SyncError, messageOf } from './errors.js'
import type { SettingsDescriptorLike, SettingsPathOpLike, SettingsService } from './host.js'
import { clearJournal, journalIncomplete, readJournal, writeJournal, type Journal } from './journal.js'
import { applyDecisions, classify, diffOps, lineDiff, mergeMaps } from './merge.js'
import {
  assertSyncDir,
  fileSpec,
  parseItemId,
  settingsItemId,
  stripLocalOnly,
} from './policy.js'
import {
  MAX_ITEM_TEXT_BYTES,
  PLAN_TTL_MS,
  SCHEMA_VERSION,
  type ApplyInput,
  type ApplyResult,
  type DoctorIssue,
  type DoctorReport,
  type ItemClass,
  type ItemKind,
  type ItemRelation,
  type LastOperation,
  type PathConflict,
  type PersistedConfig,
  type PersistedState,
  type PlanItem,
  type SnapshotItem,
  type Status,
  type SyncPlan,
} from './protocol.js'
import { assertClean, scanText, type Finding } from './secret-scan.js'
import { hasVolatile, projectVolatile } from './settings.js'
import {
  bagPaths,
  defaultState,
  ensureDir,
  loadConfig,
  loadState,
  normalizeConfigPatch,
  saveConfig,
  saveState,
  type Paths,
} from './store.js'
import { canonicalJson, cloneJson, deepEqual, normalizeText, randomId, sha256 } from './util.js'

export interface EngineOptions {
  home: string
  settings?: SettingsService
  logger?: { info(message: string): void; warn(message: string): void }
}

interface CapturedItem {
  id: string
  kind: ItemKind
  cls: ItemClass
  hash: string
  value: unknown
  label: string
}

interface Capture {
  items: Map<string, CapturedItem>
  warnings: string[]
  findings: Finding[]
  revisions: Map<string, number>
  schemas: Map<string, unknown>
}

interface Target {
  value: unknown
  cls: ItemClass
  conflicts: PathConflict[]
  kind: ItemKind
}

interface PlanEntry {
  plan: SyncPlan
  createdAt: number
  source: 'folder' | 'bundle'
  remoteDigest: string
  readRemote: () => Promise<RemoteSnapshot>
  localHashes: Map<string, string | undefined>
  captureIds: string[]
  targets: Map<string, Target>
  revisions: Map<string, number>
}

/**
 * Policy-driven snapshot / reconciliation engine.
 *
 * Fetch never touches live files. Apply is journaled and reversible. The
 * folder backend gives every device its own snapshot, so two machines writing
 * through a dumb sync client never overwrite one file.
 */
export class SyncEngine {
  readonly paths: Paths
  private readonly plans = new Map<string, PlanEntry>()
  private readonly logger?: EngineOptions['logger']

  constructor(readonly options: EngineOptions) {
    this.paths = bagPaths(options.home)
    this.logger = options.logger
  }

  get home(): string {
    return this.options.home
  }

  private get settings(): SettingsService | undefined {
    return this.options.settings
  }

  async start(): Promise<void> {
    await ensureDir(this.paths.stateDir)
    const journal = await readJournal(this.paths.journal)
    if (journalIncomplete(journal)) {
      this.logger?.warn('[dsh-bag] a previous apply did not finish; open Settings -> Bag and run Repair')
    }
  }

  async status(): Promise<Status> {
    const config = await this.loadConfig()
    const warnings: string[] = []
    let localItems = 0
    let remoteItems = 0
    let remoteDevices = 0
    try {
      const capture = await this.capture(config)
      localItems = capture.items.size
      warnings.push(...capture.warnings)
      if (capture.findings.length > 0) {
        warnings.push(`secret scan: ${capture.findings.map(finding => `${finding.path} (${finding.rule})`).join(', ')}`)
      }
    } catch (error) {
      warnings.push(`local snapshot failed: ${messageOf(error)}`)
    }
    if (config.syncDir !== '') {
      try {
        const backend = new FolderBackend(config.syncDir, config.deviceId, config.deviceName)
        const remote = await backend.readRemote()
        remoteItems = remote.items.size
        remoteDevices = remote.devices
      } catch (error) {
        warnings.push(`sync folder failed: ${messageOf(error)}`)
      }
    }
    const journal = await readJournal(this.paths.journal)
    return {
      schemaVersion: SCHEMA_VERSION,
      configured: config.syncDir !== '',
      syncDir: config.syncDir,
      device: { id: config.deviceId, name: config.deviceName },
      auth: 'trusted',
      settingsWritable: this.settings !== undefined && this.settings.writable !== false,
      journal: journalIncomplete(journal) ? 'incomplete' : 'none',
      lastOperation: (await this.loadState()).lastOperation,
      counts: {
        selectedNamespaces: config.selectedNamespaces.length,
        selectedFiles: config.selectedFiles.length,
        localItems,
        remoteItems,
        remoteDevices,
      },
      warnings,
    }
  }

  async config(): Promise<PersistedConfig> {
    return this.loadConfig()
  }

  async updateConfig(patch: unknown): Promise<PersistedConfig> {
    const current = await this.loadConfig()
    const next = normalizeConfigPatch(current, patch, this.home)
    await saveConfig(this.paths, next)
    if (next.syncDir !== current.syncDir) this.plans.clear()
    const state = await this.loadState()
    state.base.items = pruneBase(state.base.items, next)
    state.rejected = pruneRejected(state.rejected, next)
    await saveState(this.paths, state)
    return next
  }

  /** Settings namespaces this profile exposes, with the user-layer and live flags. */
  async namespaces(): Promise<Array<{ ns: string; hasUser: boolean; secrets: number; live: boolean }>> {
    if (this.settings === undefined) return []
    const descriptors = this.settings.describe({ redactSecrets: true })
    return descriptors
      .map(descriptor => ({
        ns: descriptor.ns,
        hasUser: descriptor.user !== undefined && Object.keys(descriptor.user as object).length > 0,
        secrets: descriptor.secrets?.length ?? 0,
        live: hasVolatile(descriptor.schema),
      }))
      .sort((a, b) => a.ns.localeCompare(b.ns))
  }

  async plan(): Promise<SyncPlan> {
    const config = await this.requireConfigured()
    const capture = await this.capture(config)
    assertClean(capture.findings)
    const backend = new FolderBackend(config.syncDir, config.deviceId, config.deviceName)
    await backend.ensure()
    const remote = await backend.readRemote()
    return this.installPlan(config, capture, remote, () => backend.readRemote(), 'folder', [])
  }

  /** Encrypt the currently selected items into one portable file. */
  async exportBundle(password: string): Promise<{ filename: string; data: string; items: number; bytes: number }> {
    const config = await this.loadConfig()
    const capture = await this.capture(config)
    assertClean(capture.findings)
    if (capture.items.size === 0) throw new SyncError('bundle', 'nothing is selected: choose settings or files first')
    const payload: BundlePayload = {
      format: PAYLOAD_FORMAT,
      version: PAYLOAD_VERSION,
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      device: { id: config.deviceId, name: config.deviceName },
      items: Object.fromEntries(
        [...capture.items].map(([id, item]) => [id, { cls: item.cls, hash: item.hash, value: item.value }]),
      ),
      warnings: capture.warnings.slice(0, 20),
    }
    const envelope = await encryptBundle(payload, password)
    const data = `${JSON.stringify(envelope, null, 2)}\n`
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const name = config.deviceName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 32) || 'device'
    return {
      filename: `dsh-bag-${name}-${stamp}.dshbag`,
      data,
      items: capture.items.size,
      bytes: Buffer.byteLength(data, 'utf8'),
    }
  }

  /** Decrypt a bundle and compare it against this machine without writing. */
  async planBundle(fileText: string, password: string): Promise<SyncPlan> {
    const config = await this.loadConfig()
    const payload = await decryptBundle(fileText, password)
    const ids = new Set(Object.keys(payload.items))
    if (ids.size === 0) throw new SyncError('bundle', 'the bundle contains no items')
    const capture = await this.capture(config, ids)
    const built = this.remoteFromPayload(payload, capture, config)
    if (built.remote.items.size === 0) {
      throw new SyncError('bundle', built.warnings[0] ?? 'the bundle has no items this profile can apply')
    }
    return this.installPlan(config, capture, built.remote, async () => built.remote, 'bundle', built.warnings)
  }

  private async installPlan(
    config: PersistedConfig,
    capture: Capture,
    remote: RemoteSnapshot,
    readRemote: () => Promise<RemoteSnapshot>,
    source: 'folder' | 'bundle',
    extraWarnings: string[],
  ): Promise<SyncPlan> {
    const state = await this.loadState()
    const ids = new Set<string>([
      ...capture.items.keys(),
      ...remote.items.keys(),
      ...Object.keys(state.base.items),
    ])
    const items: PlanItem[] = []
    const targets = new Map<string, Target>()
    const warnings = [...extraWarnings, ...capture.warnings]

    for (const id of [...ids].sort()) {
      const parsed = parseItemId(id)
      if (parsed === undefined) continue
      const local = capture.items.get(id)
      const rem = remote.items.get(id)
      const base = state.base.items[id]
      const kind: ItemKind = local?.kind ?? (parsed.kind === 'settings' ? 'settings' : 'file')
      const cls: ItemClass = local?.cls ?? rem?.cls ?? 'safe-live'
      const label = local?.label ?? (parsed.kind === 'file' ? parsed.spec.label : parsed.ns)

      let relation: ItemRelation = classify(local?.hash, rem?.hash, base?.hash)
      if (rem !== undefined && local !== undefined && state.rejected[id] === rem.hash) {
        relation = 'local-only'
      }
      let conflicts: PathConflict[] = []
      let merged: unknown = relation === 'remote-only' ? rem?.value : local?.value

      if (kind === 'settings' && local !== undefined && rem !== undefined) {
        const parsedSettings = parseItemId(id)
        if (parsedSettings?.kind !== 'settings') continue
        const localOnly = config.localOnlyKeys[parsedSettings.ns] ?? []
        const remoteValue = projectVolatile(
          capture.schemas.get(parsedSettings.ns),
          stripLocalOnly(rem.value, localOnly),
        ) ?? {}
        const result = mergeMaps(base?.value, local.value, remoteValue)
        merged = result.value
        conflicts = result.conflicts
        if (relation !== 'converged' && relation !== 'local-only') {
          if (conflicts.length > 0) relation = 'conflict'
          else if (!deepEqual(merged, local.value)) relation = 'mergeable'
          else relation = 'local-only'
        }
      } else if (kind === 'file' && relation === 'conflict') {
        conflicts = [{ path: [] }]
        merged = local?.value
      }

      const writes = relation === 'remote-only'
        || (relation === 'mergeable' && !deepEqual(merged, local?.value))
        || relation === 'conflict'

      if (writes) {
        targets.set(id, { value: merged, cls, conflicts, kind })
      }

      let preview: string | undefined
      if (writes && kind === 'file') {
        const before = typeof local?.value === 'string' ? local.value : ''
        const after = typeof merged === 'string' ? merged : ''
        preview = lineDiff(before, after).slice(0, 8000)
      }

      items.push({
        id,
        kind,
        cls,
        relation,
        label,
        localHash: local?.hash,
        remoteHash: rem?.hash,
        baseHash: base?.hash,
        ...(preview === undefined ? {} : { preview }),
        ...(conflicts.length === 0 ? {} : { conflicts: conflicts.map(conflict => ({ path: conflict.path })) }),
        writes,
        ...(kind === 'settings' && parsed.kind === 'settings' ? { revision: capture.revisions.get(parsed.ns) } : {}),
      })
    }

    if (items.length === 0) warnings.push('nothing is selected yet: choose settings namespaces or profile files')
    if (source === 'folder' && config.syncDir === '') warnings.push('set the sync folder first')

    const plan: SyncPlan = {
      id: randomId(8),
      createdAt: Date.now(),
      source,
      syncDir: config.syncDir,
      items,
      warnings,
      executable: items.filter(item => item.writes && item.cls === 'executable').length,
      conflicts: items.filter(item => (item.conflicts?.length ?? 0) > 0).length,
      writes: items.filter(item => item.writes).length,
    }

    this.plans.set(plan.id, {
      plan,
      createdAt: Date.now(),
      source,
      remoteDigest: remote.digest,
      readRemote,
      localHashes: new Map(items.map(item => [item.id, capture.items.get(item.id)?.hash])),
      captureIds: [...capture.items.keys()],
      targets,
      revisions: capture.revisions,
    })
    while (this.plans.size > 5) {
      const oldest = [...this.plans.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (oldest === undefined) break
      this.plans.delete(oldest[0])
    }
    return plan
  }

  private remoteFromPayload(
    payload: BundlePayload,
    capture: Capture,
    config: PersistedConfig,
  ): { remote: RemoteSnapshot; warnings: string[] } {
    const items = new Map<string, RemoteItem>()
    const warnings: string[] = []
    const updatedAt = Number.isFinite(Date.parse(payload.createdAt)) ? Date.parse(payload.createdAt) : Date.now()

    for (const [id, entry] of Object.entries(payload.items)) {
      const parsed = parseItemId(id)
      if (parsed === undefined) {
        warnings.push(`bundle item ignored (not in the allowlist): ${id}`)
        continue
      }
      if (parsed.kind === 'settings') {
        if (!capture.items.has(id)) {
          warnings.push(`settings namespace ignored (not live in this profile): ${parsed.ns}`)
          continue
        }
        const value = projectVolatile(
          capture.schemas.get(parsed.ns),
          stripLocalOnly(entry.value, config.localOnlyKeys[parsed.ns] ?? []),
        )
        if (value === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) {
          warnings.push(`settings namespace ignored (no live fields): ${parsed.ns}`)
          continue
        }
        const text = canonicalJson(value)
        if (Buffer.byteLength(text, 'utf8') > MAX_ITEM_TEXT_BYTES) {
          warnings.push(`settings namespace ignored (too large): ${parsed.ns}`)
          continue
        }
        assertClean(scanText(`settings:${parsed.ns}`, text))
        items.set(id, {
          id,
          hash: sha256(text),
          cls: 'safe-live',
          value,
          updatedAt,
          device: 'bundle',
        })
        continue
      }
      if (typeof entry.value !== 'string') {
        warnings.push(`file ignored (not text): ${parsed.spec.rel}`)
        continue
      }
      const text = normalizeText(entry.value)
      if (Buffer.byteLength(text, 'utf8') > MAX_ITEM_TEXT_BYTES) {
        warnings.push(`file ignored (too large): ${parsed.spec.rel}`)
        continue
      }
      assertClean(scanText(parsed.spec.rel, text))
      items.set(id, {
        id,
        hash: sha256(text),
        cls: parsed.spec.cls,
        value: text,
        updatedAt,
        device: 'bundle',
      })
    }

    const digest = sha256(canonicalJson([...items.values()].map(item => [item.id, item.hash]).sort()))
    return { remote: { items, devices: 1, digest }, warnings }
  }

  /** A restored bundle becomes part of this machine's selection. */
  private async adoptBundleSelection(entry: PlanEntry): Promise<PersistedConfig> {
    const config = await this.loadConfig()
    const namespaces = new Set(config.selectedNamespaces)
    const files = new Set(config.selectedFiles)
    const remote = await entry.readRemote()
    for (const id of remote.items.keys()) {
      const parsed = parseItemId(id)
      if (parsed === undefined) continue
      if (parsed.kind === 'settings') namespaces.add(parsed.ns)
      else files.add(id)
    }
    if (namespaces.size === config.selectedNamespaces.length && files.size === config.selectedFiles.length) {
      return config
    }
    const next: PersistedConfig = {
      ...config,
      selectedNamespaces: [...namespaces],
      selectedFiles: [...files],
    }
    await saveConfig(this.paths, next)
    return next
  }

  async apply(input: ApplyInput): Promise<ApplyResult> {
    if (typeof input?.planId !== 'string') throw new SyncError('validation', 'planId is required')
    const entry = this.plans.get(input.planId)
    if (entry === undefined) throw new SyncError('plan-stale', 'the plan is unknown or was replaced; compare again')
    if (Date.now() - entry.createdAt > PLAN_TTL_MS) {
      this.plans.delete(input.planId)
      throw new SyncError('plan-stale', 'the plan expired; compare again')
    }
    const config = await this.loadConfig()
    if (entry.source === 'folder' && config.syncDir === '') {
      throw new SyncError('config', 'set the sync folder first')
    }
    const capture = await this.capture(config, entry.source === 'bundle' ? new Set(entry.captureIds) : undefined)
    for (const item of entry.plan.items) {
      const current = capture.items.get(item.id)?.hash
      if (current !== entry.localHashes.get(item.id)) {
        throw new SyncError('plan-stale', `local item changed since the plan: ${item.id}`)
      }
    }
    const remote = await entry.readRemote()
    if (remote.digest !== entry.remoteDigest) {
      throw new SyncError('plan-stale', entry.source === 'bundle' ? 'the bundle changed' : 'the sync folder changed since the plan; compare again')
    }
    const revisions = await this.revisions()
    for (const item of entry.plan.items) {
      if (item.kind !== 'settings') continue
      const parsed = parseItemId(item.id)
      if (parsed?.kind !== 'settings') continue
      if (revisions.get(parsed.ns) !== entry.revisions.get(parsed.ns)) {
        throw new SyncError('plan-stale', `settings changed since the plan: ${parsed.ns}`)
      }
    }

    const selected = new Set(input.ids ?? entry.plan.items.filter(item => item.writes).map(item => item.id))
    const decisions = new Map<string, 'keep-local' | 'take-remote'>()
    for (const decision of input.decisions ?? []) {
      if (typeof decision?.id !== 'string') continue
      if (decision.decision !== 'keep-local' && decision.decision !== 'take-remote') continue
      decisions.set(`${decision.id}|${Array.isArray(decision.path) ? decision.path.join('.') : ''}`, decision.decision)
    }

    const stateBefore = await this.loadState()
    const baseNext = cloneJson(stateBefore.base.items)
    const rejectedNext = { ...stateBefore.rejected }

    const fileWrites: Array<{ id: string; specRel: string; text: string }> = []
    const settingsWrites: Array<{
      id: string
      ns: string
      ops: SettingsPathOpLike[]
      compensation: SettingsPathOpLike[]
      revision: number
      expected: unknown
    }> = []
    const skipped: string[] = []
    const restartRequired: string[] = []
    const installRequired: string[] = []
    const finalValues = new Map<string, unknown>()
    let executableBlocked = 0

    for (const item of entry.plan.items) {
      if (!selected.has(item.id)) {
        skipped.push(item.id)
        continue
      }
      const target = entry.targets.get(item.id)
      const local = capture.items.get(item.id)
      if (target === undefined) {
        if (local !== undefined && item.relation === 'converged') baseNext[item.id] = toBase(local, item.cls)
        skipped.push(item.id)
        continue
      }

      let finalValue: unknown
      if (item.kind === 'settings') {
        const itemDecisions = new Map<string, 'keep-local' | 'take-remote'>()
        for (const [key, decision] of decisions) {
          const [id, path] = splitDecisionKey(key)
          if (id === item.id) itemDecisions.set(path, decision)
        }
        finalValue = applyDecisions(target.value, target.conflicts, itemDecisions)
      } else if (isTakeRemote(decisions, item.id)) {
        finalValue = remoteValue(remote, item.id)
      } else if (item.relation === 'remote-only' || item.relation === 'mergeable') {
        finalValue = target.value
      } else {
        finalValue = local?.value
      }

      if (deepEqual(finalValue, local?.value)) {
        if (target.conflicts.length > 0) {
          const remoteHash = remote.items.get(item.id)?.hash
          if (remoteHash !== undefined) rejectedNext[item.id] = remoteHash
        } else if (local !== undefined) {
          baseNext[item.id] = toBase(local, item.cls)
        }
        skipped.push(item.id)
        continue
      }
      if (item.cls === 'executable' && input.allowExecutable !== true) {
        executableBlocked += 1
        continue
      }
      delete rejectedNext[item.id]
      finalValues.set(item.id, finalValue)

      if (target.kind === 'file') {
        const parsed = parseItemId(item.id)
        if (parsed?.kind !== 'file') continue
        const text = normalizeText(String(finalValue ?? ''))
        assertClean(scanText(parsed.spec.rel, text))
        fileWrites.push({ id: item.id, specRel: parsed.spec.rel, text })
        if (item.cls === 'restart') restartRequired.push(item.id)
        if (item.id === 'file:profiles/web/package.json') installRequired.push(item.id)
      } else {
        const parsed = parseItemId(item.id)
        if (parsed?.kind !== 'settings') continue
        const ops = diffOps(local?.value ?? {}, finalValue)
        if (ops.length === 0) {
          if (local !== undefined) baseNext[item.id] = toBase(local, item.cls)
          skipped.push(item.id)
          continue
        }
        assertClean(scanText(`settings:${parsed.ns}`, canonicalJson(finalValue)))
        const revision = revisions.get(parsed.ns)
        if (revision === undefined) throw new SyncError('plan-stale', `settings namespace disappeared: ${parsed.ns}`)
        settingsWrites.push({
          id: item.id,
          ns: parsed.ns,
          ops,
          compensation: diffOps(finalValue, local?.value ?? {}),
          revision,
          expected: finalValue,
        })
      }
      // Base is updated only after the write succeeds.
    }

    if (executableBlocked > 0) {
      throw new SyncError('executable', `${executableBlocked} executable change(s) need explicit confirmation`)
    }

    if (fileWrites.length === 0 && settingsWrites.length === 0) {
      const finalConfig = entry.source === 'bundle' ? await this.adoptBundleSelection(entry) : config
      const state = await this.loadState()
      state.base.items = entry.source === 'bundle' ? pruneBase(baseNext, finalConfig) : baseNext
      state.rejected = pruneRejected(rejectedNext, finalConfig)
      state.lastOperation = { id: randomId(6), op: 'apply', at: new Date().toISOString(), ok: true, message: 'nothing to write' }
      await saveState(this.paths, state)
      return { applied: [], skipped, conflicts: [], restartRequired, installRequired, operation: state.lastOperation }
    }

    const operationId = randomId(6)
    const journal: Journal = {
      schemaVersion: SCHEMA_VERSION,
      operationId,
      op: 'apply',
      startedAt: new Date().toISOString(),
      status: 'APPLYING',
      files: [],
      settings: settingsWrites.map(write => ({
        ns: write.ns,
        expectedRevision: write.revision,
        ops: write.ops,
        compensation: write.compensation,
      })),
    }
    for (const write of fileWrites) {
      const livePath = join(this.home, write.specRel)
      const backupPath = join(this.paths.backups, operationId, write.specRel)
      const before = await readOptional(livePath)
      if (before !== undefined) {
        await ensureDir(dirname(backupPath))
        await copyFile(livePath, backupPath)
      }
      journal.files.push({
        id: write.id,
        livePath,
        backupPath,
        hashBefore: before === undefined ? null : sha256(before),
        existed: before !== undefined,
      })
    }
    await ensureDir(this.paths.stateDir)
    await writeJournal(this.paths.journal, journal)

    const applied: string[] = []
    try {
      for (const write of fileWrites) {
        const livePath = join(this.home, write.specRel)
        await ensureDir(dirname(livePath))
        await writeAtomic(livePath, write.text)
        applied.push(write.id)
      }
      if (settingsWrites.length > 0) {
        if (this.settings === undefined) throw new SyncError('settings', 'the settings service is unavailable')
        for (const write of settingsWrites) {
          await this.settings.mutate(write.ns, write.ops, write.revision)
          applied.push(write.id)
        }
      }
      await this.verify(config, fileWrites, settingsWrites)
    } catch (error) {
      const restored = await this.rollback(journal)
      const state = await this.loadState()
      state.lastOperation = {
        id: operationId,
        op: 'apply',
        at: new Date().toISOString(),
        ok: false,
        message: messageOf(error),
      }
      await saveState(this.paths, state)
      if (restored) await clearJournal(this.paths.journal)
      if ((error as { code?: string }).code === 'SETTINGS_CONFLICT') {
        this.plans.delete(input.planId)
        throw new SyncError('plan-stale', 'settings changed while applying; compare again')
      }
      throw error
    }

    for (const item of entry.plan.items) {
      if (!selected.has(item.id)) continue
      const local = capture.items.get(item.id)
      const target = entry.targets.get(item.id)
      if (target === undefined) {
        if (local !== undefined && item.relation === 'converged') baseNext[item.id] = toBase(local, item.cls)
        continue
      }
      const appliedItem = applied.includes(item.id)
      if (!appliedItem) continue
      const finalValue = finalValues.get(item.id)
      if (finalValue === undefined) continue
      baseNext[item.id] = {
        hash: sha256(typeof finalValue === 'string' ? normalizeText(finalValue) : canonicalJson(finalValue)),
        cls: item.cls,
        value: finalValue,
        updatedAt: Date.now(),
      }
    }

    journal.status = 'DONE'
    await writeJournal(this.paths.journal, journal)
    const finalConfig = entry.source === 'bundle' ? await this.adoptBundleSelection(entry) : config
    const state = await this.loadState()
    state.base.items = entry.source === 'bundle' ? pruneBase(baseNext, finalConfig) : baseNext
    state.rejected = pruneRejected(rejectedNext, finalConfig)
    state.lastOperation = {
      id: operationId,
      op: 'apply',
      at: new Date().toISOString(),
      ok: true,
      message: `${applied.length} item(s) applied`,
    }
    await saveState(this.paths, state)
    await clearJournal(this.paths.journal)
    this.plans.delete(input.planId)

    return {
      applied,
      skipped,
      conflicts: entry.plan.items.filter(item => (item.conflicts?.length ?? 0) > 0).map(item => item.id),
      restartRequired,
      installRequired,
      operation: state.lastOperation,
    }
  }

  async push(): Promise<{ device: string; items: number; operation: LastOperation }> {
    const config = await this.requireConfigured()
    const capture = await this.capture(config)
    assertClean(capture.findings)
    const backend = new FolderBackend(config.syncDir, config.deviceId, config.deviceName)
    await backend.ensure()
    const snapshot: Record<string, SnapshotItem> = {}
    for (const [id, item] of capture.items) {
      snapshot[id] = {
        id,
        kind: item.kind,
        cls: item.cls,
        hash: item.hash,
        value: item.value,
        updatedAt: Date.now(),
      }
    }
    await backend.writeOwn(snapshot)
    const state = await this.loadState()
    for (const [id, item] of capture.items) {
      state.base.items[id] = toBase(item, item.cls)
      delete state.rejected[id]
    }
    state.base.items = pruneBase(state.base.items, config)
    state.rejected = pruneRejected(state.rejected, config)
    state.lastOperation = {
      id: randomId(6),
      op: 'push',
      at: new Date().toISOString(),
      ok: true,
      message: `${capture.items.size} item(s) published`,
    }
    await saveState(this.paths, state)
    return { device: config.deviceId, items: capture.items.size, operation: state.lastOperation }
  }

  async doctor(): Promise<DoctorReport> {
    const issues: DoctorIssue[] = []
    const config = await this.loadConfig()
    if (config.syncDir === '') {
      issues.push({ code: 'sync-dir-missing', severity: 'error', message: 'no sync folder is configured' })
    } else {
      try {
        const info = await stat(config.syncDir)
        if (!info.isDirectory()) {
          issues.push({ code: 'sync-dir-not-directory', severity: 'error', message: 'the sync path is not a directory' })
        } else {
          const probe = join(config.syncDir, `.dsh-bag-probe-${randomId(3)}`)
          try {
            await writeFile(probe, 'ok', 'utf8')
            await rm(probe, { force: true })
          } catch {
            issues.push({ code: 'sync-dir-readonly', severity: 'error', message: 'the sync folder is not writable' })
          }
        }
      } catch {
        issues.push({ code: 'sync-dir-unreachable', severity: 'error', message: 'the sync folder does not exist or is unreachable' })
      }
    }
    const journal = await readJournal(this.paths.journal)
    if (journalIncomplete(journal)) {
      issues.push({ code: 'journal-incomplete', severity: 'error', message: 'a previous apply did not finish; run Repair' })
    }
    if (this.settings === undefined) {
      issues.push({ code: 'settings-unavailable', severity: 'warn', message: 'the settings service is unavailable; only files can sync' })
    } else if (this.settings.writable === false) {
      issues.push({ code: 'settings-readonly', severity: 'warn', message: 'the active profile does not accept settings writes' })
    }
    if (config.syncDir !== '') {
      try {
        const backend = new FolderBackend(config.syncDir, config.deviceId, config.deviceName)
        const remote = await backend.readRemote()
        if (remote.devices === 0) {
          issues.push({ code: 'no-devices', severity: 'info', message: 'the sync folder has no device snapshots yet' })
        }
      } catch (error) {
        issues.push({ code: 'backend', severity: 'error', message: messageOf(error) })
      }
    }
    try {
      const capture = await this.capture(config)
      for (const warning of capture.warnings) {
        issues.push({ code: 'capture', severity: 'warn', message: warning })
      }
      for (const finding of capture.findings) {
        issues.push({ code: 'secret', severity: 'error', message: `${finding.path} looks like a secret (${finding.rule})` })
      }
    } catch (error) {
      issues.push({ code: 'capture', severity: 'error', message: messageOf(error) })
    }
    return { ok: !issues.some(issue => issue.severity === 'error'), issues }
  }

  async recover(): Promise<{ recovered: boolean; message: string }> {
    const journal = await readJournal(this.paths.journal)
    if (journal === undefined || !journalIncomplete(journal)) {
      await clearJournal(this.paths.journal)
      return { recovered: false, message: 'no interrupted apply to repair' }
    }
    const restored = await this.rollback(journal)
    if (!restored) throw new SyncError('recover', 'repair did not finish; the journal was kept')
    await clearJournal(this.paths.journal)
    const state = await this.loadState()
    state.lastOperation = {
      id: randomId(6),
      op: 'recover',
      at: new Date().toISOString(),
      ok: true,
      message: `restored ${journal.files.length} file(s)`,
    }
    await saveState(this.paths, state)
    return { recovered: true, message: state.lastOperation.message ?? 'repaired' }
  }

  // ---------------------------------------------------------------- internals

  private async capture(config: PersistedConfig, only?: Set<string>): Promise<Capture> {
    const items = new Map<string, CapturedItem>()
    const warnings: string[] = []
    const findings: Finding[] = []
    const revisions = new Map<string, number>()
    const schemas = new Map<string, unknown>()
    const namespaces = only === undefined
      ? config.selectedNamespaces
      : [...only].flatMap(id => {
        const parsed = parseItemId(id)
        return parsed?.kind === 'settings' ? [parsed.ns] : []
      })
    const fileIds = only === undefined
      ? config.selectedFiles
      : [...only].flatMap(id => {
        const parsed = parseItemId(id)
        return parsed?.kind === 'file' ? [id] : []
      })

    if (namespaces.length > 0) {
      if (this.settings === undefined) {
        warnings.push('the settings service is unavailable; selected namespaces were skipped')
      } else {
        let descriptors: SettingsDescriptorLike[] = []
        try {
          descriptors = this.settings.describe({ redactSecrets: true })
        } catch (error) {
          warnings.push(`could not read settings: ${messageOf(error)}`)
        }
        const byNs = new Map(descriptors.map(descriptor => [descriptor.ns, descriptor]))
        for (const ns of namespaces) {
          const descriptor = byNs.get(ns)
          if (descriptor === undefined) {
            warnings.push(`settings namespace "${ns}" is not present in this profile`)
            continue
          }
          if (!hasVolatile(descriptor.schema)) {
            warnings.push(`settings namespace "${ns}" has no live-editable fields and was skipped`)
            continue
          }
          const user = descriptor.user ?? {}
          const stripped = stripLocalOnly(user, config.localOnlyKeys[ns] ?? [])
          const value = projectVolatile(descriptor.schema, stripped) ?? {}
          const text = canonicalJson(value)
          findings.push(...scanText(`settings:${ns}`, text))
          items.set(settingsItemId(ns), {
            id: settingsItemId(ns),
            kind: 'settings',
            cls: 'safe-live',
            hash: sha256(text),
            value,
            label: ns,
          })
          revisions.set(ns, descriptor.revision)
          schemas.set(ns, descriptor.schema)
        }
      }
    }

    for (const id of fileIds) {
      const spec = fileSpec(id)
      if (spec === undefined) continue
      const live = join(this.home, spec.rel)
      let info
      try {
        info = await stat(live)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`could not read ${spec.rel}: ${messageOf(error)}`)
        continue
      }
      if (!info.isFile()) {
        warnings.push(`${spec.rel} is not a regular file`)
        continue
      }
      if (info.size > MAX_ITEM_TEXT_BYTES) {
        warnings.push(`${spec.rel} is larger than ${MAX_ITEM_TEXT_BYTES} bytes and was skipped`)
        continue
      }
      const text = normalizeText(await readFile(live, 'utf8'))
      findings.push(...scanText(spec.rel, text))
      items.set(id, { id, kind: 'file', cls: spec.cls, hash: sha256(text), value: text, label: spec.label })
    }

    return { items, warnings, findings, revisions, schemas }
  }

  private async revisions(): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    if (this.settings === undefined) return map
    for (const descriptor of this.settings.describe({ redactSecrets: true })) {
      map.set(descriptor.ns, descriptor.revision)
    }
    return map
  }

  private async verify(
    config: PersistedConfig,
    files: Array<{ id: string; specRel: string; text: string }>,
    settingsWrites: Array<{ id: string; ns: string; expected: unknown }>,
  ): Promise<void> {
    for (const write of files) {
      const text = normalizeText(await readFile(join(this.home, write.specRel), 'utf8'))
      if (sha256(text) !== sha256(write.text)) {
        throw new SyncError('verify', `write verification failed for ${write.specRel}`)
      }
    }
    if (settingsWrites.length > 0 && this.settings !== undefined) {
      const descriptors = new Map(this.settings.describe({ redactSecrets: true }).map(d => [d.ns, d]))
      for (const write of settingsWrites) {
        const descriptor = descriptors.get(write.ns)
        const value = projectVolatile(
          descriptor?.schema,
          stripLocalOnly(descriptor?.user ?? {}, config.localOnlyKeys[write.ns] ?? []),
        ) ?? {}
        if (!deepEqual(value, write.expected)) {
          throw new SyncError('verify', `settings verification failed for ${write.ns}`)
        }
      }
    }
  }

  private async rollback(journal: Journal): Promise<boolean> {
    let ok = true
    for (const file of [...journal.files].reverse()) {
      try {
        if (file.existed) {
          await ensureDir(dirname(file.livePath))
          await copyFile(file.backupPath, file.livePath)
        } else {
          await rm(file.livePath, { force: true })
        }
      } catch (error) {
        ok = false
        this.logger?.warn(`[dsh-bag] could not restore ${file.livePath}: ${messageOf(error)}`)
      }
    }
    if (this.settings !== undefined) {
      for (const entry of [...journal.settings].reverse()) {
        if (entry.compensation.length === 0) continue
        try {
          const revision = this.settings.describe({ redactSecrets: true }).find(d => d.ns === entry.ns)?.revision
          await this.settings.mutate(entry.ns, entry.compensation, revision)
        } catch (error) {
          ok = false
          this.logger?.warn(`[dsh-bag] could not restore settings ${entry.ns}: ${messageOf(error)}`)
        }
      }
    }
    return ok
  }

  private async loadConfig(): Promise<PersistedConfig> {
    return loadConfig(this.paths)
  }

  private async loadState(): Promise<PersistedState> {
    try {
      return await loadState(this.paths)
    } catch {
      return defaultState()
    }
  }

  private async requireConfigured(): Promise<PersistedConfig & { syncDir: string }> {
    const config = await this.loadConfig()
    if (config.syncDir === '') throw new SyncError('config', 'set the sync folder first')
    assertSyncDir(config.syncDir, this.home)
    return config as PersistedConfig & { syncDir: string }
  }
}

function toBase(item: CapturedItem, cls: ItemClass): { hash: string; cls: ItemClass; value: unknown; updatedAt: number } {
  return { hash: item.hash, cls, value: item.value, updatedAt: Date.now() }
}

function pruneBase<T>(base: Record<string, T>, config: PersistedConfig): Record<string, T> {
  const keep = new Set<string>([
    ...config.selectedNamespaces.map(settingsItemId),
    ...config.selectedFiles,
  ])
  const out: Record<string, T> = {}
  for (const [id, value] of Object.entries(base)) if (keep.has(id)) out[id] = value
  return out
}

function pruneRejected(rejected: Record<string, string>, config: PersistedConfig): Record<string, string> {
  const keep = new Set<string>([
    ...config.selectedNamespaces.map(settingsItemId),
    ...config.selectedFiles,
  ])
  const out: Record<string, string> = {}
  for (const [id, value] of Object.entries(rejected)) if (keep.has(id)) out[id] = value
  return out
}

function splitDecisionKey(key: string): [string, string] {
  const index = key.indexOf('|')
  return index < 0 ? [key, ''] : [key.slice(0, index), key.slice(index + 1)]
}

function decisionsFor(
  decisions: ReadonlyMap<string, 'keep-local' | 'take-remote'>,
  id: string,
): Map<string, 'keep-local' | 'take-remote'> {
  const out = new Map<string, 'keep-local' | 'take-remote'>()
  for (const [key, decision] of decisions) {
    const [candidate, path] = splitDecisionKey(key)
    if (candidate === id) out.set(path, decision)
  }
  return out
}

function isTakeRemote(decisions: ReadonlyMap<string, 'keep-local' | 'take-remote'>, id: string): boolean {
  return decisionsFor(decisions, id).get('') === 'take-remote'
}

function remoteValue(remote: RemoteSnapshot, id: string): unknown {
  return remote.items.get(id)?.value
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
