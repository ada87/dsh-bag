# dsh-bag

Portable config sync for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Put the settings and profile files you choose into **a folder you already sync** — iCloud Drive, OneDrive, Dropbox, Syncthing, a NAS share — and another machine opens it with the same configuration. No account, no server, no telemetry.

> 把选中的 dsh 设置和配置文件装进一个你已经在同步的文件夹，换台机器打开就有。不需要账号，不需要服务器。

## Install

```sh
dsh plugin --profile web add dsh-bag
```

Restart `dsh web`, then open **Settings → Bag**.

## Quick start

1. Enter an absolute **sync folder** outside the dsh home, for example `D:\sync\dsh-bag` or `~/Sync/dsh-bag`.
2. Tick the settings namespaces and profile files you want to travel.
3. **Save**.
4. On the source machine press **Publish this machine**.
5. On another machine press **Compare**, review, then **Apply**.

The sync folder is a normal folder. Any file-sync tool works, including one that only copies files and knows nothing about conflicts.

### Encrypted backup file

The same selection can travel as one password-encrypted `.dshbag` file:

- **Export .dshbag** — PBKDF2-SHA256 (600k iterations) + AES-256-GCM.
- **Import and compare** — decrypt, validate against the allowlist, and show the same plan as a folder compare. Nothing is written until you press Apply.

The file holds only settings and profile files; credentials are never captured. A lost password cannot be recovered.

## What travels

| Item | Default | Notes |
|---|---|---|
| Selected settings namespaces | off | Only fields beneath a schema-declared `volatile` node travel — the ones dsh accepts as live writes. Secret-declared fields are redacted before capture and never uploaded. |
| `profiles/web/package.json` | off | Plugin list; needs a restart. |
| `profiles/web/cordis.patch.yml` | off | Executable; requires explicit confirmation. |
| `profiles/headless/package.json` | off | Same as the web profile. |
| `profiles/headless/cordis.patch.yml` | off | Executable. |
| `cordis.patch.yml` (home patch) | off | Executable. |

Never touched: credentials, sessions, storages, `node_modules`, `.env*`, `cordis.yml`, generated profile files, or anything not enumerated above.

### Local-only fields

Some keys belong to one machine, for example a provider `baseURL`. Enter them as:

```
llm-deepseek: baseURL
ui-theme: preference
```

They are stripped before capture and are never overwritten by a peer.

## How it works

```
<sync folder>/
  meta.json
  devices/<deviceId>.json     ← every device writes only its own snapshot
```

- Each device owns one snapshot file, so a "dumb" sync client never makes two machines overwrite the same file.
- Items carry their own timestamp: pushing an unchanged item keeps its old timestamp.
- Compare is a three-way merge: **base** (last accepted), **local** (live), **remote** (newest across devices). Maps merge by key; arrays and scalars are atomic.
- Applying a remote change is journaled: raw files are backed up, settings edits are paired with a compensation edit, and an interrupted write can be repaired from **Settings → Bag → Repair**.
- A plan is refused if the local file or the remote folder changed after you reviewed it.

## Safety

- **Positive allowlist.** The plugin never walks the dsh home and subtracts a deny list.
- **Secret scan.** Known secret shapes (private keys, GitHub/GitLab tokens, AWS keys, `dshh_`/`dshr_` tokens, `Bearer` headers, …) refuse to publish. Diagnostics name the path and rule, never the value.
- **Redaction.** `settings.describe({ redactSecrets: true })` removes schema-declared secrets before anything is captured.
- **Executable changes.** Profile patches, home patches and preset files can run code. They are never applied without a separate confirmation.
- **Trusted writes.** Every `/dsh-bag/api/*` route requires a same-origin browser request, loopback, or a dsh connection the Host admits.
- **No license check, no call-home.** Self-hosting and offline use are first-class.

## v1 limitations

- **Folder backend only.** Git and WebDAV backends are intentionally deferred; the engine is written behind a small backend seam.
- **One backup file, no history.** A `.dshbag` is a snapshot; exporting again does not keep older bundles.
- **Live settings only.** A settings namespace is selectable only when its schema declares at least one `volatile` field, because that is what `ctx.settings.mutate()` accepts. Settings that require a restart are disabled in the picker.
- **Deletions.** Removing a key inside a settings namespace propagates (it is part of the merge). Removing a whole file does not: a machine that lacks a selected file simply receives it.
- **Agent preset directories.** Preset IDs travel with the `agent-presets` settings namespace; user preset directories are not copied yet.
- **Plan lifetime.** A comparison is valid for 10 minutes and is discarded after a successful apply.

## API

All routes except `/dsh-bag/health` require a trusted request.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-bag/health` | Liveness |
| GET | `/dsh-bag/api/status` | Device, counts, journal, last operation |
| GET | `/dsh-bag/api/config` | Current config |
| PUT | `/dsh-bag/api/config` | Patch `syncDir`, selections, local-only keys, device name |
| GET | `/dsh-bag/api/namespaces` | Settings namespaces in this profile |
| GET | `/dsh-bag/api/files` | Enumerated profile files |
| POST | `/dsh-bag/api/plan` | Compare and return a plan |
| POST | `/dsh-bag/api/apply` | Apply a plan (optional per-path decisions, `allowExecutable`) |
| POST | `/dsh-bag/api/push` | Publish this machine's snapshot |
| POST | `/dsh-bag/api/export` | Encrypt the current selection into a `.dshbag` payload |
| POST | `/dsh-bag/api/import/plan` | Decrypt a `.dshbag` and return a plan (no writes) |
| POST | `/dsh-bag/api/doctor` | Diagnose folder, settings, journal, secrets |
| POST | `/dsh-bag/api/recover` | Repair an interrupted apply |

## Development

```sh
npm install
npm run typecheck
npm test          # build + unit and two-machine engine tests
```

```
src/index.ts      plugin entry and route registration
src/engine.ts     capture / plan / apply / push / doctor / recover
src/backend.ts    folder backend (device snapshots)
src/merge.ts      three-way merge, path edits, preview diff
src/policy.ts     item allowlist and path validation
src/secret-scan.ts
src/journal.ts    backup + compensation log
src/routes.ts     /dsh-bag HTTP API
client/client.js  Settings → Bag
```

State lives under `<DSH_HOME>/state/dsh-bag/`: `config.json`, `state.json`, `journal.json`, `backups/`.

## License

MIT
