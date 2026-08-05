# Pi Chat

Chat with your **local [Pi coding agent](https://github.com/earendil-works/pi-mono)** inside Obsidian.

Pi Chat is a thin shell over your real `pi` binary. It spawns `pi --mode rpc` per conversation, so your `~/.pi` providers, auth, models, extensions, skills, and sessions all work exactly as they do in the terminal.

> **Zero configuration.** No bundled runtime, no API keys in the plugin, no plugin-side model config. If `pi` works in your terminal, it works here.

![Pi Chat panel](docs/screenshot.png)

## Features

- **Streamed markdown replies** with visible, collapsible tool-call rows
- **Thinking blocks** — collapsed by default, expandable
- **Conversations, plugin-owned**: start empty; create, rename, switch and delete conversations in the pane. Each conversation contains a Pi session once you chat in it
- **Slash commands** — type `/` in the composer to pick from all of Pi's skills, templates and extension commands (plus `/reload`); `/clear`, `/fork` etc. work and the pane reconciles to the server state
- **`@`-mentions** — type `@` in the composer to pick a vault note by file name; mentions resolve to the exact vault path and Pi reads the file with its own tools (no content dumping — that's only the explicit “Ask Pi about this note” flow)
- **Image paste** — paste up to 4 images per message (thumbnails preview, sent as image content)
- **Stop / Esc abort** — visible Stop button while the agent runs; Escape aborts the turn
- **In-chat model switcher and thinking-level switcher** sourced from Pi's own catalogue
- **Pi extensions work as-is** — extension `select`/`confirm`/`input`/`editor` dialogs render inline in the chat; `notify` maps to an Obsidian Notice
- **Vault-aware tools** — `edit`/`write` tool rows link to the note, so Obsidian's native change detection refreshes edited files; edit calls show a word-level **old→new diff** inside the tool row (red struck / green)
- **Ask Pi about the selection** — select text in any note, hit `Mod+Shift+E` (or right-click → *Ask Pi about selection*): the selection lands byte-exact in the composer with a note link, ready for "fix / rewrite / summarise"
- **Ask Pi about a note** — right-click any note in the file explorer (or its tab header) → *Ask Pi about this note*: the note's content becomes part of the composer context (fenced, 8k cap with a read-the-rest hint)
- **One pane, many conversations** — the bottom-right picker switches the pane between conversations in place

## Requirements

- **Desktop** Obsidian (1.12+)
- A working local [Pi](https://github.com/earendil-works/pi-mono) installation (the `pi` command resolves from your login shell)

## Installation

1. **Community plugins**: search for "Pi Chat" → Install → Enable. *(Available after community review.)*
2. **BRAT** (early access): add `https://github.com/songlining/obsidian-pi-chat` via the BRAT plugin.
3. **Manual**: copy `main.js`, `manifest.json`, `styles.css` from the latest [release](https://github.com/songlining/obsidian-pi-chat/releases) into `<vault>/.obsidian/plugins/pi-chat-local/`.

Open a conversation via the **bot ribbon icon** or the command palette:

- `Pi Chat: New conversation`
- `Pi Chat: New conversation` (also the sidebar ribbon icon)

## How it works

```
Obsidian (renderer)
 └─ PiChatView (one workspace leaf per conversation)
     └─ PiSession
         └─ child_process.spawn(<pi>, ["--mode","rpc", ...], { cwd: vault root })
              stdin  ← JSONL commands (prompt, abort, set_model, …)
              stdout → JSONL events (message_update, tool_execution_*, …)
```

- **One `pi --mode rpc` subprocess per open conversation**, with `cwd = vault root` so relative tool paths resolve inside the vault.
- **Binary discovery, zero-config**: resolved once via your login shell (`$SHELL -lic 'which pi'`). A manual path override exists in settings for unusual installs.
- **Vault context is established automatically**: the subprocess runs with `cwd = vault root`, so pi loads the vault's `AGENTS.md`/`CLAUDE.md` context files, and the plugin appends the vault's `CLAUDE.md` explicitly when `AGENTS.md` would shadow it (pi loads one context file per directory, preferring `AGENTS.md`).
- **Environment inheritance**: the subprocess gets your full login-shell environment, so `~/.pi` auth and `PI_*` variables behave exactly like in the terminal. **The plugin never stores or requests API keys.**
- **Conversations are the plugin's; sessions are Pi's**: the plugin keeps a small registry of conversations in `data.json` (starting empty). Each conversation *contains* a Pi session (`~/.pi/agent/sessions/…`) once you've chatted in it; deleting a conversation removes its session file too.

## Companion pi extensions

A few Pi Chat features are powered by small extensions in `~/.pi/agent/extensions/` (the same mechanism Pi's TUI uses — no plugin-side code):

| File | Command | Purpose |
|---|---|---|
| `clear-context.ts` | `/clear` | Reset Pi's active context to the root of the session tree; the pane reconciles to the cleared state |
| `reload-context.ts` | `/reload` | Reload extensions, skills, prompts, themes and session state from disk (TUI's built-in `/reload` made RPC-callable) |

If an extension is missing, the command falls back gracefully (e.g. `/reload` without the extension still re-syncs the pane with Pi's persisted session state). The slash picker (`/`) shows what's actually available on your machine.

## Settings

Three fields, nothing more:

| Setting | Purpose |
|---|---|
| Pi binary path | Manual override (default: auto-detect via login shell) |
| Extra CLI args | Escape hatch, appended to `pi --mode rpc …` |
| HTML export folder | Vault-relative folder for exported sessions |

Everything else lives in `~/.pi` by design.

See **[CHANGELOG.md](CHANGELOG.md)** for the full history.

## Privacy

- All model traffic goes directly from the local `pi` process to your configured provider, using **your** credentials from `~/.pi`.
- The plugin stores no API keys and no analytics. Plugin `data.json` holds UI preferences plus the conversation registry (ids, names, session pointers) — nothing else.
- Tools run with no approval gate and full filesystem access to the vault (the same trust model as running `pi` in a terminal pointed at the vault).

## Troubleshooting

- **"Pi binary not found"**: the panel shows a setup notice with a link to settings. Either install `pi` (e.g. `curl -fsSL https://bun.sh/install | bash && bun add -g @earendil-works/pi-coding-agent`), or set the path manually.
- **Session errors / provider errors** appear as red rows; **process death** shows the last stderr with a Retry button that restarts on the same session.
- See [docs/obsidian-cli-plugin-debugging.md](docs/obsidian-cli-plugin-debugging.md) for debugging an embedded plugin with the `obsidian` CLI.

## Development

```bash
npm install
npm run build        # type-check + esbuild -> main.js (+ versions.json etc.)
npm test             # unit tests (vitest)
npm run test:integration   # drives a real local pi --mode rpc and asserts the event flow
```

The CI release workflow builds and attaches `main.js`, `manifest.json`, `styles.css` to a GitHub release on tag push.

## Not the same as …

- **[PiChat](https://github.com/gengyabc/obsidian-pi-plugin)** by Geng — a similar idea that requires manual pi/node path configuration. Pi Chat is zero-config: it auto-detects the binary and environment, so it works the moment you enable it.
- **Pivi** — bundles its own pi-ai runtime and requires plugin-side setup. Pi Chat reuses your existing local installation.

## License

MIT
