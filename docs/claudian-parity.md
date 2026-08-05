# Claudian feature parity (end-user UX)

Assessment date: 2026-08-04, against [Claudian](https://github.com/YishenTu/claudian)'s
README feature list at that date. Snapshot for product decisions — re-check if
Claudian's feature set changes.

## In parity ✅

| Capability | Claudian | Pi Chat |
|---|---|---|
| Chat panel (ribbon + command palette) | ✅ | ✅ |
| Streamed responses, markdown, thinking blocks | ✅ | ✅ |
| Tool-call visibility | ✅ | ✅ (collapsible rows) |
| Conversations / multi-tab | ✅ | ✅ (plugin-owned, one-pane) |
| Slash commands + skills (`/` picker) | ✅ (`/` or `$`) | ✅ (`/` picker, incl. extensions) |
| Image / file attachment | ✅ | ✅ (paste, ≤4 thumbnails) |
| Stop / abort | ✅ | ✅ (Stop btn + Esc) |
| Fork / resume / history | ✅ | ✅ (fork via extension; history via conversation picker) |
| MCP servers | ✅ | ✅ *inherited* from `~/.pi` (zero-config, no in-app UI) |
| Model switching | per-harness config | ✅ in-chat, plus thinking levels |

## Gaps vs Claudian ❌

1. **Inline Edit with word-level diff preview** — Claudian's headline feature. Select text + hotkey → edit in the note with a diff. Pi has no TUI equivalent; this would be plugin-built (and it's the biggest piece of work). See [inline-edit-diff-notes.md](inline-edit-diff-notes.md) for the findings/plan.
2. **`@`-mentions** — reference vault files, subagents, MCP servers from the composer. We have nothing; medium effort (vault fuzzy-search + path insertion + prompt injection).
3. **Plan mode (Shift+Tab)** — explore-first, plan approval gate. Neither pi nor the plugin has it.
4. **Instruction mode (`#`)** — per-chat custom instructions. Pi's context comes from vault `AGENTS.md`/`CLAUDE.md` only.
5. **Manual compact** — pi auto-compacts; no user-facing control.

## Where we're actually ahead (for our use case)

- **Zero-config** — Claudian's own README spends a big section on CLI auto-detect failures (nvm/fnm/volta PATH hell). That's our entire design point.
- **In-chat model + thinking switcher**, **extension dialogs rendered inline** (Claudian shells out to harness CLIs), **HTML export**, **automatic vault context** (`AGENTS.md`/`CLAUDE.md`).

## Verdict

**Core chat experience: yes, rough parity.** What Claudian has that we don't is the Claude-Code-style *editing* layer (inline diff, `@`, plan mode) — and notably, pi's own TUI doesn't have those either, so it's not a "Pi vs Claude" gap, it's plugin-side work.

Suggested gap-closing order: **`@`-mention** (highest value/effort ratio, pure plugin feature) → **inline edit + diff** (big, but it's the differentiator) → plan mode / `#` instructions (would need pi-side support or prompt-level shims).
