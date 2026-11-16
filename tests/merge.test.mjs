import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDecisions, classify, diffOps, lineDiff, mergeMaps } from '../lib/merge.js'

test('classify walks the three-way states', () => {
  assert.equal(classify('a', 'a', 'b'), 'converged')
  assert.equal(classify('a', 'b', 'a'), 'remote-only')
  assert.equal(classify('a', 'a', 'a'), 'converged')
  assert.equal(classify('b', 'a', 'a'), 'local-only')
  assert.equal(classify('b', 'c', 'a'), 'conflict')
  assert.equal(classify(undefined, 'a', undefined), 'remote-only')
  assert.equal(classify('a', undefined, undefined), 'local-only')
  assert.equal(classify('a', 'b', undefined), 'conflict')
})

test('mergeMaps combines non-overlapping key edits', () => {
  const base = { a: 1, b: 2 }
  const local = { a: 10, b: 2 }
  const remote = { a: 1, b: 20 }
  const result = mergeMaps(base, local, remote)
  assert.equal(result.conflicts.length, 0)
  assert.deepEqual(result.value, { a: 10, b: 20 })
})

test('mergeMaps reports overlapping key edits and keeps local', () => {
  const result = mergeMaps({ a: 1 }, { a: 2 }, { a: 3 })
  assert.equal(result.conflicts.length, 1)
  assert.deepEqual(result.conflicts[0].path, ['a'])
  assert.deepEqual(result.value, { a: 2 })
})

test('mergeMaps keeps nested maps mergeable', () => {
  const result = mergeMaps(
    { ui: { theme: 'light', density: 'cozy' } },
    { ui: { theme: 'dark', density: 'cozy' } },
    { ui: { theme: 'light', density: 'compact' } },
  )
  assert.equal(result.conflicts.length, 0)
  assert.deepEqual(result.value, { ui: { theme: 'dark', density: 'compact' } })
})

test('diffOps emits set and unset at leaf paths', () => {
  const ops = diffOps({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 9 } })
  assert.deepEqual(ops, [
    { op: 'set', path: ['b', 'c'], value: 9 },
    { op: 'unset', path: ['b', 'd'] },
  ])
})

test('applyDecisions takes the remote value on request', () => {
  const merged = { a: 2, b: 2 }
  const conflicts = [{ path: ['a'], local: 2, remote: 3 }]
  const value = applyDecisions(merged, conflicts, new Map([['a', 'take-remote']]))
  assert.deepEqual(value, { a: 3, b: 2 })
})

test('lineDiff shows both sides', () => {
  const text = lineDiff('a\nb\n', 'a\nc\n')
  assert.match(text, /- b/)
  assert.match(text, /\+ c/)
})
