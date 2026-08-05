/**
 * Conversation — owns one PiSession subprocess and its UiState, bridging RPC
 * events through the pure reducer. Views subscribe to state changes.
 */
import {
  initialState,
  reduce,
  type Action,
  type UiState,
} from "./reducer";
import { PiSession, type PiSessionOptions } from "./pi-session";
import type {
  AgentMessage,
  ExtensionUiRequest,
  ImageContent,
  Model,
  RpcEvent,
  SessionStatsData,
  SlashCommand,
  ThinkingLevel,
} from "./types";

/** Client-supplied spawn options (the session adds its own event wiring). */
export type ConversationClientOptions = Pick<
  PiSessionOptions,
  "binaryPath" | "cwd" | "env" | "sessionArg" | "extraArgs" | "name" | "version"
>;

export interface ConversationCallbacks {
  /** Fire-and-forget extension UI notifications (notify/setStatus/setTitle/set_editor_text). */
  onUiNotification?: (req: ExtensionUiRequest) => void;
  /** Called once when get_state reports a sessionFile (for tab restore). */
  onSessionFile?: (file: string) => void;
  /** Called with version drift diagnostics if the handshake fails. */
  onSpawnError?: (message: string) => void;
}

let reqCounter = 0;
function nextId(prefix: string): string {
  reqCounter++;
  return `${prefix}-${Date.now().toString(36)}-${reqCounter}`;
}

export class Conversation {
  state: UiState = initialState();
  session: PiSession;
  private listeners = new Set<(state: UiState) => void>();
  private uiNotificationListeners = new Set<(req: ExtensionUiRequest) => void>();
  private callbacks: ConversationCallbacks;
  readonly key: string;
  /** Session file path once known (for restart resume). */
  sessionFile: string | null = null;
  private disposed = false;

  constructor(key: string, opts: ConversationClientOptions, callbacks: ConversationCallbacks = {}) {
    this.key = key;
    this.callbacks = callbacks;
    this.session = new PiSession({
      ...opts,
      onEvent: (event) => {
        // Side effects for non-dialog requests happen outside the reducer.
        this.handleEvent(event);
        this.dispatch({ type: "rpc", event });
      },
      onExit: (code, signal) => {
        this.dispatch({ type: "session_exited", code, signal, stderr: this.state.stderr });
      },
      onStderr: (line) => {
        // Track stderr for diagnostics without blowing up the state on every line.
        this.state = { ...this.state, stderr: [...this.state.stderr.slice(-29), line] };
      },
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    this.session.start();
    void this.refreshState();
  }

  subscribe(listener: (state: UiState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to fire-and-forget extension UI notifications. */
  onUiNotification(listener: (req: ExtensionUiRequest) => void): () => void {
    this.uiNotificationListeners.add(listener);
    return () => this.uiNotificationListeners.delete(listener);
  }

  emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(this.state);
  }

  dispatch(action: Action): void {
    if (this.disposed) return;
    const next = reduce(this.state, action);
    if (next !== this.state) {
      this.state = next;
      this.emit();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.session.stop();
  }

  // -------------------------------------------------------------------------
  // Command helpers (each dispatches the correlated state update)
  // -------------------------------------------------------------------------

  async refreshState(): Promise<void> {
    try {
      const resp = await this.session.send({ type: "get_state" });
      if (resp.success) {
        const d = resp.data as {
          model: Model | null;
          thinkingLevel: ThinkingLevel;
          sessionFile?: string;
          sessionId?: string;
          sessionName?: string;
          pendingMessageCount: number;
        };
        this.dispatch({
          type: "session_ready",
          data: {
            model: d.model ?? null,
            thinkingLevel: d.thinkingLevel ?? "medium",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            sessionFile: d.sessionFile,
            sessionId: d.sessionId,
            sessionName: d.sessionName,
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: d.pendingMessageCount ?? 0,
          },
        });
        if (d.sessionFile && d.sessionFile !== this.sessionFile) {
          this.sessionFile = d.sessionFile;
          this.callbacks.onSessionFile?.(d.sessionFile);
        }
        // Warm the model/thinking catalogues for the header chips.
        void this.refreshModels().catch(() => undefined);
        void this.refreshThinkingLevels().catch(() => undefined);
      }
    } catch (err) {
      const version = this.session.version ? ` (pi ${this.session.version})` : "";
      this.callbacks.onSpawnError?.(String((err as Error).message ?? err));
      // The get_state handshake failed — surface it as a red row with the
      // version so version drift is diagnosable.
      this.state = {
        ...this.state,
        phase: "error",
        error: `Pi handshake failed${version}: ${(err as Error).message}`,
        stderr: this.state.stderr.slice(-30),
      };
      this.emit();
    }
  }

  async loadHistory(): Promise<void> {
    try {
      const resp = await this.session.send({ type: "get_messages" });
      if (resp.success) {
        const messages = (resp.data as { messages: import("./types").AgentMessage[] }).messages;
        this.dispatch({ type: "history_loaded", messages });
      }
    } catch {
      // Non-fatal; the conversation continues from here.
    }
  }

  async refreshModels(): Promise<Model[]> {
    const resp = await this.session.send({ type: "get_available_models" });
    const models = (resp.data as { models: Model[] }).models ?? [];
    this.dispatch({ type: "models_available", models });
    return models;
  }

  async refreshThinkingLevels(): Promise<ThinkingLevel[]> {
    const resp = await this.session.send({ type: "get_available_thinking_levels" });
    const levels = (resp.data as { levels: ThinkingLevel[] }).levels ?? [];
    this.dispatch({ type: "thinking_levels_available", levels });
    return levels;
  }

  /** All available slash commands: extension commands, skills and templates. */
  async getCommands(): Promise<SlashCommand[]> {
    const resp = await this.session.send({ type: "get_commands" });
    return (resp.data as { commands: SlashCommand[] }).commands ?? [];
  }

  async setModel(model: Model): Promise<void> {
    try {
      const resp = await this.session.send({
        type: "set_model",
        provider: model.provider,
        modelId: model.id,
      });
      if (resp.success) {
        const updated = (resp.data as Model) ?? model;
        this.dispatch({ type: "model_changed", model: updated });
        void this.refreshThinkingLevels().catch(() => undefined);
      }
    } catch (err) {
      this.pushError(`Failed to switch model: ${(err as Error).message}`);
    }
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    try {
      await this.session.send({ type: "set_thinking_level", level });
      this.dispatch({ type: "thinking_level_changed", level });
    } catch (err) {
      this.pushError(`Failed to set thinking level: ${(err as Error).message}`);
    }
  }

  async rename(name: string): Promise<void> {
    if (!name) return;
    try {
      await this.session.send({ type: "set_session_name", name });
      this.dispatch({ type: "session_name_changed", name });
    } catch (err) {
      this.pushError(`Failed to rename session: ${(err as Error).message}`);
    }
  }

  async exportHtml(folder: string): Promise<string | null> {
    try {
      const resp = await this.session.send({
        type: "export_html",
        outputPath: folder,
      });
      if (resp.success) {
        const path = (resp.data as { path: string }).path;
        this.dispatch({ type: "export_done", path });
        return path;
      }
      this.pushError(`Export failed: ${resp.error ?? "unknown error"}`);
      return null;
    } catch (err) {
      this.pushError(`Export failed: ${(err as Error).message}`);
      return null;
    }
  }

  async getStats(): Promise<import("./types").SessionStatsData | null> {
    try {
      const resp = await this.session.send({ type: "get_session_stats" });
      if (resp.success) {
        const stats = resp.data as import("./types").SessionStatsData;
        this.dispatch({ type: "session_stats", stats });
        return stats;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Jump the current tab to a different session file (pi loads it in place). */
  async switchSession(sessionPath: string): Promise<void> {
    try {
      const prevName = this.state.sessionName;
      const resp = await this.session.send({ type: "switch_session", sessionPath });
      const cancelled = (resp.data as { cancelled?: boolean } | undefined)?.cancelled ?? false;
      if (cancelled) return;
      // The session switched underneath us: clear the panel, then repopulate
      // from the new session's state and history.
      this.state = {
        ...initialState(),
        phase: "ready",
        stderr: this.state.stderr,
      };
      this.emit();
      this.sessionFile = sessionPath;
      this.callbacks.onSessionFile?.(sessionPath);
      void this.refreshState();
      void this.loadHistory();
      if (prevName) this.pushSystem(`Switched away from "${prevName}".`);
    } catch (err) {
      this.pushError(`Failed to switch session: ${(err as Error).message}`);
    }
  }

  async newSession(): Promise<void> {
    try {
      const prevName = this.state.sessionName;
      const prevFile = this.sessionFile;
      const resp = await this.session.send({ type: "new_session" });
      const cancelled = (resp.data as { cancelled?: boolean } | undefined)?.cancelled ?? false;
      if (!cancelled) {
        // The session restarted underneath us: clear the panel. The previous
        // session stays on disk (sessions are Pi's) and is resumable.
        this.state = {
          ...initialState(),
          phase: "ready",
          stderr: this.state.stderr,
        };
        this.emit();
        void this.refreshState();
        void this.loadHistory();
        const prevLabel =
          prevName || (prevFile ? prevFile.slice(prevFile.lastIndexOf("/") + 1) : undefined);
        this.pushSystem(
          prevLabel
            ? `Started a new session. "${prevLabel}" is still saved — pick it again from the conversation picker (bottom-right).`
            : "Started a new session.",
        );
      }
    } catch (err) {
      this.pushError(`Failed to start new session: ${(err as Error).message}`);
    }
  }

  /** Queue a steering message while running, or a plain prompt when idle. */
  async prompt(text: string, images?: ImageContent[], displayText?: string): Promise<void> {
    const streaming = this.state.isRunning || this.state.isStreaming;
    // Plugin-level slash command: /reload mirrors the TUI's built-in — it
    // reloads pi's extensions, skills, prompts, themes and the session from
    // disk. pi has no RPC wire command for reload, so we run the reload-context
    // extension via a prompt; if it's not installed, fall back to re-syncing
    // the pane with pi's persisted session state.
    if (text.trim() === "/reload" && !images?.length) {
      if (streaming) {
        this.pushError("Wait for the current response to finish before reloading.");
        return;
      }
      const commands = await this.getCommands().catch(() => [] as SlashCommand[]);
      if (commands.some((c) => c.name === "reload")) {
        // Extension executes immediately; no agent run starts.
        await this.session.send({ type: "prompt", message: "/reload" });
      }
      // Reconcile the pane either way (get_messages reflects the reloaded state).
      await this.loadHistory();
      return;
    }
    this.dispatch({ type: "user_message", text: displayText ?? text, images });
    try {
      await this.session.send({
        type: "prompt",
        message: text,
        images,
        streamingBehavior: streaming ? "steer" : undefined,
      });
      // Slash commands (extension commands like /clear, skills, templates) can
      // mutate the session tree server-side (clear, rewind, fork) without
      // producing agent events. If no agent run starts shortly after, re-fetch
      // messages so the pane reflects the cleared/rewound state. Skipped while
      // streaming — the run's own events will reconcile.
      if (text.startsWith("/") && !streaming) {
        const reconcile = () => {
          if (!this.state.isRunning && !this.state.isStreaming) {
            void this.loadHistory().catch(() => undefined);
          }
        };
        setTimeout(reconcile, 400);
        setTimeout(reconcile, 1500);
      }
    } catch (err) {
      this.pushError(`Prompt failed: ${(err as Error).message}`);
    }
  }

  abort(): void {
    void this.session.send({ type: "abort" }).catch(() => undefined);
  }

  /** Reply to an extension dialog request. */
  answerExtension(requestId: string, value?: string, confirmed?: boolean, cancelled?: boolean): void {
    this.session.sendRaw({
      type: "extension_ui_response",
      id: requestId,
      ...(value !== undefined ? { value } : {}),
      ...(confirmed !== undefined ? { confirmed } : {}),
      ...(cancelled !== undefined ? { cancelled } : {}),
    });
    this.dispatch({ type: "extension_ui_answered", id: requestId });
  }

  private pushError(message: string): void {
    this.state = {
      ...this.state,
      messages: [
        ...this.state.messages,
        { key: `e${this.state.seq + 1}`, kind: "error", text: message },
      ],
      seq: this.state.seq + 1,
    };
    this.emit();
  }

  private pushSystem(message: string): void {
    this.state = {
      ...this.state,
      messages: [
        ...this.state.messages,
        { key: `s${this.state.seq + 1}`, kind: "system", text: message },
      ],
      seq: this.state.seq + 1,
    };
    this.emit();
  }

  /** Route an event's side effects that don't belong in the reducer. */
  handleEvent(event: RpcEvent): void {
    if (event.type === "extension_ui_request" && !isDialogRequest(event)) {
      this.callbacks.onUiNotification?.(event);
      for (const listener of this.uiNotificationListeners) listener(event);
    }
  }
}

function isDialogRequest(req: ExtensionUiRequest): boolean {
  return req.method === "select" || req.method === "confirm" || req.method === "input" || req.method === "editor";
}
