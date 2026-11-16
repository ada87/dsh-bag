import type { ItemRelation, PathConflict } from './protocol.js'
import { deepEqual, isPlainObject } from './util.js'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * Classify one item from three hashes. Deletions are not propagated in v1:
 * an item missing locally is simply remote-only, which is how a fresh machine
 * receives the configuration.
 */
export function classify(localHash?: string, remoteHash?: string, baseHash?: string): ItemRelation {
  const localPresent = localHash !== undefined
  const remotePresent = remoteHash !== undefined
  if (!localPresent && !remotePresent) return 'converged'
  if (!localPresent) return 'remote-only'
  if (!remotePresent) return 'local-only'
  if (localHash === remoteHash) return 'converged'
  if (baseHash === undefined) return 'conflict'
  if (localHash === baseHash) return 'remote-only'
  if (remoteHash === baseHash) return 'local-only'
  return 'conflict'
}

export interface MergeResult {
  value: unknown
  conflicts: PathConflict[]
}

/**
 * Three-way merge for JSON maps. Maps merge by key; arrays and scalars are
 * atomic. A conflict keeps the local value in the merged result so a default
 * apply never overwrites the machine without a decision.
 */
export function mergeMaps(base: unknown, local: unknown, remote: unknown): MergeResult {
  const conflicts: PathConflict[] = []
  const value = mergeAt(base, local, remote, [], conflicts)
  return { value, conflicts }
}

function mergeAt(base: unknown, local: unknown, remote: unknown, path: string[], conflicts: PathConflict[]): unknown {
  if (deepEqual(local, remote)) return local
  const localEqBase = deepEqual(local, base)
  const remoteEqBase = deepEqual(remote, base)

  if (localEqBase && !remoteEqBase) return remote
  if (remoteEqBase && !localEqBase) return local

  if (isPlainObject(local) && isPlainObject(remote) && (base === undefined || isPlainObject(base))) {
    const baseObject = isPlainObject(base) ? base : undefined
    const keys = new Set([
      ...Object.keys(baseObject ?? {}),
      ...Object.keys(local),
      ...Object.keys(remote),
    ])
    const out: Record<string, unknown> = {}
    for (const key of [...keys].sort()) {
      const childPath = [...path, key]
      const localHas = Object.hasOwn(local, key)
      const remoteHas = Object.hasOwn(remote, key)
      const baseHas = baseObject !== undefined && Object.hasOwn(baseObject, key)

      if (!localHas && !remoteHas) continue
      if (!localHas) {
        // Local removed the key. Deletions are not propagated, so keep the
        // remote value only when the local side never had it in the base.
        if (!baseHas) {
          out[key] = remote[key]
        } else {
          conflicts.push({ path: childPath, base: baseObject?.[key], local: undefined, remote: remote[key] })
        }
        continue
      }
      if (!remoteHas) {
        if (!baseHas) {
          out[key] = local[key]
        } else if (deepEqual(local[key], baseObject?.[key])) {
          // Remote removed a key the local side never changed: take the removal.
          continue
        } else {
          conflicts.push({ path: childPath, base: baseObject?.[key], local: local[key], remote: undefined })
          out[key] = local[key]
        }
        continue
      }
      out[key] = mergeAt(baseObject?.[key], local[key], remote[key], childPath, conflicts)
    }
    return out
  }

  conflicts.push({ path, base, local, remote })
  return local
}

/** Path-addressed edits that turn `local` into `target`. */
export function diffOps(
  local: unknown,
  target: unknown,
  path: string[] = [],
): Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }> {
  if (deepEqual(local, target)) return []
  if (isPlainObject(local) && isPlainObject(target)) {
    const ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }> = []
    const keys = new Set([...Object.keys(local), ...Object.keys(target)])
    for (const key of [...keys].sort()) {
      const childPath = [...path, key]
      const localHas = Object.hasOwn(local, key)
      const targetHas = Object.hasOwn(target, key)
      if (!targetHas) {
        ops.push({ op: 'unset', path: childPath })
        continue
      }
      if (!localHas) {
        ops.push({ op: 'set', path: childPath, value: target[key] })
        continue
      }
      ops.push(...diffOps(local[key], target[key], childPath))
    }
    return ops
  }
  return [{ op: 'set', path, value: target }]
}

/** Resolve per-path decisions over a merged value; local wins by default. */
export function applyDecisions(
  merged: unknown,
  conflicts: readonly PathConflict[],
  decisions: ReadonlyMap<string, 'keep-local' | 'take-remote'>,
): unknown {
  let value = merged
  for (const conflict of conflicts) {
    const key = conflict.path.join('.')
    if (decisions.get(key) !== 'take-remote') continue
    value = setAt(value, conflict.path, conflict.remote)
  }
  return value
}

function setAt(value: unknown, path: readonly string[], next: unknown): unknown {
  if (path.length === 0) return next
  const [head, ...rest] = path
  if (head === undefined) return next
  const object = isPlainObject(value) ? { ...value } : {}
  if (next === undefined) {
    delete object[head]
    return object
  }
  object[head] = setAt(object[head], rest, next)
  return object
}

/** Compact line diff for the review pane; capped, never used for decisions. */
export function lineDiff(oldText: string, newText: string, cap = 600): string {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length > cap || b.length > cap) {
    return `@@ ${a.length} lines -> ${b.length} lines (too large to preview) @@`
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`)
      i += 1
      j += 1
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${a[i]}`)
      i += 1
    } else {
      out.push(`+ ${b[j]}`)
      j += 1
    }
  }
  while (i < a.length) {
    out.push(`- ${a[i]}`)
    i += 1
  }
  while (j < b.length) {
    out.push(`+ ${b[j]}`)
    j += 1
  }
  return out.join('\n')
}
