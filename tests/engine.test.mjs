import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SyncEngine } from '../lib/engine.js'

/** Minimal in-memory SettingsForms stand-in with revisions and path edits. */
function makeSettings(initial) {
  const users = JSON.parse(JSON.stringify(initial))
  let revision = 0
  return {
    writable: true,
    users,
    describe() {
      return Object.entries(users).map(([ns, user]) => ({
        ns,
        revision,
        user: JSON.parse(JSON.stringify(user)),
        schema: { type: 'object', meta: { volatile: true }, dict: {} },
        secrets: [],
      }))
    },
    async mutate(ns, ops, expected) {
      if (expected !== undefined && expected !== revision) {
        const error = new Error('conflict')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      const root = users[ns] ?? {}
      for (const op of ops) {
        if (op.path.length === 0) {
          users[ns] = op.op === 'set' ? op.value : {}
          continue
        }
        let target = root
        for (const part of op.path.slice(0, -1)) {
          if (target[part] === null || typeof target[part] !== 'object') target[part] = {}
          target = target[part]
        }
        const leaf = op.path[op.path.length - 1]
        if (op.op === 'set') target[leaf] = op.value
        else delete target[leaf]
      }
      users[ns] = root
      revision += 1
    },
  }
}

async function temp(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

async function homeWith(file, text) {
  const home = await temp('dsh-bag-home-')
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  await writeFile(join(home, file), text, 'utf8')
  return home
}

test('push publishes and a fresh machine applies the file', async () => {
  const sync = await temp('dsh-bag-sync-')
  const homeA = await homeWith('profiles/web/package.json', '{"dependencies":{"a":"1"}}\n')
  const homeB = await temp('dsh-bag-home-')
  try {
    const a = new SyncEngine({ home: homeA })
    await a.updateConfig({ syncDir: sync, selectedFiles: ['file:profiles/web/package.json'] })
    const pushed = await a.push()
    assert.equal(pushed.items, 1)

    const b = new SyncEngine({ home: homeB })
    await b.updateConfig({ syncDir: sync, selectedFiles: ['file:profiles/web/package.json'] })
    const plan = await b.plan()
    const item = plan.items.find(entry => entry.id === 'file:profiles/web/package.json')
    assert.equal(item.relation, 'remote-only')

    const result = await b.apply({ planId: plan.id })
    assert.deepEqual(result.applied, ['file:profiles/web/package.json'])
    assert.equal(await readFile(join(homeB, 'profiles/web/package.json'), 'utf8'), '{"dependencies":{"a":"1"}}\n')
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('both sides editing the same item is a conflict and take-remote resolves it', async () => {
  const sync = await temp('dsh-bag-sync-')
  const homeA = await homeWith('profiles/web/package.json', '{"v":1}\n')
  const homeB = await homeWith('profiles/web/package.json', '{"v":1}\n')
  try {
    const a = new SyncEngine({ home: homeA })
    const b = new SyncEngine({ home: homeB })
    await a.updateConfig({ syncDir: sync, selectedFiles: ['file:profiles/web/package.json'] })
    await b.updateConfig({ syncDir: sync, selectedFiles: ['file:profiles/web/package.json'] })
    await a.push()
    let plan = await b.plan()
    await b.apply({ planId: plan.id })

    await writeFile(join(homeA, 'profiles/web/package.json'), '{"v":3}\n', 'utf8')
    await writeFile(join(homeB, 'profiles/web/package.json'), '{"v":4}\n', 'utf8')
    await a.push()
    plan = await b.plan()
    const item = plan.items.find(entry => entry.id === 'file:profiles/web/package.json')
    assert.equal(item.relation, 'conflict')

    const result = await b.apply({
      planId: plan.id,
      decisions: [{ id: item.id, path: [], decision: 'take-remote' }],
    })
    assert.deepEqual(result.applied, [item.id])
    assert.equal(await readFile(join(homeB, 'profiles/web/package.json'), 'utf8'), '{"v":3}\n')
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('executable files need explicit confirmation', async () => {
  const sync = await temp('dsh-bag-sync-')
  const homeA = await homeWith('profiles/web/cordis.patch.yml', '- insert:\n    - id: x\n')
  const homeB = await temp('dsh-bag-home-')
  try {
    const a = new SyncEngine({ home: homeA })
    await a.updateConfig({ syncDir: sync, selectedFiles: ['file:profiles/web/cordis.patch.yml'] })
    await a.push()

    const b = new SyncEngine({ home: homeB })
    await b.updateConfig({ syncDir: sync, selectedFiles: ['file:profiles/web/cordis.patch.yml'] })
    const plan = await b.plan()
    assert.equal(plan.executable, 1)
    await assert.rejects(() => b.apply({ planId: plan.id }), /executable change/)

    const result = await b.apply({ planId: plan.id, allowExecutable: true })
    assert.deepEqual(result.applied, ['file:profiles/web/cordis.patch.yml'])
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('secret-shaped values refuse to publish', async () => {
  const sync = await temp('dsh-bag-sync-')
  const home = await homeWith('profiles/web/package.json', '{"token":"ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n')
  try {
    const engine = new SyncEngine({ home })
    await engine.updateConfig({ syncDir: sync, selectedFiles: ['file:profiles/web/package.json'] })
    await assert.rejects(() => engine.push(), /secret scan/)
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('a plan is refused after the remote folder changes', async () => {
  const sync = await temp('dsh-bag-sync-')
  const homeA = await homeWith('profiles/web/package.json', '{"v":1}\n')
  const homeB = await temp('dsh-bag-home-')
  try {
    const a = new SyncEngine({ home: homeA })
    await a.updateConfig({ syncDir: sync, selectedFiles: ['file:profiles/web/package.json'] })
    await a.push()
    const b = new SyncEngine({ home: homeB })
    await b.updateConfig({ syncDir: sync, selectedFiles: ['file:profiles/web/package.json'] })
    const plan = await b.plan()
    await writeFile(join(homeA, 'profiles/web/package.json'), '{"v":2}\n', 'utf8')
    await a.push()
    await assert.rejects(() => b.apply({ planId: plan.id }), /sync folder changed/)
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('settings namespaces travel as the user layer and merge per key', async () => {
  const sync = await temp('dsh-bag-sync-')
  const homeA = await temp('dsh-bag-home-')
  const homeB = await temp('dsh-bag-home-')
  const settingsA = makeSettings({ 'ui-theme': { theme: 'dark', density: 'cozy' } })
  const settingsB = makeSettings({ 'ui-theme': {} })
  try {
    const a = new SyncEngine({ home: homeA, settings: settingsA })
    await a.updateConfig({ syncDir: sync, selectedNamespaces: ['ui-theme'] })
    await a.push()

    const b = new SyncEngine({ home: homeB, settings: settingsB })
    await b.updateConfig({ syncDir: sync, selectedNamespaces: ['ui-theme'] })
    let plan = await b.plan()
    const item = plan.items.find(entry => entry.id === 'settings:ui-theme')
    assert.ok(item.relation === 'remote-only' || item.relation === 'mergeable')
    assert.equal(item.writes, true)
    await b.apply({ planId: plan.id })
    assert.deepEqual(settingsB.users['ui-theme'], { theme: 'dark', density: 'cozy' })

    settingsB.users['ui-theme'].theme = 'light'
    await b.push()
    settingsA.users['ui-theme'].theme = 'blue'
    plan = await a.plan()
    const conflict = plan.items.find(entry => entry.id === 'settings:ui-theme')
    assert.equal(conflict.relation, 'conflict')
    await a.apply({
      planId: plan.id,
      decisions: [{ id: conflict.id, path: ['theme'], decision: 'take-remote' }],
    })
    assert.deepEqual(settingsA.users['ui-theme'], { theme: 'light', density: 'cozy' })
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('local-only settings keys are stripped before publish', async () => {
  const sync = await temp('dsh-bag-sync-')
  const home = await temp('dsh-bag-home-')
  const settings = makeSettings({ 'llm-deepseek': { baseURL: 'http://10.0.0.2', model: 'm' } })
  try {
    const engine = new SyncEngine({ home, settings })
    await engine.updateConfig({ syncDir: sync, selectedNamespaces: ['llm-deepseek'], localOnlyKeys: { 'llm-deepseek': ['baseURL'] } })
    await engine.push()
    const { readFile: read } = await import('node:fs/promises')
    const raw = JSON.parse(await read(join(sync, 'devices', (await engine.config()).deviceId + '.json'), 'utf8'))
    assert.deepEqual(raw.items['settings:llm-deepseek'].value, { model: 'm' })
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})
