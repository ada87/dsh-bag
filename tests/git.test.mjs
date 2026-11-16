import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { SyncEngine } from '../lib/engine.js'
import { assertGitUrl } from '../lib/policy.js'

const execFileAsync = promisify(execFile)

async function gitAvailable() {
  try {
    await execFileAsync('git', ['--version'])
    return true
  } catch {
    return false
  }
}

async function temp(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

function fileUrl(path) {
  return `file:///${path.replace(/\\/g, '/')}`
}

test('git URLs reject embedded credentials', () => {
  assert.throws(() => assertGitUrl('https://user:pass@example.com/repo.git'), /must not embed credentials/)
  assert.equal(assertGitUrl('git@github.com:you/repo.git'), 'git@github.com:you/repo.git')
  assert.equal(assertGitUrl('https://example.com/repo.git'), 'https://example.com/repo.git')
})

test('the git backend publishes and restores through a bare remote', { skip: !(await gitAvailable()) }, async () => {
  const root = await temp('dsh-bag-git-')
  const bare = join(root, 'remote.git')
  await mkdir(bare, { recursive: true })
  await execFileAsync('git', ['init', '--bare', bare])
  const homeA = await temp('dsh-bag-home-')
  const homeB = await temp('dsh-bag-home-')
  try {
    await writeFile(join(homeA, 'AGENTS.md'), '# Rules A\n', 'utf8')
    const config = {
      backend: 'git',
      gitUrl: fileUrl(bare),
      gitBranch: 'main',
      selectedFiles: ['file:AGENTS.md'],
    }

    const a = new SyncEngine({ home: homeA })
    await a.updateConfig(config)
    const status = await a.status()
    assert.equal(status.backend, 'git')
    assert.equal(status.configured, true)
    await a.push()

    const b = new SyncEngine({ home: homeB })
    await b.updateConfig(config)
    const plan = await b.plan()
    const item = plan.items.find(entry => entry.id === 'file:AGENTS.md')
    assert.equal(item.relation, 'remote-only')
    await b.apply({ planId: plan.id, allowExecutable: true })
    assert.equal(await readFile(join(homeB, 'AGENTS.md'), 'utf8'), '# Rules A\n')

    await mkdir(join(homeB, 'hooks'), { recursive: true })
    await writeFile(join(homeB, 'hooks', 'notify.sh'), 'echo b\n', 'utf8')
    await b.updateConfig({ ...config, syncHooks: true })
    await b.push()

    await a.updateConfig({ ...config, syncHooks: true })
    const next = await a.plan()
    const hooks = next.items.find(entry => entry.id === 'hooks')
    assert.equal(hooks.relation, 'remote-only')
    await a.apply({ planId: next.id, allowExecutable: true })
    assert.equal(await readFile(join(homeA, 'hooks', 'notify.sh'), 'utf8'), 'echo b\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  }
})
