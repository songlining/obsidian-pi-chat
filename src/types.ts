/**
 * Pi RPC protocol types.
 *
 * Based on the Pi RPC documentation:
 *   node_modules/@earendil-works/pi-coding-agent/docs/rpc.md
 *   node_modules/@earendil-works/pi-coding-agent/docs/session-format.md
 */

// ---------------------------------------------------------------------------
// Model / state
// ---------------------------------------------------------------------------

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Model {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface SlashCommand {
  name: string;
  description: string;
  source: "extension" | "prompt" | "skill" | "plugin";
  sourceInfo?: string;
}

export interface SessionStateData {
  model: Model | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: string;
  followUpMode: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface SessionStatsData {
  sessionFile?: string;
  sessionId?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

// ---------------------------------------------------------------------------
// Messages (AgentMessage)
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolCallContent;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  api: string;
  provider: string;
  model: string;
  usage?: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  usage?: Usage;
  isError: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage;

// ---------------------------------------------------------------------------
// RPC commands (stdin)
// ---------------------------------------------------------------------------

export interface RpcCommandBase {
  id?: string;
}

export interface PromptCommand extends RpcCommandBase {
  type: "prompt";
  message: string;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
}

export interface SteerCommand extends RpcCommandBase {
  type: "steer";
  message: string;
  images?: ImageContent[];
}

export interface AbortCommand extends RpcCommandBase {
  type: "abort";
}

export interface NewSessionCommand extends RpcCommandBase {
  type: "new_session";
  parentSession?: string;
}

export interface GetStateCommand extends RpcCommandBase {
  type: "get_state";
}

export interface GetMessagesCommand extends RpcCommandBase {
  type: "get_messages";
}

export interface SetModelCommand extends RpcCommandBase {
  type: "set_model";
  provider: string;
  modelId: string;
}

export interface GetAvailableModelsCommand extends RpcCommandBase {
  type: "get_available_models";
}

export interface SetThinkingLevelCommand extends RpcCommandBase {
  type: "set_thinking_level";
  level: ThinkingLevel;
}

export interface GetAvailableThinkingLevelsCommand extends RpcCommandBase {
  type: "get_available_thinking_levels";
}

export interface GetCommandsCommand extends RpcCommandBase {
  type: "get_commands";
}

export interface SetSessionNameCommand extends RpcCommandBase {
  type: "set_session_name";
  name: string;
}

export interface ExportHtmlCommand extends RpcCommandBase {
  type: "export_html";
  outputPath?: string;
}

export interface GetSessionStatsCommand extends RpcCommandBase {
  type: "get_session_stats";
}

export interface SwitchSessionCommand extends RpcCommandBase {
  type: "switch_session";
  sessionPath: string;
}

export interface GetEntriesCommand extends RpcCommandBase {
  type: "get_entries";
  since?: string;
}

export interface BashCommand extends RpcCommandBase {
  type: "bash";
  command: string;
}

export interface AbortBashCommand extends RpcCommandBase {
  type: "abort_bash";
}

export interface ExtensionUiResponseCommand extends RpcCommandBase {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface SpawnCommand extends RpcCommandBase {
  type: "spawn";
  cwd: string;
}

export type RpcCommand =
  | PromptCommand
  | SteerCommand
  | AbortCommand
  | NewSessionCommand
  | GetStateCommand
  | GetMessagesCommand
  | SetModelCommand
  | GetAvailableModelsCommand
  | SetThinkingLevelCommand
  | GetAvailableThinkingLevelsCommand
  | GetCommandsCommand
  | SetSessionNameCommand
  | ExportHtmlCommand
  | GetSessionStatsCommand
  | SwitchSessionCommand
  | GetEntriesCommand
  | BashCommand
  | AbortBashCommand
  | ExtensionUiResponseCommand;

// ---------------------------------------------------------------------------
// RPC responses (stdout)
// ---------------------------------------------------------------------------

export interface RpcResponse<T = unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: T;
}

// ---------------------------------------------------------------------------
// RPC events (stdout)
// ---------------------------------------------------------------------------

export type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; thinking: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent }
  | { type: "done"; reason: "stop" | "length" | "toolUse" }
  | { type: "error"; reason: "aborted" | "error" };

export interface MessageUpdateEvent {
  type: "message_update";
  message: AssistantMessage;
  assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageStartEvent {
  type: "message_start";
  message: AgentMessage;
}

export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult: {
    content: (TextContent | ImageContent)[];
    details?: { truncation: unknown; fullOutputPath: string | null };
  };
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: {
    content: (TextContent | ImageContent)[];
    details?: unknown;
  };
  isError: boolean;
}

export interface BashExecutionUpdateEvent {
  type: "bash_execution_update";
  id: string;
  delta: string;
}

export interface AgentStartEvent {
  type: "agent_start";
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
  willRetry: boolean;
}

export interface AgentSettledEvent {
  type: "agent_settled";
}

export interface TurnStartEvent {
  type: "turn_start";
}

export interface TurnEndEvent {
  type: "turn_end";
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
}

export interface QueueUpdateEvent {
  type: "queue_update";
  steering: string[];
  followUp: string[];
}

export interface CompactionStartEvent {
  type: "compaction_start";
  reason: "manual" | "threshold" | "overflow";
}

export interface CompactionEndEvent {
  type: "compaction_end";
  reason: string;
  result: unknown;
  aborted: boolean;
  willRetry: boolean;
}

export interface AutoRetryStartEvent {
  type: "auto_retry_start";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface AutoRetryEndEvent {
  type: "auto_retry_end";
  success: boolean;
  attempt: number;
  finalError?: string;
}

export interface ExtensionErrorEvent {
  type: "extension_error";
  extensionPath: string;
  event: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Extension UI protocol
// ---------------------------------------------------------------------------

export type ExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title?: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title?: string;
      message?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title?: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title?: string;
      prefill?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    };

export type RpcEvent =
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | BashExecutionUpdateEvent
  | AgentStartEvent
  | AgentEndEvent
  | AgentSettledEvent
  | TurnStartEvent
  | TurnEndEvent
  | QueueUpdateEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | AutoRetryStartEvent
  | AutoRetryEndEvent
  | ExtensionErrorEvent
  | ExtensionUiRequest;

export type RpcOutput = RpcEvent | RpcResponse;
