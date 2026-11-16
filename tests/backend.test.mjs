import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FolderBackend } from '../lib/backend.js'

const item = (hash, value, cls = 'restart') => ({ id: 'file:profiles/web/package.json', kind: 'file', cls, hash, value, updatedAt: 0 })

test('folder backend keeps one snapshot per device and merges newest items', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bag-backend-'))
  try {
    const a = new FolderBackend(dir, 'aaa')
    const b = new FolderBackend(dir, 'bbb')
    await a.writeOwn({ 'file:profiles/web/package.json': item('a'.repeat(64), 'A') })
    await b.writeOwn({ 'file:profiles/web/package.json': item('b'.repeat(64), 'B') })

    const remote = await b.readRemote()
    assert.equal(remote.devices, 2)
    assert.equal(remote.items.get('file:profiles/web/package.json').value, 'B')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unchanged hash keeps its timestamp across pushes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bag-backend-'))
  try {
    const a = new FolderBackend(dir, 'aaa')
    const first = await a.writeOwn({ 'file:profiles/web/package.json': item('c'.repeat(64), 'C') })
    const firstAt = first.items['file:profiles/web/package.json'].updatedAt
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await a.writeOwn({ 'file:profiles/web/package.json': item('c'.repeat(64), 'C') })
    assert.equal(second.items['file:profiles/web/package.json'].updatedAt, firstAt)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('garbage device files are ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bag-backend-'))
  try {
    const a = new FolderBackend(dir, 'aaa')
    await a.ensure()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'devices', 'bad.json'), 'not json')
    const remote = await a.readRemote()
    assert.equal(remote.devices, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
