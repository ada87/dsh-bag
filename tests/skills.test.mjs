import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SyncEngine } from '../lib/engine.js'
import { readSkillDir, skillHash } from '../lib/skills.js'

async function temp(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

async function claudeHome(skills) {
  const dir = await temp('dsh-bag-claude-')
  for (const [name, body] of Object.entries(skills)) {
    const skillDir = join(dir, 'skills', name)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), body, 'utf8')
  }
  return dir
}

function instruction(name, extra = '') {
  return `---\nname: ${name}\ndescription: demo skill\n---\n\nUse this skill.\n${extra}`
}

test('scan finds compatible Claude skills and flags Claude-only tools', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  const claude = await claudeHome({
    demo: instruction('demo'),
    claudeish: instruction('claudeish', 'Call TodoWrite when done.'),
  })
  process.env.CLAUDE_CONFIG_DIR = claude
  try {
    const engine = new SyncEngine({ home: await temp('dsh-bag-home-') })
    const scan = await engine.scanSkills()
    const demo = scan.found.find(entry => entry.name === 'demo')
    const claudeish = scan.found.find(entry => entry.name === 'claudeish')
    assert.equal(demo.compatible, true)
    assert.equal(claudeish.compatible, false)
    assert.ok(claudeish.issues.some(issue => /Claude Code-only/.test(issue)))
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(claude, { recursive: true, force: true })
  }
})

test('import copies a skill into ~/.dsh/skills and selects it', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  const claude = await claudeHome({ demo: instruction('demo') })
  process.env.CLAUDE_CONFIG_DIR = claude
  const home = await temp('dsh-bag-home-')
  try {
    const engine = new SyncEngine({ home })
    const result = await engine.importSkills(['demo'])
    assert.deepEqual(result.imported, ['demo'])
    assert.equal(result.target, join(home, 'skills'))
    assert.equal(await readFile(join(home, 'skills', 'demo', 'SKILL.md'), 'utf8'), instruction('demo'))
    assert.ok((await engine.config()).selectedSkills.includes('demo'))

    const again = await engine.importSkills(['demo'])
    assert.deepEqual(again.imported, [])
    assert.equal(again.skipped[0].reason, 'already present')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(claude, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('a skill travels through the folder backend and needs confirmation', async () => {
  const sync = await temp('dsh-bag-sync-')
  const homeA = await temp('dsh-bag-home-')
  const homeB = await temp('dsh-bag-home-')
  await mkdir(join(homeA, 'skills', 'demo'), { recursive: true })
  await writeFile(join(homeA, 'skills', 'demo', 'SKILL.md'), instruction('demo'), 'utf8')
  try {
    const a = new SyncEngine({ home: homeA })
    await a.updateConfig({ syncDir: sync, selectedSkills: ['demo'] })
    await a.push()

    const b = new SyncEngine({ home: homeB })
    await b.updateConfig({ syncDir: sync, selectedSkills: ['demo'] })
    const plan = await b.plan()
    const item = plan.items.find(entry => entry.id === 'skill:demo')
    assert.equal(item.relation, 'remote-only')
    assert.equal(item.cls, 'executable')

    await assert.rejects(() => b.apply({ planId: plan.id }), /executable change/)
    const result = await b.apply({ planId: plan.id, allowExecutable: true })
    assert.deepEqual(result.applied, ['skill:demo'])
    assert.equal(await readFile(join(homeB, 'skills', 'demo', 'SKILL.md'), 'utf8'), instruction('demo'))
  } finally {
    await rm(sync, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('a skill conflict is resolved per whole directory', async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  const claude = await claudeHome({ demo: instruction('demo') })
  process.env.CLAUDE_CONFIG_DIR = claude
  const sync = await temp('dsh-bag-sync-')
  const homeA = await temp('dsh-bag-home-')
  const homeB = await temp('dsh-bag-home-')
  try {
    const a = new SyncEngine({ home: homeA })
    const b = new SyncEngine({ home: homeB })
    await a.updateConfig({ syncDir: sync, selectedSkills: ['demo'] })
    await b.updateConfig({ syncDir: sync, selectedSkills: ['demo'] })
    await a.importSkills(['demo'])
    await b.importSkills(['demo'])
    await a.push()
    let plan = await b.plan()
    await b.apply({ planId: plan.id, allowExecutable: true })

    await writeFile(join(homeA, 'skills', 'demo', 'SKILL.md'), instruction('demo', 'A change.\n'), 'utf8')
    await writeFile(join(homeB, 'skills', 'demo', 'SKILL.md'), instruction('demo', 'B change.\n'), 'utf8')
    await a.push()
    plan = await b.plan()
    const item = plan.items.find(entry => entry.id === 'skill:demo')
    assert.equal(item.relation, 'conflict')
    const result = await b.apply({
      planId: plan.id,
      allowExecutable: true,
      decisions: [{ id: item.id, path: [], decision: 'take-remote' }],
    })
    assert.deepEqual(result.applied, ['skill:demo'])
    assert.equal(await readFile(join(homeB, 'skills', 'demo', 'SKILL.md'), 'utf8'), instruction('demo', 'A change.\n'))
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(claude, { recursive: true, force: true })
    await rm(sync, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})

test('skill snapshots include binary files and stay stable', async () => {
  const home = await temp('dsh-bag-home-')
  const dir = join(home, 'skills', 'binary-demo')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), instruction('binary-demo'), 'utf8')
  await writeFile(join(dir, 'icon.png'), Buffer.from([0, 1, 2, 3, 255]))
  try {
    const first = await readSkillDir(join(home, 'skills'), 'binary-demo')
    const second = await readSkillDir(join(home, 'skills'), 'binary-demo')
    assert.equal(first.files['icon.png'].encoding, 'base64')
    assert.equal(skillHash(first), skillHash(second))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a skill travels inside an encrypted .dshbag', async () => {
  const homeA = await temp('dsh-bag-home-')
  const homeB = await temp('dsh-bag-home-')
  await mkdir(join(homeA, 'skills', 'demo'), { recursive: true })
  await writeFile(join(homeA, 'skills', 'demo', 'SKILL.md'), instruction('demo'), 'utf8')
  const password = 'correct horse battery'
  try {
    const a = new SyncEngine({ home: homeA })
    await a.updateConfig({ selectedSkills: ['demo'] })
    const exported = await a.exportBundle(password)

    const b = new SyncEngine({ home: homeB })
    const plan = await b.planBundle(exported.data, password)
    const item = plan.items.find(entry => entry.id === 'skill:demo')
    assert.equal(item.kind, 'skill')
    const result = await b.apply({ planId: plan.id, allowExecutable: true })
    assert.deepEqual(result.applied, ['skill:demo'])
    assert.equal(await readFile(join(homeB, 'skills', 'demo', 'SKILL.md'), 'utf8'), instruction('demo'))
  } finally {
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})
