# Inline edit + edit-diff — findings & plan (NOT STARTED)

Status: **investigation only** — nothing built yet. Pick up from here.

Goal (user-approved direction): two features, deliberately NOT the full
Claudian "inline edit with approval-gate diff" (pi's trust model is
agent-edits-directly, no approval gate):

1. **Selection-pinned prompt** (high ROI, cheap): select text in a note →
   hotkey → plugin pre-fills the pi-chat composer with the selection as
   context + a link to the note; user types "fix/rewrite/summarize…" and
   sends to the active conversation.
2. **Edit-diff visibility in the chat** (cheap-ish): render word-level
   old→new diffs for pi `edit` tool calls inside the existing collapsible
   tool row, so edits are visible *in the chat* even without a gate.

## Findings (verified this session)

### pi's edit tool schema — `dist/core/tools/edit.js`
- Tool name `edit`; `parameters: editSchema`; args validated by
  `validateEditInput(input)` → `{ path, edits }`.
- **`edits: [{ oldText, newText }]`** — multiple disjoint edits per call.
  Field names are `oldText`/`newText` (NOT snake_case).
- `allToolNames = ["read","bash","edit","write","grep","find","ls"]` (index.js).
- Also present: `edit-diff.js` (pi computes diffs itself for TUI display —
  check whether it exposes reusable logic/output before writing our own),
  `truncate.js` (large-arg truncation may affect what the plugin receives).

### Plugin touch points — `src/reducer.ts`, `src/pi-chat-view.ts`
- Reducer: `tool_execution_start` → `onToolStart(state, toolCallId, toolName, args)`
  (reducer.ts:307-309). `args` are available at tool start — capture
  `edits[]` there into the `ToolCallUi` row state.
- View: `renderToolCalls` (pi-chat-view.ts:637), `renderToolRow` (:652) —
  `call.name` in the row header; `statusTextFor` (:1110).

## Open questions to resolve when we come back
1. Does the RPC `tool_execution_start` event carry **full `args` including
   `edits[]`**, or truncated (see `truncate.js`)? Verify live with an edit
   and log the event payload.
2. Does `edit-diff.js` in pi export anything reusable? If it computes the
   same diff the TUI shows, mirror its algorithm (or reuse the output).
3. Default hotkey for the selection command (avoid Obsidian collisions;
   `editor-menu` right-click entry is the discoverable path regardless).
4. Which conversation receives a selection when no pi-chat leaf exists —
   create one (mirror `openNewChat` behavior in main.ts).

## Design notes (agreed in conversation)
- Keep the trust model: no accept/reject gate. Diff rows are visibility only.
- Selection context format should keep content byte-exact (fenced block, not
  `>` quotes, so code selections survive).
- Word-level diff via a small LCS (no new dependency) is fine; render old
  words struck-through/red, new words green, inside the tool row.
- Add a unit test for the diff function (test suite is at 42).

## Logged elsewhere
- gstack learning: pi-rpc-client-extensions (this session).
