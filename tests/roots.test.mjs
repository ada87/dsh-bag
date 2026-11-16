import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SyncEngine } from '../lib/engine.js'

async function temp(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

test('a user preset travels as one directory item', async () => {
  const sync = await temp('dsh-bag-sync-')
  const homeA = await temp('dsh-bag-home-')
  const homeB = await temp('dsh-bag-home-')
  try {
    await mkdir(join(homeA, '.agent-presets', 'mine'), { recursive: true })
    await writeFile(join(homeA, '.agent-presets', 'mine', 'agent.cordis.yml'), '- name: demo\n', 'utf8')
    await writeFile(join(homeA, '.agent-presets', 'mine', 'preset.yml'), 'name: My preset\n', 'utf8')

    const a = new SyncEngine({ home: homeA })
    const listed = await a.listPresets()
    assert.deepEqual(listed, [{ id: 'mine', name: 'My preset' }])
    await a.updateConfig({ syncDir: sync, selectedPresets: ['mine'] })
    await a.push()

    const b = new SyncEngine({ home: homeB })
    await b.updateConfig({ syncDir: sync, selectedPresets: ['mine'] })
    const plan = await b.plan()
    const item = plan.items.find(entry => entry.id === 'preset:mine')
    assert.equal(item.kind, 'preset')
    assert.equal(item.cls, 'executable')
    await assert.rejects(() => b.apply({ planId: plan.id }), /executable change/)
    await b.apply({ planId: plan.id, allowExecutable: true })
    assert.equal(await readFile(join(homeB, '.agent-presets', 'mine', 'agent.cordis.yml'), 'utf8'), '- name: demo\n')
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('the hooks directory travels when enabled', async () => {
  const sync = await temp('dsh-bag-sync-')
  const homeA = await temp('dsh-bag-home-')
  const homeB = await temp('dsh-bag-home-')
  try {
    await mkdir(join(homeA, 'hooks'), { recursive: true })
    await writeFile(join(homeA, 'hooks', 'notify.sh'), 'echo hello\n', 'utf8')

    const a = new SyncEngine({ home: homeA })
    await a.updateConfig({ syncDir: sync, syncHooks: true })
    await a.push()

    const b = new SyncEngine({ home: homeB })
    await b.updateConfig({ syncDir: sync, syncHooks: true })
    const plan = await b.plan()
    assert.ok(plan.items.some(entry => entry.id === 'hooks' && entry.kind === 'hooks'))
    await b.apply({ planId: plan.id, allowExecutable: true })
    assert.equal(await readFile(join(homeB, 'hooks', 'notify.sh'), 'utf8'), 'echo hello\n')
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('AGENTS.md is an opt-in executable file item', async () => {
  const sync = await temp('dsh-bag-sync-')
  const homeA = await temp('dsh-bag-home-')
  const homeB = await temp('dsh-bag-home-')
  try {
    await writeFile(join(homeA, 'AGENTS.md'), '# Global rules\n', 'utf8')
    const a = new SyncEngine({ home: homeA })
    await a.updateConfig({ syncDir: sync, selectedFiles: ['file:AGENTS.md'] })
    await a.push()

    const b = new SyncEngine({ home: homeB })
    await b.updateConfig({ syncDir: sync, selectedFiles: ['file:AGENTS.md'] })
    const plan = await b.plan()
    const item = plan.items.find(entry => entry.id === 'file:AGENTS.md')
    assert.equal(item.cls, 'executable')
    await b.apply({ planId: plan.id, allowExecutable: true })
    assert.equal(await readFile(join(homeB, 'AGENTS.md'), 'utf8'), '# Global rules\n')
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})
