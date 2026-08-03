# Debugging Obsidian Plugins with the `obsidian` CLI

> How to troubleshoot a broken/misbehaving Obsidian plugin using the local
> `obsidian` CLI (talks to the **running** Obsidian app — no restart needed
> to inspect, and plugins can be enabled/disabled live).
> Learned 2026-08-04 while fixing the Pi Chat plugin (pi-chat-local).

## The CLI

- Binary: `/opt/homebrew/bin/obsidian` (a community CLI — https://obsidian.md/cli)
- It connects to the **currently running** Obsidian instance over local IPC.
- `obsidian --help` lists everything. Key families:
  - `eval` — run JS inside the app (the workhorse)
  - `dev:cdp` / `dev:dom` / `dev:console` / `dev:errors` / `dev:screenshot` / `dev:debug`
  - `plugin:enable` / `plugin:disable` / `plugin` (info) / `plugin:install`
  - `vaults verbose`, `version`, `workspace`

## The 5-minute plugin debug loop

1. **Find the loaded plugin + version**
   ```bash
   obsidian eval 'code=JSON.stringify(window.app.plugins.plugins["<id>"] ? window.app.plugins.plugins["<id>"].manifest : null)'
   ```
   This tells you **which** plugin is actually loaded (critical when two
   plugins share an id — see the collision gotcha below).

2. **Capture errors** (console capture must be turned on first)
   ```bash
   obsidian dev:debug on
   obsidian dev:errors          # plugin load failures etc.
   obsidian dev:console level=error limit=20
   ```
   A load failure like `Plugin failure: <id>` with `TypeError: h is not a
   constructor` means the bundle's export shape is wrong (see gotcha 2).

3. **Enable/disable live**
   ```bash
   obsidian plugin:enable id=<plugin-id> filter=community
   obsidian plugin:disable id=<plugin-id> filter=community
   ```
   Disable+enable forces a fresh `onload()` with the code currently on disk.
   Note: this **destroys/recreates open views** of that plugin.

4. **Inspect state and DOM**
   ```bash
   obsidian eval 'code=JSON.stringify(app.workspace.getLeavesOfType("<view-type>").map(l=>l.view))'
   obsidian dev:dom selector=".notice" total text all
   ```

5. **Reproduce the failure in-app** (ground truth — do this before guessing)
   ```bash
   obsidian eval 'code=(()=>{const{spawnSync}=require("child_process");const r=spawnSync("/abs/path/to/binary",["--version"],{encoding:"utf8",timeout:8000});return JSON.stringify({status:r.status,stderr:r.stderr&&r.stderr.slice(0,200)});})()'
   ```
   This runs inside the renderer exactly like the plugin does.

6. **Screenshot for the user**
   ```bash
   obsidian dev:screenshot path=/tmp/plugin-state.png
   ```

7. **Redeploy + reload after a code fix**
   ```bash
   npm run build        # writes main.js/manifest.json/styles.css to the vault plugin folder
   obsidian plugin:disable id=<id> filter=community && obsidian plugin:enable id=<id> filter=community
   ```

## Gotchas that cost real time (all hit during Pi Chat work)

### 1. Plugin-id collision: two plugins, same id, one folder
- Obsidian keys plugins by id in `.obsidian/plugins/<id>/`. **Two plugins with
  the same id fight over one folder.**
- The vault already had community plugin **"PiChat" by Geng (v0.2.8, id
  `pi-chat`)**. Our new plugin also used id `pi-chat`, so Geng's build kept
  overwriting ours (and vice versa).
- Symptom: the "wrong" plugin's UI and error messages appear; your files
  vanish from the folder.
- Fix: **rename the plugin id** (`manifest.json` id) to something unique, and
  deploy to `.obsidian/plugins/<new-id>/`. Ours: `pi-chat-local`.
- Always check what's already installed before picking an id:
  ```bash
  cat ~/work/hashicorp/obsidian-notes/.obsidian/community-plugins.json
  ```

### 2. Bundle export shape: `TypeError: h is not a constructor`
- Obsidian's loader does `new (mod.default ?? mod)()`.
- If your entry uses a **named** export (`export class X`), the bundle exports
  a namespace object, not the class → plugin fails to load with
  `TypeError: h is not a constructor` (minified).
- Fix: `export default class X extends Plugin` in the entry file. The
  obsidian-sample-plugin template does exactly this.

### 3. Exit code 127 when spawning a script: shebang PATH
- `pi` is a `#!/usr/bin/env node` script. Spawning it with a PATH that lacks
  `node`'s dir → the child exits **127** with stderr
  `env: node: No such file or directory`.
- The Obsidian GUI app's `process.env.PATH` is minimal
  (`/usr/bin:/bin:/usr/sbin:/sbin` + homebrew in this case). The login-shell
  capture (`$SHELL -lic '...'`) can time out/truncate, leaving a PATH without
  node.
- Fix pattern: resolve `pi` AND `node` in one login-shell call, always prepend
  `node`'s dir (and `/opt/homebrew/bin`, `/usr/local/bin`) to the child PATH.
- Verify in-app with the `spawnSync` eval above; status 0 + stdout = good,
  status 127 = PATH problem.

### 4. Git-backed vaults restore plugin files (obsidian-git)
- The vault is a git repo with obsidian-git auto-backup. `.obsidian/plugins/*`
  are **tracked**, so any commit/restore can overwrite a freshly deployed
  plugin build.
- Symptom: you copy main.js into the vault, then a "vault backup" commit later
  replaces it with the committed version.
- Check: `git -C <vault> log --oneline -3` and
  `git -C <vault> show HEAD:.obsidian/plugins/<id>/main.js | wc -c` vs your build.
- If this bites, either commit the new plugin files into the vault repo, or
  deploy to a folder the backup doesn't clobber.

### 5. Stale notices after disabling a plugin
- `obsidian plugin:disable` while a plugin has a Notice up can leave the
  `.notice` element stuck in the DOM (its dismiss timer dies with the plugin).
- It looks like a permanent error toast. Fix: remove it via eval
  ```bash
  obsidian eval 'code=(()=>{document.querySelectorAll(".notice").forEach(e=>e.remove());return "cleared";})()'
  ```
  or just restart Obsidian.

### 6. TUI-only pi extensions fire system notifications from the plugin
- pi extensions run in the plugin's subprocess **in RPC mode**. Any extension
  written for the terminal that assumes "no one is watching" will misbehave.
- Real case: `~/.pi/agent/extensions/tmux-notify.ts` posts a macOS
  notification on `agent_settled` ("pi / agent finished") to ping the user
  when they alt-tabbed away from tmux. In RPC mode there is no tmux, its
  "am I in view?" check always says no, so **every conversation finished with
  a system popup**.
- Fix: guard with `ctx.mode` — `if (ctx.mode !== "tui") return;`
  (`ExtensionMode = "tui" | "rpc" | "json" | "print"`, so RPC is skipped).
- Lesson: when a plugin embeds pi via RPC, audit user extensions for
  TUI-specific side effects (bell, osascript notifications, tmux/shell
  assumptions) and add mode guards.

## Handy one-liners

```bash
# which plugin is really loaded
obsidian eval 'code=JSON.stringify(window.app.plugins.plugins["pi-chat-local"].manifest)'

# list loaded plugins
obsidian eval 'code=Object.keys(window.app.plugins.plugins).join(", ")'

# in-app spawn check (status 127 = shebang/PATH issue)
obsidian eval 'code=(()=>{const{spawnSync}=require("child_process");const r=spawnSync("/Users/larry.song/.bun/bin/pi",["--mode","rpc","--no-session"],{cwd:"/tmp",env:{...process.env,PATH:"/Users/larry.song/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",PI_NO_STARTUP_LOGO:"1"},encoding:"utf8",timeout:8000,input:JSON.stringify({type:"get_state"})+"\n"});return JSON.stringify({status:r.status,stderr:r.stderr&&r.stderr.slice(0,150),head:r.stdout&&r.stdout.slice(0,80)});})()'

# new-chat command for a view plugin
obsidian eval 'code=app.commands.commands["pi-chat-local:pi-chat-new"].callback()'

# screenshot
obsidian dev:screenshot path=/tmp/foo.png
```
