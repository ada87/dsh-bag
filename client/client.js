/**
 * Browser half of dsh-bag.
 *
 * Registers one Settings tab. The tab talks to `/dsh-bag/api/*` on the same
 * origin, so the Host's existing dsh session admits it; no second token is
 * invented.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bag',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    const NS = 'dshBag'
    const API = '/dsh-bag/api'

    const zh = {
      nav: '配置袋',
      title: '配置袋',
      desc: '把选中的设置和配置文件装进一个同步文件夹，换台机器打开就有。默认只同步你勾选的内容；密钥类字段不会离开本机。',
      folder: '同步文件夹',
      folderHint: '填一个你已经在同步的目录，例如 iCloud、OneDrive、Dropbox、Syncthing 或网络盘。',
      save: '保存',
      saved: '已保存',
      namespaces: '设置命名空间',
      namespacesHint: '只有勾选的命名空间会进入同步。没有用户覆盖的命名空间不会产生内容。',
      files: '配置文件',
      filesHint: '补丁文件属于可执行变更，应用前需要单独确认。',
      localOnly: '仅本机字段',
      localOnlyHint: '每行一个：命名空间: a.b, c.d。这些字段不会上传，也不会被远端覆盖。',
      backupTitle: '加密备份文件',
      backupDesc: '把当前勾选的内容打包成一个口令加密的 .dshbag，放到 U 盘、网盘或发给另一台机器。不包含凭据。',
      exportPassword: '导出口令（至少 8 位）',
      exportButton: '导出 .dshbag',
      exportHint: '口令丢失无法恢复；文件里只有设置和配置文件。',
      importFile: '选择 .dshbag',
      importPassword: '导入口令',
      importButton: '导入并比较',
      importHint: '导入不会直接写入：先比较，再在下面确认应用。',
      exported: '已导出',
      importReady: '已解密，请检查下面的比较结果',
      planSource: '来源',
      sourceFolder: '同步文件夹',
      sourceBundle: '备份文件',
      compare: '比较',
      apply: '应用',
      push: '发布本机',
      doctor: '体检',
      repair: '修复上次写入',
      status: '状态',
      device: '设备',
      journal: '上次写入',
      journalBad: '未完成，需要修复',
      journalOk: '正常',
      counts: '本地 {local} 项 · 远端 {remote} 项 · {devices} 台设备',
      last: '上次操作',
      plan: '比较结果',
      noPlan: '还没有比较。先保存，再点「比较」。',
      writes: '{count} 项将写入本机',
      conflicts: '{count} 项冲突',
      executable: '{count} 项可执行变更',
      warnings: '提示',
      keepLocal: '保留本机',
      takeRemote: '采用远端',
      wholeItem: '整个文件',
      applyExecutable: '我确认应用可执行变更（补丁 / 预设可能执行代码）',
      applied: '已应用 {count} 项',
      pushed: '已发布 {count} 项',
      noIssues: '没有发现问题',
      noNamespaces: '没有可同步的设置命名空间',
      secret: '含密钥字段',
      restartOnly: '需重启后写入',
      error: '出错',
      work: '处理中…',
      relLocalOnly: '仅本机更新',
      relRemoteOnly: '远端更新',
      relConverged: '一致',
      relConflict: '冲突',
      relMergeable: '可合并',
      clsSafe: '即时生效',
      clsRestart: '需重启',
      clsExecutable: '可执行',
    }

    const en = {
      nav: 'Bag',
      title: 'Bag',
      desc: 'Put selected settings and profile files into one synced folder; another machine opens it and has them. Only checked items travel, and secret-shaped values never leave the machine.',
      folder: 'Sync folder',
      folderHint: 'Pick a folder you already sync: iCloud, OneDrive, Dropbox, Syncthing or a network share.',
      save: 'Save',
      saved: 'Saved',
      namespaces: 'Settings namespaces',
      namespacesHint: 'Only checked namespaces travel. A namespace with no user overrides has nothing to send.',
      files: 'Profile files',
      filesHint: 'Patch files are executable changes and need an explicit confirmation before they are applied.',
      localOnly: 'Local-only fields',
      localOnlyHint: 'One per line: namespace: a.b, c.d. These never upload and are never overwritten by a peer.',
      backupTitle: 'Encrypted backup file',
      backupDesc: 'Pack the current selection into one password-encrypted .dshbag for a USB stick, cloud drive or another machine. Credentials are never included.',
      exportPassword: 'Export password (8+ characters)',
      exportButton: 'Export .dshbag',
      exportHint: 'A lost password cannot be recovered; the file only holds settings and profile files.',
      importFile: 'Choose a .dshbag',
      importPassword: 'Import password',
      importButton: 'Import and compare',
      importHint: 'Import does not write: compare first, then apply below.',
      exported: 'Exported',
      importReady: 'Decrypted; review the comparison below',
      planSource: 'Source',
      sourceFolder: 'Sync folder',
      sourceBundle: 'Backup file',
      compare: 'Compare',
      apply: 'Apply',
      push: 'Publish this machine',
      doctor: 'Doctor',
      repair: 'Repair last write',
      status: 'Status',
      device: 'Device',
      journal: 'Last write',
      journalBad: 'unfinished, repair required',
      journalOk: 'clean',
      counts: '{local} local · {remote} remote · {devices} device(s)',
      last: 'Last operation',
      plan: 'Comparison',
      noPlan: 'Nothing compared yet. Save, then press Compare.',
      writes: '{count} item(s) will be written here',
      conflicts: '{count} conflict(s)',
      executable: '{count} executable change(s)',
      warnings: 'Notes',
      keepLocal: 'Keep local',
      takeRemote: 'Take remote',
      wholeItem: 'whole file',
      applyExecutable: 'I understand these executable changes (patches / presets can run code)',
      applied: 'Applied {count} item(s)',
      pushed: 'Published {count} item(s)',
      noIssues: 'No issues found',
      noNamespaces: 'No settings namespaces to sync',
      secret: 'has secrets',
      restartOnly: 'needs restart',
      error: 'Error',
      work: 'Working…',
      relLocalOnly: 'local only',
      relRemoteOnly: 'remote only',
      relConverged: 'in sync',
      relConflict: 'conflict',
      relMergeable: 'mergeable',
      clsSafe: 'live',
      clsRestart: 'restart',
      clsExecutable: 'executable',
    }

    const CSS = `
.dsh-bag{display:flex;flex-direction:column;gap:16px;width:100%;max-width:920px}
.dsh-bag h2,.dsh-bag h3{margin:0;color:var(--dsw-alias-label-primary,#111)}
.dsh-bag h2{font-size:18px;font-weight:600;line-height:26px}
.dsh-bag h3{font-size:14px;font-weight:600;line-height:22px}
.dsh-bag p{margin:0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary,#888)}
.dsh-bag-card{border:1px solid var(--dsw-alias-line-regular,#e5e5e5);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-surface-primary,#fff)}
.dsh-bag-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.dsh-bag-row input[type=text],.dsh-bag-row input[type=password]{flex:1;min-width:260px;padding:7px 9px;border-radius:7px;border:1px solid var(--dsw-alias-line-regular,#ddd);background:var(--dsw-alias-surface-primary,#fff);color:var(--dsw-alias-label-primary,#111);font-size:13px}
.dsh-bag button{padding:6px 12px;border-radius:7px;border:1px solid var(--dsw-alias-line-regular,#ddd);background:var(--dsw-alias-surface-primary,#fff);color:var(--dsw-alias-label-primary,#111);font-size:13px;cursor:pointer}
.dsh-bag button:hover:not(:disabled){background:var(--dsw-alias-surface-secondary,#f6f6f6)}
.dsh-bag button:disabled{opacity:.5;cursor:default}
.dsh-bag button.primary{background:var(--dsw-alias-state-business-primary,#3b82f6);border-color:transparent;color:#fff}
.dsh-bag-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px}
.dsh-bag label{display:flex;gap:7px;align-items:center;font-size:13px;color:var(--dsw-alias-label-primary,#111);cursor:pointer}
.dsh-bag textarea{width:100%;min-height:64px;padding:8px;border-radius:7px;border:1px solid var(--dsw-alias-line-regular,#ddd);background:var(--dsw-alias-surface-primary,#fff);color:var(--dsw-alias-label-primary,#111);font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-bag-bad{background:var(--dsw-alias-state-error-secondary,#fef2f2);border-color:var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-state-error-primary,#b91c1c);padding:8px 10px;border-radius:8px;font-size:13px}
.dsh-bag-ok{background:var(--dsw-alias-state-success-secondary,#f0fdf4);border-color:var(--dsw-alias-state-success-primary,#22c55e);color:var(--dsw-alias-state-success-primary,#15803d);padding:8px 10px;border-radius:8px;font-size:13px}
.dsh-bag-item{border-top:1px solid var(--dsw-alias-line-regular,#eee);padding-top:10px;display:flex;flex-direction:column;gap:6px}
.dsh-bag-item:first-child{border-top:0;padding-top:0}
.dsh-bag-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111);word-break:break-all}
.dsh-bag-meta{display:flex;gap:6px;flex-wrap:wrap}
.dsh-bag-badge{font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-surface-secondary,#f4f4f4);color:var(--dsw-alias-label-secondary,#555)}
.dsh-bag-badge.conflict{background:var(--dsw-alias-state-error-secondary,#fef2f2);color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dsh-bag-badge.executable{background:var(--dsw-alias-state-warn-secondary,#fffbeb);color:var(--dsw-alias-state-warn-primary,#b45309)}
.dsh-bag pre{margin:0;padding:8px;border-radius:7px;background:var(--dsw-alias-surface-secondary,#f7f7f7);font:11px/17px ui-monospace,SFMono-Regular,Menlo,monospace;max-height:220px;overflow:auto;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#444)}
.dsh-bag-conflict{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px}
.dsh-bag-conflict code{font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--dsw-alias-surface-secondary,#f5f5f5);padding:0 5px;border-radius:4px}
.dsh-bag-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsh-bag-msg{font-size:13px}
`

    async function request(path, options) {
      const response = await fetch(API + path, {
        ...options,
        headers: { 'content-type': 'application/json', ...((options && options.headers) || {}) },
      })
      const text = await response.text()
      let body = null
      if (text !== '') {
        try {
          body = JSON.parse(text)
        } catch {
          body = { error: { message: text } }
        }
      }
      if (!response.ok) {
        const message = body && body.error && body.error.message ? body.error.message : `HTTP ${response.status}`
        const error = new Error(message)
        error.status = response.status
        throw error
      }
      return body
    }

    function formatLocalOnly(map) {
      return Object.entries(map || {})
        .map(([ns, keys]) => `${ns}: ${keys.join(', ')}`)
        .join('\n')
    }

    function parseLocalOnly(text) {
      const out = {}
      for (const line of String(text || '').split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        const index = trimmed.indexOf(':')
        if (index < 0) continue
        const ns = trimmed.slice(0, index).trim()
        const keys = trimmed.slice(index + 1).split(',').map(key => key.trim()).filter(Boolean)
        if (ns !== '' && keys.length > 0) out[ns] = keys
      }
      return out
    }

    function Badge({ children, kind }) {
      return h('span', { className: `dsh-bag-badge${kind ? ` ${kind}` : ''}` }, children)
    }

    const REL_KEY = {
      'local-only': 'relLocalOnly',
      'remote-only': 'relRemoteOnly',
      converged: 'relConverged',
      conflict: 'relConflict',
      mergeable: 'relMergeable',
    }

    const CLS_KEY = {
      'safe-live': 'clsSafe',
      restart: 'clsRestart',
      executable: 'clsExecutable',
    }

    function relLabel(t, value) {
      return t(REL_KEY[value] || 'relConverged')
    }

    function clsLabel(t, value) {
      return t(CLS_KEY[value] || 'clsSafe')
    }

    function downloadText(filename, text) {
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    function SettingsPage({ t }) {
      const [status, setStatus] = useState(null)
      const [draft, setDraft] = useState(null)
      const [namespaces, setNamespaces] = useState([])
      const [files, setFiles] = useState([])
      const [plan, setPlan] = useState(null)
      const [doctor, setDoctor] = useState(null)
      const [decisions, setDecisions] = useState({})
      const [allowExecutable, setAllowExecutable] = useState(false)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const [exportPassword, setExportPassword] = useState('')
      const [importPassword, setImportPassword] = useState('')
      const [importText, setImportText] = useState('')
      const [importName, setImportName] = useState('')

      const refresh = useCallback(async () => {
        const [nextStatus, nextConfig, nextNamespaces, nextFiles] = await Promise.all([
          request('/status'),
          request('/config'),
          request('/namespaces'),
          request('/files'),
        ])
        setStatus(nextStatus)
        setDraft({ ...nextConfig, localOnlyText: formatLocalOnly(nextConfig.localOnlyKeys) })
        setNamespaces(nextNamespaces.namespaces || [])
        setFiles(nextFiles.files || [])
      }, [])

      useEffect(() => {
        refresh().catch(next => setError(next.message))
      }, [refresh])

      const run = useCallback(async (label, task) => {
        setBusy(label)
        setError('')
        setMessage('')
        try {
          await task()
        } catch (next) {
          setError(next.message)
        } finally {
          setBusy('')
        }
      }, [])

      const persistDraft = useCallback(async () => {
        const next = await request('/config', {
          method: 'PUT',
          body: JSON.stringify({
            patch: {
              syncDir: draft.syncDir,
              selectedNamespaces: draft.selectedNamespaces,
              selectedFiles: draft.selectedFiles,
              localOnlyKeys: parseLocalOnly(draft.localOnlyText),
              intervalMinutes: draft.intervalMinutes,
              autoApplySafe: draft.autoApplySafe,
            },
          }),
        })
        setDraft({ ...next, localOnlyText: formatLocalOnly(next.localOnlyKeys) })
        await refresh()
        return next
      }, [draft, refresh])

      const save = useCallback(() => run('save', async () => {
        await persistDraft()
        setMessage(t('saved'))
      }), [persistDraft, run, t])

      const compare = useCallback(() => run('plan', async () => {
        await persistDraft()
        const next = await request('/plan', { method: 'POST' })
        setPlan(next)
        setDecisions({})
        setAllowExecutable(false)
      }), [persistDraft, run])

      const applyPlan = useCallback(() => run('apply', async () => {
        if (plan === null) return
        const flattened = []
        for (const [key, decision] of Object.entries(decisions)) {
          const index = key.indexOf('|')
          flattened.push({ id: key.slice(0, index), path: key.slice(index + 1).split('.').filter(Boolean), decision })
        }
        const result = await request('/apply', {
          method: 'POST',
          body: JSON.stringify({
            planId: plan.id,
            decisions: flattened,
            allowExecutable,
          }),
        })
        setPlan(null)
        setDecisions({})
        await refresh()
        setMessage(t('applied').replace('{count}', String(result.applied.length)))
      }), [allowExecutable, decisions, plan, refresh, run, t])

      const push = useCallback(() => run('push', async () => {
        await persistDraft()
        const result = await request('/push', { method: 'POST' })
        await refresh()
        setMessage(t('pushed').replace('{count}', String(result.items)))
      }), [persistDraft, refresh, run, t])

      const diagnose = useCallback(() => run('doctor', async () => {
        setDoctor(await request('/doctor', { method: 'POST' }))
      }), [run])

      const repair = useCallback(() => run('recover', async () => {
        const result = await request('/recover', { method: 'POST' })
        setMessage(result.message)
        setDoctor(null)
        await refresh()
      }), [refresh, run])

      const exportBag = useCallback(() => run('export', async () => {
        const result = await request('/export', {
          method: 'POST',
          body: JSON.stringify({ password: exportPassword }),
        })
        downloadText(result.filename, result.data)
        setExportPassword('')
        setMessage(`${t('exported')}: ${result.filename}`)
      }), [exportPassword, run, t])

      const importBag = useCallback(() => run('import', async () => {
        if (importText === '') throw new Error(t('importFile'))
        const next = await request('/import/plan', {
          method: 'POST',
          body: JSON.stringify({ file: importText, password: importPassword }),
        })
        setPlan(next)
        setDecisions({})
        setAllowExecutable(false)
        setDoctor(null)
        setImportPassword('')
        setMessage(t('importReady'))
      }), [importPassword, importText, run, t])

      const chooseFile = useCallback(async event => {
        const file = event.target.files && event.target.files[0]
        if (!file) return
        setImportName(file.name)
        setImportText(await file.text())
        setPlan(null)
        setError('')
        setMessage('')
      }, [])

      const toggle = useCallback((field, id) => {
        setDraft(current => {
          if (current === null) return current
          const values = new Set(current[field] || [])
          if (values.has(id)) values.delete(id)
          else values.add(id)
          return { ...current, [field]: [...values] }
        })
        setPlan(null)
      }, [])

      const decide = useCallback((key, decision) => {
        setDecisions(current => ({ ...current, [key]: decision }))
      }, [])

      const grouped = useMemo(() => {
        if (plan === null) return []
        return plan.items.filter(item => item.writes || (item.conflicts && item.conflicts.length > 0))
      }, [plan])

      if (draft === null || status === null) {
        return h('section', { className: 'dsh-bag' },
          h('h2', null, t('title')),
          h('p', null, error || t('work')))
      }

      return h('section', { className: 'dsh-bag' },
        h('header', { className: 'dsh-bag-card' },
          h('h2', null, t('title')),
          h('p', null, t('desc')),
          h('div', { className: 'dsh-bag-meta' },
            h(Badge, null, `${t('device')}: ${status.device.name}`),
            h(Badge, { kind: status.journal === 'incomplete' ? 'conflict' : '' },
              `${t('journal')}: ${status.journal === 'incomplete' ? t('journalBad') : t('journalOk')}`),
            h(Badge, null, t('counts')
              .replace('{local}', String(status.counts.localItems))
              .replace('{remote}', String(status.counts.remoteItems))
              .replace('{devices}', String(status.counts.remoteDevices)))),
          status.lastOperation !== null
            ? h('p', null, `${t('last')}: ${status.lastOperation.op} · ${status.lastOperation.message || ''}`)
            : null,
          status.warnings && status.warnings.length > 0
            ? h('div', null, status.warnings.map((warning, index) => h('p', { key: index }, warning)))
            : null,
          status.journal === 'incomplete'
            ? h('button', { onClick: repair, disabled: busy !== '' }, t('repair'))
            : null),

        h('div', { className: 'dsh-bag-card' },
          h('h3', null, t('folder')),
          h('p', null, t('folderHint')),
          h('div', { className: 'dsh-bag-row' },
            h('input', {
              type: 'text',
              value: draft.syncDir,
              placeholder: 'D:\\sync\\dsh-bag',
              onChange: event => {
                setDraft({ ...draft, syncDir: event.target.value })
                setPlan(null)
              },
            }),
            h('button', { onClick: save, disabled: busy !== '' }, t('save')))),

        h('div', { className: 'dsh-bag-card' },
          h('h3', null, t('namespaces')),
          h('p', null, t('namespacesHint')),
          namespaces.length === 0
            ? h('p', null, t('noNamespaces'))
            : h('div', { className: 'dsh-bag-grid' },
              namespaces.map(entry => h('label', { key: entry.ns, title: entry.live ? '' : t('restartOnly') },
                h('input', {
                  type: 'checkbox',
                  disabled: !entry.live,
                  checked: entry.live && (draft.selectedNamespaces || []).includes(entry.ns),
                  onChange: () => toggle('selectedNamespaces', entry.ns),
                }),
                entry.ns,
                entry.live ? null : h('span', { className: 'dsh-bag-badge' }, t('restartOnly')),
                entry.secrets > 0 ? h('span', { className: 'dsh-bag-badge' }, t('secret')) : null)))),

        h('div', { className: 'dsh-bag-card' },
          h('h3', null, t('files')),
          h('p', null, t('filesHint')),
          h('div', { className: 'dsh-bag-grid' },
            files.map(entry => h('label', { key: entry.id },
              h('input', {
                type: 'checkbox',
                checked: (draft.selectedFiles || []).includes(entry.id),
                onChange: () => toggle('selectedFiles', entry.id),
              }),
              entry.label,
              entry.cls === 'executable' ? h('span', { className: 'dsh-bag-badge executable' }, t('clsExecutable')) : null)))),

        h('div', { className: 'dsh-bag-card' },
          h('h3', null, t('localOnly')),
          h('p', null, t('localOnlyHint')),
          h('textarea', {
            value: draft.localOnlyText !== undefined ? draft.localOnlyText : formatLocalOnly(draft.localOnlyKeys),
            onChange: event => {
              setDraft({ ...draft, localOnlyText: event.target.value })
              setPlan(null)
            },
          })),

        h('div', { className: 'dsh-bag-card' },
          h('h3', null, t('backupTitle')),
          h('p', null, t('backupDesc')),
          h('div', { className: 'dsh-bag-row' },
            h('input', {
              type: 'password',
              value: exportPassword,
              placeholder: t('exportPassword'),
              onChange: event => setExportPassword(event.target.value),
            }),
            h('button', { onClick: exportBag, disabled: busy !== '' }, t('exportButton'))),
          h('p', null, t('exportHint')),
          h('div', { className: 'dsh-bag-row' },
            h('input', {
              type: 'file',
              accept: '.dshbag,application/json',
              onChange: chooseFile,
            }),
            importName !== '' ? h('span', { className: 'dsh-bag-badge' }, importName) : null),
          h('div', { className: 'dsh-bag-row' },
            h('input', {
              type: 'password',
              value: importPassword,
              placeholder: t('importPassword'),
              onChange: event => setImportPassword(event.target.value),
            }),
            h('button', { onClick: importBag, disabled: busy !== '' || importText === '' }, t('importButton'))),
          h('p', null, t('importHint'))),

        h('div', { className: 'dsh-bag-actions' },
          h('button', { className: 'primary', onClick: compare, disabled: busy !== '' }, t('compare')),
          h('button', { onClick: push, disabled: busy !== '' }, t('push')),
          h('button', { onClick: diagnose, disabled: busy !== '' }, t('doctor'))),

        busy !== '' ? h('p', { className: 'dsh-bag-msg' }, t('work')) : null,
        error !== '' ? h('div', { className: 'dsh-bag-bad' }, `${t('error')}: ${error}`) : null,
        message !== '' ? h('div', { className: 'dsh-bag-ok' }, message) : null,

        plan !== null
          ? h('div', { className: 'dsh-bag-card' },
            h('h3', null, t('plan')),
            h('div', { className: 'dsh-bag-meta' },
              h(Badge, null, `${t('planSource')}: ${plan.source === 'bundle' ? t('sourceBundle') : t('sourceFolder')}`),
              h(Badge, null, t('writes').replace('{count}', String(plan.writes))),
              h(Badge, { kind: plan.conflicts > 0 ? 'conflict' : '' }, t('conflicts').replace('{count}', String(plan.conflicts))),
              h(Badge, { kind: plan.executable > 0 ? 'executable' : '' }, t('executable').replace('{count}', String(plan.executable)))),
            plan.warnings.length > 0
              ? h('div', null, plan.warnings.map((warning, index) => h('p', { key: index }, warning)))
              : null,
            grouped.length === 0
              ? h('p', null, t('noPlan'))
              : grouped.map(item => h('div', { className: 'dsh-bag-item', key: item.id },
                h('div', { className: 'dsh-bag-meta' },
                  h(Badge, { kind: item.relation === 'conflict' ? 'conflict' : '' }, relLabel(t, item.relation)),
                  h(Badge, { kind: item.cls === 'executable' ? 'executable' : '' }, clsLabel(t, item.cls)),
                  item.revision !== undefined ? h(Badge, null, `rev ${item.revision}`) : null),
                h('div', { className: 'dsh-bag-name' }, item.label),
                h('p', null, item.id),
                item.preview ? h('pre', null, item.preview) : null,
                (item.conflicts || []).map(conflict => {
                  const key = `${item.id}|${conflict.path.join('.')}`
                  const current = decisions[key] || 'keep-local'
                  return h('div', { className: 'dsh-bag-conflict', key },
                    h('code', null, conflict.path.length === 0 ? t('wholeItem') : conflict.path.join('.')),
                    h('label', null,
                      h('input', {
                        type: 'radio',
                        name: key,
                        checked: current === 'keep-local',
                        onChange: () => decide(key, 'keep-local'),
                      }),
                      t('keepLocal')),
                    h('label', null,
                      h('input', {
                        type: 'radio',
                        name: key,
                        checked: current === 'take-remote',
                        onChange: () => decide(key, 'take-remote'),
                      }),
                      t('takeRemote')))
                }))),
            plan.executable > 0
              ? h('label', null,
                h('input', {
                  type: 'checkbox',
                  checked: allowExecutable,
                  onChange: event => setAllowExecutable(event.target.checked),
                }),
                t('applyExecutable'))
              : null,
            h('div', { className: 'dsh-bag-actions' },
              h('button', {
                className: 'primary',
                onClick: applyPlan,
                disabled: busy !== '' || (plan.writes === 0 && plan.conflicts === 0) || (plan.executable > 0 && !allowExecutable),
              }, t('apply'))))
          : null,

        doctor !== null
          ? h('div', { className: 'dsh-bag-card' },
            h('h3', null, t('doctor')),
            doctor.issues.length === 0
              ? h('div', { className: 'dsh-bag-ok' }, t('noIssues'))
              : doctor.issues.map((issue, index) => h('div', {
                key: index,
                className: issue.severity === 'error' ? 'dsh-bag-bad' : 'dsh-bag-msg',
              }, `[${issue.severity}] ${issue.code}: ${issue.message}`)))
          : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-bag: copy')
        const t = ctx.locale.bind(NS)

        const style = document.createElement('style')
        style.dataset.dshBag = ''
        style.textContent = CSS
        document.head.append(style)

        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'dsh-bag',
          order: 30,
          label: () => t('nav'),
        }, () => h(SettingsPage, { t })))

        ctx.effect(() => () => style.remove(), 'dsh-bag: styles')
      },
    }
  },
})
