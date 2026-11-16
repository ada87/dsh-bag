import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decryptBundle, encryptBundle } from '../lib/bundle.js'
import { SyncEngine } from '../lib/engine.js'

const PASSWORD = 'correct horse battery'

async function temp(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

async function homeWith(file, text) {
  const home = await temp('dsh-bag-home-')
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  await writeFile(join(home, file), text, 'utf8')
  return home
}

function payload(items) {
  return {
    format: 'dsh-bag-payload',
    version: 1,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    device: { id: 'test', name: 'test' },
    items,
  }
}

test('bundle encryption round-trips and rejects a wrong password', async () => {
  const envelope = await encryptBundle(payload({
    'file:profiles/web/package.json': { cls: 'restart', hash: 'a'.repeat(64), value: '{"v":1}\n' },
  }), PASSWORD)
  const text = JSON.stringify(envelope)
  const decoded = await decryptBundle(text, PASSWORD)
  assert.equal(decoded.items['file:profiles/web/package.json'].value, '{"v":1}\n')
  await assert.rejects(() => decryptBundle(text, 'wrong password'), /password is wrong|password/)
})

test('a tampered ciphertext fails authentication', async () => {
  const envelope = await encryptBundle(payload({
    'file:profiles/web/package.json': { cls: 'restart', hash: 'a'.repeat(64), value: 'x' },
  }), PASSWORD)
  const bytes = Buffer.from(envelope.ciphertext, 'base64')
  bytes[0] = bytes[0] ^ 1
  envelope.ciphertext = bytes.toString('base64')
  await assert.rejects(() => decryptBundle(JSON.stringify(envelope), PASSWORD), /wrong|modified/)
})

test('export then import restores a file without a sync folder', async () => {
  const homeA = await homeWith('profiles/web/package.json', '{"v":1}\n')
  const homeB = await temp('dsh-bag-home-')
  try {
    const a = new SyncEngine({ home: homeA })
    await a.updateConfig({ selectedFiles: ['file:profiles/web/package.json'] })
    const exported = await a.exportBundle(PASSWORD)
    assert.equal(exported.items, 1)
    assert.match(exported.filename, /\.dshbag$/)

    const b = new SyncEngine({ home: homeB })
    const plan = await b.planBundle(exported.data, PASSWORD)
    assert.equal(plan.source, 'bundle')
    const item = plan.items.find(entry => entry.id === 'file:profiles/web/package.json')
    assert.equal(item.relation, 'remote-only')
    const result = await b.apply({ planId: plan.id })
    assert.deepEqual(result.applied, ['file:profiles/web/package.json'])
    assert.equal(await readFile(join(homeB, 'profiles/web/package.json'), 'utf8'), '{"v":1}\n')
    assert.ok((await b.config()).selectedFiles.includes('file:profiles/web/package.json'))
  } finally {
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('executable items from a bundle still need confirmation', async () => {
  const homeA = await homeWith('profiles/web/cordis.patch.yml', '- insert:\n    - id: x\n')
  const homeB = await temp('dsh-bag-home-')
  try {
    const a = new SyncEngine({ home: homeA })
    await a.updateConfig({ selectedFiles: ['file:profiles/web/cordis.patch.yml'] })
    const exported = await a.exportBundle(PASSWORD)

    const b = new SyncEngine({ home: homeB })
    const plan = await b.planBundle(exported.data, PASSWORD)
    assert.equal(plan.executable, 1)
    await assert.rejects(() => b.apply({ planId: plan.id }), /executable change/)
    const result = await b.apply({ planId: plan.id, allowExecutable: true })
    assert.deepEqual(result.applied, ['file:profiles/web/cordis.patch.yml'])
  } finally {
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('a bundle carrying a secret is refused before writing', async () => {
  const home = await temp('dsh-bag-home-')
  try {
    const envelope = await encryptBundle(payload({
      'file:profiles/web/package.json': {
        cls: 'restart',
        hash: 'a'.repeat(64),
        value: '{"token":"ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n',
      },
    }), PASSWORD)
    const engine = new SyncEngine({ home })
    await assert.rejects(() => engine.planBundle(JSON.stringify(envelope), PASSWORD), /secret scan/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a bundle with no applicable items is refused', async () => {
  const home = await temp('dsh-bag-home-')
  try {
    const envelope = await encryptBundle(payload({
      'file:.credentials.yaml': { cls: 'restart', hash: 'a'.repeat(64), value: 'secret' },
    }), PASSWORD)
    const engine = new SyncEngine({ home })
    await assert.rejects(() => engine.planBundle(JSON.stringify(envelope), PASSWORD), /allowlist|no items this profile can apply/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
