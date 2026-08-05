/**
 * Pure event -> UI-state reducer for a Pi chat conversation.
 *
 * Decoupled from the DOM so it can be unit-tested in isolation. The view
 * subscribes to the resulting state and diffs its DOM against it.
 */
import type {
  AgentMessage,
  AssistantMessage,
  ExtensionUiRequest,
  ImageContent,
  Model,
  RpcEvent,
  SessionStateData,
  SessionStatsData,
  ThinkingLevel,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "./types";

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

export interface ToolCallUi {
  id: string;
  name: string;
  /** Pretty JSON of the tool arguments. */
  args: string;
  /** One-line summary of args (command / path / query). */
  argsSummary: string;
  status: "pending" | "running" | "success" | "error";
  /** Accumulated partial output while running. */
  output: string;
  /** Final result text (set on tool_execution_end). */
  result: string;
  isError: boolean;
  /** For edit tool calls: old → new text pairs, captured from args. */
  edits?: EditDiff[];
}

export interface EditDiff {
  oldText: string;
  newText: string;
}

export interface UiMessage {
  /** Stable unique key within the session. */
  key: string;
  kind: "user" | "assistant" | "tool" | "system" | "error";
  /** Markdown text for user/assistant; plain text for others. */
  text: string;
  /** Accumulated thinking text (assistant messages). */
  thinking?: string;
  /** Pasted image attachments (user messages). */
  images?: ImageContent[];
  streaming?: boolean;
  /** Optimistic user message that pi has not yet confirmed. */
  pending?: boolean;
  timestamp?: number;
  model?: string;
  provider?: string;
  stopReason?: string;
  toolCalls?: ToolCallUi[];
  customType?: string;
}

export type Phase = "spawning" | "ready" | "error" | "exited";

export interface UiState {
  phase: Phase;
  messages: UiMessage[];
  isRunning: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  pendingQueue: number;
  model: Model | null;
  thinkingLevel: ThinkingLevel | null;
  sessionName: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  availableModels: Model[];
  availableThinkingLevels: ThinkingLevel[];
  sessionStats: SessionStatsData | null;
  /** Pending extension dialogs (select/confirm/input/editor). */
  extensionRequests: ExtensionUiRequest[];
  autoRetry: { attempt: number; maxAttempts: number; errorMessage: string } | null;
  /** Fatal error shown as a red system row. */
  error: string | null;
  /** Recent stderr lines (last 30) for diagnostics. */
  stderr: string[];
  /** Monotonic key counter. */
  seq: number;
}

export function initialState(): UiState {
  return {
    phase: "spawning",
    messages: [],
    isRunning: false,
    isStreaming: false,
    isCompacting: false,
    pendingQueue: 0,
    model: null,
    thinkingLevel: null,
    sessionName: null,
    sessionId: null,
    sessionFile: null,
    availableModels: [],
    availableThinkingLevels: [],
    sessionStats: null,
    extensionRequests: [],
    autoRetry: null,
    error: null,
    stderr: [],
    seq: 0,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { type: "rpc"; event: RpcEvent }
  | { type: "user_message"; text: string; images?: ImageContent[] }
  | { type: "session_ready"; data: SessionStateData }
  | { type: "models_available"; models: Model[] }
  | { type: "thinking_levels_available"; levels: ThinkingLevel[] }
  | { type: "model_changed"; model: Model }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "session_name_changed"; name: string }
  | { type: "session_stats"; stats: SessionStatsData }
  | { type: "export_done"; path: string }
  | { type: "history_loaded"; messages: AgentMessage[] }
  | { type: "session_error"; message: string; stderr: string[] }
  | { type: "session_exited"; code: number | null; signal: string | null; stderr: string[] }
  | { type: "extension_ui_answered"; id: string }
  | { type: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "set_status"; key: string; text?: string }
  | { type: "set_title"; title: string }
  | { type: "set_editor_text"; text: string }
  | { type: "clear_error" };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function toolArgsSummary(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.query === "string") return args.query;
  if (typeof args.url === "string") return args.url;
  if (typeof args.prompt === "string") return args.prompt.slice(0, 120);
  if (typeof args.message === "string") return args.message.slice(0, 120);
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .slice(0, 4)
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`)
    .join(" ");
}

function stringifyArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/**
 * For `edit` tool calls, extract the old → new text pairs from args so the
 * chat can render word-level diffs. pi's edit tool args are
 * `{ path, edits: [{ oldText, newText }] }`.
 */
function extractEditDiffs(
  name: string,
  args: Record<string, unknown> | undefined,
): EditDiff[] | undefined {
  if (name !== "edit" || !args) return undefined;
  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const out = edits.filter(
    (e): e is EditDiff =>
      !!e && typeof (e as EditDiff).oldText === "string" && typeof (e as EditDiff).newText === "string",
  );
  return out.length > 0 ? out : undefined;
}

export function contentBlocksToParts(content: AssistantMessage["content"]) {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: ToolCallContent[] = [];
  for (const block of content) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "thinking") thinkingParts.push(block.thinking);
    else if (block.type === "toolCall") toolCalls.push(block);
  }
  return { text: textParts.join("\n\n"), thinking: thinkingParts.join("\n"), toolCalls };
}

function userText(msg: UserMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function userImages(msg: UserMessage): ImageContent[] | undefined {
  if (typeof msg.content === "string") return undefined;
  const images = msg.content.filter((b): b is ImageContent => b.type === "image");
  return images.length > 0 ? images : undefined;
}

function isDialogRequest(req: ExtensionUiRequest): boolean {
  return (
    req.method === "select" ||
    req.method === "confirm" ||
    req.method === "input" ||
    req.method === "editor"
  );
}

function toolResultText(tr: ToolResultMessage): string {
  return tr.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function reduce(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "rpc":
      return reduceRpc(state, action.event);
    case "user_message":
      return {
        ...state,
        seq: state.seq + 1,
        messages: [
          ...state.messages,
          {
            key: `u${state.seq + 1}`,
            kind: "user",
            text: action.text,
            images: action.images,
            pending: true,
            timestamp: Date.now(),
          },
        ],
      };
    case "session_ready":
      return {
        ...state,
        phase: "ready",
        model: action.data.model,
        thinkingLevel: action.data.thinkingLevel,
        sessionName: action.data.sessionName ?? null,
        sessionId: action.data.sessionId ?? null,
        sessionFile: action.data.sessionFile ?? null,
        pendingQueue: action.data.pendingMessageCount,
      };
    case "models_available":
      return { ...state, availableModels: action.models };
    case "thinking_levels_available":
      return { ...state, availableThinkingLevels: action.levels };
    case "model_changed":
      return { ...state, model: action.model };
    case "thinking_level_changed":
      return { ...state, thinkingLevel: action.level };
    case "session_name_changed":
      return { ...state, sessionName: action.name };
    case "session_stats":
      return { ...state, sessionStats: action.stats };
    case "export_done":
      return { ...state, error: null, stderr: [...state.stderr, `Exported to ${action.path}`] };
    case "history_loaded":
      return { ...state, messages: messagesToUi(action.messages) };
    case "session_error":
      return { ...state, phase: "error", error: action.message, stderr: action.stderr.slice(-30) };
    case "session_exited":
      return {
        ...state,
        phase: "exited",
        error: `Pi process exited${action.code !== null ? ` with code ${action.code}` : ""}${action.signal ? ` (${action.signal})` : ""}.`,
        stderr: action.stderr.slice(-30),
      };
    case "extension_ui_answered":
      return {
        ...state,
        extensionRequests: state.extensionRequests.filter((r) => r.id !== action.id),
      };
    case "notify":
      // Fired as a side effect by the view; state unchanged.
      return state;
    case "set_status":
    case "set_title":
    case "set_editor_text":
      return state;
    case "clear_error":
      return { ...state, error: null, phase: "ready" };
    default:
      return state;
  }
}

function reduceRpc(state: UiState, event: RpcEvent): UiState {
  switch (event.type) {
    case "agent_start":
      return { ...state, isRunning: true, isStreaming: false };
    case "agent_end":
      return { ...state, isRunning: event.willRetry };
    case "agent_settled":
      return { ...state, isRunning: false, isStreaming: false };
    case "turn_start":
      return { ...state, isRunning: true };
    case "turn_end":
      return { ...state, isRunning: true };
    case "message_start":
      return onMessageStart(state, event.message);
    case "message_update":
      return onMessageUpdate(state, event.message);
    case "message_end":
      return onMessageEnd(state, event.message);
    case "tool_execution_start":
      return onToolStart(state, event.toolCallId, event.toolName, event.args);
    case "tool_execution_update":
      return onToolUpdate(state, event.toolCallId, event.partialResult);
    case "tool_execution_end":
      return onToolEnd(state, event.toolCallId, event.result, event.isError);
    case "bash_execution_update":
      return onBashUpdate(state, event.id, event.delta);
    case "queue_update":
      return { ...state, pendingQueue: event.steering.length + event.followUp.length };
    case "compaction_start":
      return { ...state, isCompacting: true };
    case "compaction_end":
      return { ...state, isCompacting: false };
    case "auto_retry_start":
      return {
        ...state,
        autoRetry: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          errorMessage: event.errorMessage,
        },
      };
    case "auto_retry_end":
      return { ...state, autoRetry: null };
    case "extension_error":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            key: `err${state.seq + 1}`,
            kind: "error",
            text: `Extension error (${event.event}): ${event.error}`,
            customType: event.extensionPath,
          },
        ],
        seq: state.seq + 1,
      };
    case "extension_ui_request":
      // Only dialog methods (select/confirm/input/editor) block for a response;
      // fire-and-forget requests (notify/setStatus/...) are routed by the
      // Conversation layer and must not appear as pending dialogs.
      if (isDialogRequest(event)) {
        return { ...state, extensionRequests: [...state.extensionRequests, event] };
      }
      return state;
    default:
      return state;
  }
}

function onMessageStart(state: UiState, message: AgentMessage): UiState {
  if (message.role === "user") {
    const text = userText(message);
    const last = state.messages[state.messages.length - 1];
    // Replace the optimistic pending bubble if it matches.
    if (last && last.kind === "user" && last.pending && last.text.trim() === text.trim()) {
      const updated = [...state.messages];
      updated[updated.length - 1] = {
        ...last,
        pending: false,
        timestamp: message.timestamp,
        key: `u${state.seq + 1}`,
      };
      return { ...state, seq: state.seq + 1, messages: updated };
    }
    return {
      ...state,
      seq: state.seq + 1,
      messages: [
        ...state.messages,
        { key: `u${state.seq + 1}`, kind: "user", text, timestamp: message.timestamp },
      ],
    };
  }

  if (message.role === "assistant") {
    return {
      ...state,
      seq: state.seq + 1,
      messages: [
        ...state.messages,
        {
          key: `a${state.seq + 1}`,
          kind: "assistant",
          text: "",
          thinking: "",
          streaming: true,
          model: message.model,
          provider: message.provider,
          timestamp: message.timestamp,
        },
      ],
    };
  }

  return state;
}

function onMessageUpdate(state: UiState, message: AssistantMessage): UiState {
  const { text, thinking, toolCalls } = contentBlocksToParts(message.content);
  const idx = state.messages.length - 1;
  const last = state.messages[idx];
  if (idx < 0 || !last || last.kind !== "assistant") {
    // Streaming text arrived with no assistant bubble (edge case) — append one.
    return {
      ...state,
      seq: state.seq + 1,
      messages: [
        ...state.messages,
        {
          key: `a${state.seq + 1}`,
          kind: "assistant",
          text,
          thinking: thinking || undefined,
          streaming: true,
          model: message.model,
          provider: message.provider,
          timestamp: message.timestamp,
          toolCalls: toolCalls.map((tc) => toolCallFromContent(tc)),
        },
      ],
      isStreaming: true,
    };
  }

  const existing = last.toolCalls ?? [];
  // Merge: keep execution status of known calls, refresh args from content.
  const merged = toolCalls.map((tc) => {
    const prev = existing.find((e) => e.id === tc.id);
    return {
      ...toolCallFromContent(tc),
      status: prev?.status ?? "pending",
      output: prev?.output ?? "",
      result: prev?.result ?? "",
      isError: prev?.isError ?? false,
    };
  });
  const updated: UiMessage = {
    ...last,
    text,
    thinking: thinking || undefined,
    streaming: true,
    toolCalls: merged,
    model: message.model ?? last.model,
    provider: message.provider ?? last.provider,
  };
  const messages = [...state.messages];
  messages[idx] = updated;
  return { ...state, messages, isStreaming: true };
}

function onMessageEnd(state: UiState, message: AgentMessage): UiState {
  if (message.role === "user") return state;
  if (message.role === "assistant") {
    const idx = state.messages.length - 1;
    const last = state.messages[idx];
    if (idx < 0 || !last || last.kind !== "assistant") {
      // No streaming bubble (e.g. history-style complete message). Append it.
      const { text, thinking, toolCalls } = contentBlocksToParts(message.content);
      return {
        ...state,
        seq: state.seq + 1,
        messages: [
          ...state.messages,
          {
            key: `a${state.seq + 1}`,
            kind: "assistant",
            text,
            thinking: thinking || undefined,
            streaming: false,
            stopReason: message.stopReason,
            model: message.model,
            provider: message.provider,
            timestamp: message.timestamp,
            toolCalls: toolCalls.map((tc) => toolCallFromContent(tc)),
          },
        ],
        isStreaming: false,
      };
    }
    const { text, thinking, toolCalls } = contentBlocksToParts(message.content);
    const existing = last.toolCalls ?? [];
    const merged = toolCalls.map((tc) => {
      const prev = existing.find((e) => e.id === tc.id);
      return {
        ...toolCallFromContent(tc),
        status: prev?.status ?? "pending",
        output: prev?.output ?? "",
        result: prev?.result ?? "",
        isError: prev?.isError ?? false,
      };
    });
    const messages = [...state.messages];
    messages[idx] = {
      ...last,
      text,
      thinking: thinking || undefined,
      streaming: false,
      toolCalls: merged,
      stopReason: message.stopReason,
      model: message.model ?? last.model,
      provider: message.provider ?? last.provider,
    };
    return { ...state, messages, isStreaming: false };
  }
  return state;
}

function toolCallFromContent(tc: ToolCallContent): ToolCallUi {
  const args = tc.arguments ?? {};
  return {
    id: tc.id,
    name: tc.name,
    args: stringifyArgs(args),
    argsSummary: toolArgsSummary(tc.name, args),
    edits: extractEditDiffs(tc.name, args),
    status: "pending",
    output: "",
    result: "",
    isError: false,
  };
}

/** Find the assistant message (searching backwards) that owns a tool call id. */
function findToolCallOwner(
  state: UiState,
  toolCallId: string,
): { msgIdx: number; callIdx: number } | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    const calls = msg.toolCalls ?? [];
    const callIdx = calls.findIndex((c) => c.id === toolCallId);
    if (callIdx >= 0) return { msgIdx: i, callIdx };
  }
  return null;
}

function onToolStart(
  state: UiState,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): UiState {
  const owner = findToolCallOwner(state, toolCallId);
  const messages = [...state.messages];
  if (owner) {
    const msg = { ...messages[owner.msgIdx] };
    const calls = [...(msg.toolCalls ?? [])];
    calls[owner.callIdx] = {
      ...calls[owner.callIdx],
      name: toolName,
      args: stringifyArgs(args),
      argsSummary: toolArgsSummary(toolName, args),
      edits: extractEditDiffs(toolName, args),
      status: "running",
    };
    msg.toolCalls = calls;
    messages[owner.msgIdx] = msg;
    return { ...state, messages };
  }
  // Standalone tool bubble (e.g. tool call without a preceding assistant msg).
  messages.push({
    key: `t${state.seq + 1}`,
    kind: "tool",
    text: "",
    toolCalls: [
      {
        id: toolCallId,
        name: toolName,
        args: stringifyArgs(args),
        argsSummary: toolArgsSummary(toolName, args),
        edits: extractEditDiffs(toolName, args),
        status: "running",
        output: "",
        result: "",
        isError: false,
      },
    ],
  });
  return { ...state, seq: state.seq + 1, messages };
}

function onToolUpdate(
  state: UiState,
  toolCallId: string,
  partialResult: { content: { type: string; text?: string }[] },
): UiState {
  const owner = findToolCallOwner(state, toolCallId);
  if (!owner) return state;
  const messages = [...state.messages];
  const msg = { ...messages[owner.msgIdx] };
  const calls = [...(msg.toolCalls ?? [])];
  const call = { ...calls[owner.callIdx] };
  const text = partialResult.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  call.output = call.output + text;
  call.status = "running";
  calls[owner.callIdx] = call;
  msg.toolCalls = calls;
  messages[owner.msgIdx] = msg;
  return { ...state, messages };
}

function onToolEnd(
  state: UiState,
  toolCallId: string,
  result: { content: { type: string; text?: string }[] },
  isError: boolean,
): UiState {
  const owner = findToolCallOwner(state, toolCallId);
  if (!owner) return state;
  const messages = [...state.messages];
  const msg = { ...messages[owner.msgIdx] };
  const calls = [...(msg.toolCalls ?? [])];
  const call = { ...calls[owner.callIdx] };
  call.result = result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  call.status = isError ? "error" : "success";
  call.isError = isError;
  calls[owner.callIdx] = call;
  msg.toolCalls = calls;
  messages[owner.msgIdx] = msg;
  return { ...state, messages };
}

function onBashUpdate(state: UiState, id: string, delta: string): UiState {
  const owner = findToolCallOwner(state, id);
  const messages = [...state.messages];
  if (owner) {
    const msg = { ...messages[owner.msgIdx] };
    const calls = [...(msg.toolCalls ?? [])];
    const call = { ...calls[owner.callIdx] };
    call.output = call.output + delta;
    call.status = "running";
    calls[owner.callIdx] = call;
    msg.toolCalls = calls;
    messages[owner.msgIdx] = msg;
    return { ...state, messages };
  }
  messages.push({
    key: `t${state.seq + 1}`,
    kind: "tool",
    text: "",
    toolCalls: [
      {
        id,
        name: "bash",
        args: "",
        argsSummary: "",
        status: "running",
        output: delta,
        result: "",
        isError: false,
      },
    ],
  });
  return { ...state, seq: state.seq + 1, messages };
}

// ---------------------------------------------------------------------------
// History mapping (resume)
// ---------------------------------------------------------------------------

export function messagesToUi(messages: AgentMessage[]): UiMessage[] {
  const out: UiMessage[] = [];
  let seq = 0;

  const attachResult = (toolCallId: string, text: string, isError: boolean) => {
    for (let i = out.length - 1; i >= 0; i--) {
      const msg = out[i];
      const calls = msg.toolCalls ?? [];
      const callIdx = calls.findIndex((c) => c.id === toolCallId);
      if (callIdx >= 0) {
        const calls2 = [...calls];
        calls2[callIdx] = {
          ...calls2[callIdx],
          result: text,
          status: isError ? "error" : "success",
          isError,
        };
        msg.toolCalls = calls2;
        return;
      }
    }
  };

  for (const m of messages) {
    switch (m.role) {
      case "user": {
        seq++;
        out.push({ key: `h${seq}`, kind: "user", text: userText(m), images: userImages(m), timestamp: m.timestamp });
        break;
      }
      case "assistant": {
        seq++;
        const { text, thinking, toolCalls } = contentBlocksToParts(m.content);
        out.push({
          key: `h${seq}`,
          kind: "assistant",
          text,
          thinking: thinking || undefined,
          model: m.model,
          provider: m.provider,
          stopReason: m.stopReason,
          timestamp: m.timestamp,
          toolCalls: toolCalls.map(toolCallFromContent),
        });
        break;
      }
      case "toolResult": {
        attachResult(m.toolCallId, toolResultText(m), m.isError);
        break;
      }
      case "bashExecution": {
        seq++;
        out.push({
          key: `h${seq}`,
          kind: "tool",
          text: "",
          timestamp: m.timestamp,
          toolCalls: [
            {
              id: `bash${seq}`,
              name: "bash",
              args: "",
              argsSummary: m.command,
              status: m.exitCode === 0 ? "success" : "error",
              output: "",
              result: m.output,
              isError: m.exitCode !== 0 && !m.cancelled,
            },
          ],
        });
        break;
      }
      case "custom": {
        if (m.display) {
          seq++;
          const text = typeof m.content === "string" ? m.content : "[content]";
          out.push({
            key: `h${seq}`,
            kind: "system",
            text,
            customType: m.customType,
            timestamp: m.timestamp,
          });
        }
        break;
      }
    }
  }
  return out;
}
