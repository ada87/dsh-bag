import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertLocalOnlyMap,
  assertSelectedFiles,
  assertSelectedNamespaces,
  assertSyncDir,
  stripLocalOnly,
} from '../lib/policy.js'

test('stripLocalOnly removes dotted prefixes and keeps siblings', () => {
  const value = { theme: 'dark', llm: { apiKey: 'x', model: 'm' }, keep: 1 }
  assert.deepEqual(stripLocalOnly(value, ['llm.apiKey']), { theme: 'dark', llm: { model: 'm' }, keep: 1 })
  assert.deepEqual(stripLocalOnly(value, ['llm']), { theme: 'dark', keep: 1 })
})

test('assertSyncDir refuses the home and anything inside it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bag-home-'))
  try {
    assert.throws(() => assertSyncDir(home, home), /outside the dsh home/)
    assert.throws(() => assertSyncDir(join(home, 'sync'), home), /outside the dsh home/)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-bag-sync-'))
    try {
      assert.equal(assertSyncDir(outside, home), outside)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('selection validators refuse unknown ids', () => {
  assert.deepEqual(assertSelectedNamespaces(['ui-theme']), ['ui-theme'])
  assert.throws(() => assertSelectedNamespaces(['bad ns']), /invalid settings namespace/)
  assert.throws(() => assertSelectedFiles(['file:.credentials.yaml']), /unknown file item/)
  assert.deepEqual(assertLocalOnlyMap({ 'ui-theme': ['a.b'] }), { 'ui-theme': ['a.b'] })
  assert.throws(() => assertLocalOnlyMap({ 'ui-theme': ['a..b'] }), /empty path segment/)
})

test('a sync directory must be absolute', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bag-home-'))
  try {
    assert.throws(() => assertSyncDir('relative/path', home), /absolute/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a sync directory must not contain the dsh home', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-bag-parent-'))
  const home = join(parent, 'home')
  try {
    await mkdir(home, { recursive: true })
    assert.throws(() => assertSyncDir(parent, home), /must not contain the dsh home/)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('policy does not walk the home directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bag-home-'))
  try {
    await mkdir(join(home, 'sessions'), { recursive: true })
    assert.throws(() => assertSyncDir(join(home, 'sessions'), home), /outside the dsh home/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
