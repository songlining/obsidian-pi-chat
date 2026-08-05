# Changelog

All notable changes to **Pi Chat** (`pi-chat-local`) are documented here.

## [1.1.0] — Conversations

The headline change: **conversations are plugin-owned**. The registry starts empty; you create, rename, switch and delete conversations in the pane. A conversation *contains* a Pi session — the two are no longer conflated. Sessions stay Pi's (`~/.pi/agent/sessions/…`); the plugin stores only its conversation registry.

### Added

- **Conversations model** — plugin-owned registry in `data.json` (starts empty); create / rename / switch / delete in the pane; deleting a conversation also removes its Pi session file.
- **One-pane architecture** — the single Pi Chat leaf shows one conversation at a time, switched in place (like Claudian). Opening a new conversation switches the active pane instead of stacking leaves.
- **In-pane conversation switching** — bottom-right picker lists conversations (current checked), plus *New conversation* and *Delete this conversation…*. Each entry has a tiny always-visible **✕** for one-click delete.
- **Inline rename box** — always-visible at the bottom-left, on the same row as the pickers; the conversation record name is the single source of truth for every label (picker, leaf title, header, rename box).
- **Restart hygiene** — restoring with no conversation id reuses the most recent conversation; stale/deleted ids stay on the current binding and never resurrect.
- **Slash-command picker** — typing `/` in the composer lists all of Pi's skills (`/skill:*`), templates (`/template:*`) and extension commands; `/reload` is plugin-provided.
- **Image paste** — paste up to 4 images; thumbnails preview above the composer, sent as image content to Pi.
- **Stop / Escape abort** — a visible **Stop** button (tooltip “Abort (Esc)”) appears next to Send while the agent is running; Escape aborts. The Send button never relabels.
- **Composer styling** — neutral gray input (was theme-tinted cream), `bot-message-square` icon (was identical to another plugin's).

### Fixed

- **Two Stop buttons during a run** — legacy code relabeled the Send button to “Stop”; removed the dead toggle so only the dedicated Stop button appears.
- **Pane ignored `/clear`** — Pi's clear-context extension resets the session tree server-side but emits no RPC events, so the pane kept stale messages. The plugin now re-fetches after slash commands that don't start an agent run; `/clear` visibly empties the pane.
- **`set_editor_text` leaked into the composer** — Pi's “fill the TUI editor” mechanism (used by `/skill:bookmark` etc.) was dumping expanded skill text into the input; now ignored.
- **Deleted conversations resurrected on restore** — stale view-state ids now rewrite to the current binding instead of spawning a ghost conversation.

### Companion tooling

- **`pi-vision` default engine → `mate-super`** (`~/.pi/bin/pi-vision`, `SKILL.md` updated): the previous Gemini free-tier default was hitting rate limits (HTTP 429). Default is now UncleMT `mate-super` (env override `PI_VISION_MODEL` preserved); Gemini remains available via `--model gemini-3.6-flash`.
- **`reload-context` extension** (`~/.pi/agent/extensions/reload-context.ts`): registers `/reload` for RPC clients, mirroring the TUI's built-in (reloads extensions, skills, prompts, themes, session from disk). Pi has no RPC wire command for reload, so the plugin runs this extension via a prompt; if it's absent the plugin falls back to re-syncing the pane.

## [1.0.0] — Initial release

Zero-config chat panel embedding the user's local Pi coding agent.

### Added

- **Zero configuration** — spawns `pi --mode rpc` per conversation; binary auto-detected from your login shell (manual override in settings); full `~/.pi` env/auth/model/config reuse. No bundled runtime, no API keys, no plugin-side model config.
- **Streamed markdown replies** — rendered with Obsidian's markdown renderer (throttled while streaming), with visible collapsible tool-call rows and collapsed-by-default thinking blocks.
- **In-chat model switcher and thinking-level switcher** sourced from Pi's own catalogue.
- **Pi extensions work as-is** — `select`/`confirm`/`input`/`editor` dialogs render inline in the chat; `notify` maps to an Obsidian Notice.
- **Vault-aware tools** — `edit`/`write` tool rows link to the note; vault context established automatically (`AGENTS.md`/`CLAUDE.md`), with explicit `CLAUDE.md` appending when `AGENTS.md` shadows it.
- **Session tools** — rename session, HTML export, session picker.
- **Community packaging** — unique plugin id `pi-chat-local`, 42 unit tests, integration test driving a real `pi --mode rpc`, CI release workflow attaching `main.js`/`manifest.json`/`styles.css` to GitHub releases.

[1.1.0]: https://github.com/songlining/obsidian-pi-chat/releases/tag/1.1.0
[1.0.0]: https://github.com/songlining/obsidian-pi-chat/releases/tag/1.0.0
