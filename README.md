# DSH Bag

[![npm version](https://img.shields.io/npm/v/dsh-bag?color=3d7bfd)](https://www.npmjs.com/package/dsh-bag)
[![npm downloads](https://img.shields.io/npm/dm/dsh-bag?color=3d7bfd)](https://www.npmjs.com/package/dsh-bag)
[![license](https://img.shields.io/npm/l/dsh-bag?color=3d7bfd)](https://github.com/ada87/dsh-bag/blob/main/LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.x-3d7bfd)](https://github.com/ada87/dsh-bag/blob/main/docs/COMPATIBILITY.md)
[![GitHub stars](https://img.shields.io/github/stars/ada87/dsh-bag?color=3d7bfd&logo=github)](https://github.com/ada87/dsh-bag)

Portable capability packs for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Bring agent capabilities in from elsewhere, keep them in one synced folder, and hand them to every dsh machine. Sessions and context stay local. No account, no server, no telemetry.

> 把别处的 agent 能力装进袋子，带到所有 dsh。会话和上下文留在原地。

Three layers:

```
Import            Pack                    Deliver
Claude Code  →    skills / presets   →    folder / Git / .dshbag
skills            hooks / AGENTS.md        Door Cloud (later)
```

## Features

- **Bring skills in.** Scan Claude Code skills, review compatibility badges, and import selected directories into `~/.dsh/skills`.
- **One pack, every machine.** Selected settings namespaces, user presets, hooks and profile files travel together.
- **Three deliveries.** A synced folder, a Git repository, or one password-encrypted `.dshbag` file.
- **Nothing secret leaves.** Secret-shaped fields are redacted before capture; credentials are never stored.
- **Explicit confirmation.** Hooks, patches and AGENTS.md are executable changes and always require a checkbox.

## Install

```sh
dsh plugin --profile web add dsh-bag
```

Restart `dsh web`, then open **Settings → DSH Bag**.

Compatibility: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Usage

- Open **Settings → DSH Bag** to scan Claude Code skills, choose what travels, and save the pack.
- Pick a delivery: a synced folder, a Git remote, or an exportable `.dshbag` file.
- On another machine press **Compare**, review the plan, then **Apply**. Executable items require confirmation.

### Quick start

### Import skills from Claude Code

- Open **Settings → DSH Bag → Skills → Scan Claude Code**.
- Review the compatibility badges; import the selected directories into `~/.dsh/skills` (or `~/.agents/skills` if you choose the shared root).
- Or use chat:

```text
/bag scan
/bag import pdf-tools deploy-helper
/bag status
```

Imported skills are added to the capability pack automatically.

### Sync the pack

1. Choose a **delivery**: a synced folder, or a **Git repository**.
   - Folder: an absolute path outside the dsh home, for example `D:\sync\dsh-bag`.
   - Git: a remote such as `git@github.com:you/dsh-bag-config.git` and a branch (default `main`). Authentication uses your existing git environment; credentials are never stored.
2. Tick the settings namespaces, profile files, user presets and skills you want to travel; enable hooks if needed.
3. **Save**.
4. On the source machine press **Publish this machine**.
5. On another machine press **Compare**, review, then **Apply**.

Skills and patches are executable changes: applying them requires the explicit confirmation checkbox.

### Encrypted backup file

The same selection can travel as one password-encrypted `.dshbag` file:

- **Export .dshbag** — PBKDF2-SHA256 (600k iterations) + AES-256-GCM.
- **Import and compare** — decrypt, validate against the allowlist, and show the same plan as a folder compare. Nothing is written until you press Apply.

The file holds only skills, settings and profile files; credentials are never captured. A lost password cannot be recovered.

## What travels

| Item | Default | Notes |
|---|---|---|
| **Skills** (`~/.dsh/skills/<name>/`) | off | Atomic directory snapshots; text and base64 files; executable confirmation. |
| **User presets** (`~/.dsh/.agent-presets/<id>/`) | off | Atomic directory snapshots; shipped presets are never touched. |
| **Hooks** (`~/.dsh/hooks/`) | off | Executable; always requires confirmation. |
| Selected settings namespaces | off | Only fields beneath a schema-declared `volatile` node travel — the ones dsh accepts as live writes. Secret-declared fields are redacted before capture and never uploaded. |
| `profiles/web/package.json` | off | Plugin list; needs a restart. |
| `profiles/web/cordis.patch.yml` | off | Executable; requires explicit confirmation. |
| `profiles/headless/package.json` | off | Same as the web profile. |
| `profiles/headless/cordis.patch.yml` | off | Executable. |
| `cordis.patch.yml` (home patch) | off | Executable. |
| `AGENTS.md` | off | Global instructions; treated as executable because it changes behavior. |

Never touched: credentials, sessions, storages, `node_modules`, `.env*`, `cordis.yml`, generated profile files, or anything not enumerated above.

### Local-only fields

Some keys belong to one machine, for example a provider `baseURL`. Enter them as:

```
llm-deepseek: baseURL
ui-theme: preference
```

They are stripped before capture and are never overwritten by a peer.

### Import from other agents (v1: Claude Code)

- Scans `~/.claude/skills` (honors `CLAUDE_CONFIG_DIR`) for `<name>/SKILL.md` directory bundles.
- Reports compatibility issues: missing frontmatter, Claude-only tools, absolute paths, `allowed-tools`.
- Copies selected skills into `~/.dsh/skills` by default, or `~/.agents/skills` when “share with other agents” is chosen.
- Never overwrites an existing skill with a different hash; re-importing the same content is a no-op.
- Flat `<name>.md` skills, MCP servers, presets and hooks are not imported in this version.

## How it works

```
<folder or git repo>/
  meta.json
  devices/<deviceId>.json     ← every device writes only its own snapshot
```

- Each device owns one snapshot file, so a "dumb" sync client never makes two machines overwrite the same file. The Git backend keeps its sidecar checkout under `<DSH_HOME>/state/dsh-bag/git` and commits after each publish; pushes retry once after a pull, and device files never overlap.
- Items carry their own timestamp: pushing an unchanged item keeps its old timestamp.
- Compare is a three-way merge: **base** (last accepted), **local** (live), **remote** (newest across devices). Maps merge by key; arrays and scalars are atomic.
- Applying a remote change is journaled: raw files are backed up, settings edits are paired with a compensation edit, and an interrupted write can be repaired from **Settings → DSH Bag → Repair**.
- A plan is refused if the local file or the remote folder changed after you reviewed it.

## Safety

- **Positive allowlist.** The plugin never walks the dsh home and subtracts a deny list.
- **Secret scan.** Known secret shapes (private keys, GitHub/GitLab tokens, AWS keys, `dshh_`/`dshr_` tokens, `Bearer` headers, …) refuse to publish. Diagnostics name the path and rule, never the value.
- **Redaction.** `settings.describe({ redactSecrets: true })` removes schema-declared secrets before anything is captured.
- **Executable changes.** Profile patches, home patches and preset files can run code. They are never applied without a separate confirmation.
- **Trusted writes.** Every `/dsh-bag/api/*` route requires a same-origin browser request, loopback, or a dsh connection the Host admits.
- **No license check, no call-home.** Self-hosting and offline use are first-class.

## v1 limitations

- **Import is Claude Code skills only.** MCP servers, hooks and flat `<name>.md` skills are deferred; user presets are synced but not imported.
- **Git is a sidecar.** Local changes are committed to `<DSH_HOME>/state/dsh-bag/git`; the backend never checks out into your worktrees. Authentication must be non-interactive (credential helper or SSH key).
- **Whole-skill deletion is not propagated.** File-level changes inside a skill merge; removing a selected skill from every machine is manual.
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
| GET | `/dsh-bag/api/presets` | User presets present under `~/.dsh/.agent-presets` |
| GET | `/dsh-bag/api/import/scan` | Read-only Claude Code skill scan |
| POST | `/dsh-bag/api/import/skills` | Import selected skills into the configured root |
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
src/index.ts      plugin entry, route registration and /bag command
src/engine.ts     capture / plan / apply / push / doctor / recover
src/skills.ts     skill directory snapshots and safe writes
src/import/       Claude Code scan + import adapters
src/backend.ts    folder backend (device snapshots)
src/backend-git.ts Git sidecar backend (commit + push, files never overlap)
src/merge.ts      three-way merge, path edits, preview diff
src/policy.ts     item allowlist and path validation
src/secret-scan.ts
src/journal.ts    backup + compensation log
src/routes.ts     /dsh-bag HTTP API
client/client.js  Settings → DSH Bag
```

State lives under `<DSH_HOME>/state/dsh-bag/`: `config.json`, `state.json`, `journal.json`, `backups/`.

## License

MIT
