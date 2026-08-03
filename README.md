# Pi Chat — Obsidian plugin

A Claudian-style chat panel for the [Pi coding agent](https://github.com/earendil-works/pi-mono) inside your Obsidian vault.

**The defining constraint: zero extra configuration.** The plugin is a thin shell over your real local `pi` binary (`pi --mode rpc`). No bundled runtime, no API keys, no plugin-side model config. Your `~/.pi` providers, auth, models, extensions, skills and sessions all work exactly as in the terminal.

## How it works

```
Obsidian (renderer)
 └─ PiChatView (one workspace leaf per conversation)
     └─ PiSession
         └─ child_process.spawn(<pi-path>, ["--mode","rpc", ...], { cwd: vaultRoot })
              stdin  ← JSONL commands (prompt, abort, set_model, …)
              stdout → JSONL events (message_update, tool_execution_*, …)
```

- **One `pi --mode rpc` subprocess per open conversation**, spawned with `cwd = vault root` so relative tool paths resolve inside the vault.
- **Binary discovery, zero-config:** resolved once via your login shell (`$SHELL -lic 'which pi'`), because the GUI app's PATH lacks `~/.bun/bin`. A manual override exists in settings.
- **Environment inheritance:** the subprocess gets the full login-shell environment, so `~/.pi` auth and `PI_*` variables behave like in the terminal. The plugin never stores API keys.
- **Sessions are Pi's, not the plugin's:** resume lists this vault's sessions directly from `~/.pi/agent/sessions/--<encoded-cwd>--/`. Terminal-created sessions appear and can be resumed inside Obsidian, and vice-versa.
- **Strict JSONL framing:** split on `\n` only (never Node `readline`, which also splits on U+2028/U+2029).

## Features (v1)

- Streamed markdown replies (throttled re-render) with visible, collapsible tool-call rows
- Thinking blocks (collapsed, expandable)
- Session management: new chat, resume (fuzzy modal over this vault's Pi sessions), continue-latest, rename, export HTML, session stats
- In-chat model switcher and thinking-level switcher sourced from Pi's own catalogue (`get_available_models` / `get_available_thinking_levels`)
- Pi extension UI dialogs (`select` / `confirm` / `input` / `editor`) rendered inline; `notify` maps to an Obsidian Notice; installed Pi extensions stay fully functional
- `edit`/`write` tool rows link to the vault note so Obsidian's native change detection refreshes it
- Error handling: binary-not-found setup notice, process-death Retry (re-spawns with the same `--session <id>`), malformed RPC lines skipped, unknown event types ignored

## Development

```bash
npm install
npm run build        # type-check + esbuild -> main.js, copies into the vault plugin dir
npm run dev          # watch mode (esbuild)
npm test             # unit tests (vitest)
npm run test:integration   # spawns the real local pi and asserts the RPC event flow
npm run copy         # copy built files into the vault (default: ~/work/hashicorp/obsidian-notes)
```

The build copies `main.js`, `manifest.json`, `styles.css` into
`<vault>/.obsidian/plugins/pi-chat/` for live testing.

## Manual smoke checklist

- [ ] New chat (ribbon icon / command) opens a leaf and streams a reply
- [ ] Resume a terminal-created session from the fuzzy modal
- [ ] Continue-last resumes the newest session
- [ ] Model switch and thinking-level switch update the header chips
- [ ] Abort mid-stream stops the run
- [ ] An extension dialog renders inline and its answer is delivered to the extension
- [ ] Kill the pi process; the Retry button restarts on the same session
- [ ] Export HTML writes a file; Session info shows stats

## Reference

- [Pi RPC protocol](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) — local copy at `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- [Session format](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)
