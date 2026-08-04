/**
 * PiChatView — the chat panel workspace leaf.
 *
 * One leaf per conversation. Renders the conversation state (messages,
 * thinking blocks, tool call rows, extension dialogs), the header (session
 * name, model chip, thinking chip, overflow menu) and the input box.
 */
import {
  App,
  ButtonComponent,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type PiChatPlugin from "./main";
import type { Conversation } from "./conversation";
import type { UiMessage, UiState, ToolCallUi } from "./reducer";
import { contentBlocksToParts, toolArgsSummary } from "./reducer";
import type { ExtensionUiRequest, ThinkingLevel } from "./types";
import {
  ModelSwitcherModal,
  RenameSessionModal,
  ResumeSessionModal,
  SessionInfoModal,
  ThinkingLevelModal,
} from "./modals";

export const VIEW_TYPE_PI_CHAT = "pi-chat";

const RENDER_THROTTLE_MS = 100;

interface ViewStatePayload {
  sessionKey?: string;
  sessionArg?: string[];
  [key: string]: unknown;
}

export class PiChatView extends ItemView {
  plugin: PiChatPlugin;
  conversation: Conversation | null = null;

  private headerEl!: HTMLElement;
  private nameInputEl!: HTMLInputElement;
  private messagesEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private sessionPickerEl!: HTMLButtonElement;
  private sessionPickerLabel!: HTMLElement;
  private tabPickerEl!: HTMLButtonElement;
  private tabPickerLabel!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: ButtonComponent;
  private headerTitleEl!: HTMLElement;
  private modelChipEl!: HTMLElement;
  private thinkingChipEl!: HTMLElement;

  private messageEls = new Map<string, HTMLElement>();
  private renderTimers = new Map<string, number>();
  private lastRender = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  private unsubNotif: (() => void) | null = null;
  private scrollPinned = true;
  private suppressScroll = false;
  private lastTabTitle = "";

  constructor(leaf: WorkspaceLeaf, plugin: PiChatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PI_CHAT;
  }

  getDisplayText(): string {
    return this.conversation?.state.sessionName || "Pi Chat";
  }

  getIcon(): string {
    return "bot";
  }

  getState(): ViewStatePayload {
    const state = super.getState() as ViewStatePayload;
    return state ?? {};
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async onOpen(): Promise<void> {
    const state = this.getState();
    const sessionKey = state.sessionKey ?? `conv-${Date.now().toString(36)}`;
    const sessionArg = state.sessionArg;

    this.conversation = await this.plugin.getOrCreateConversation(sessionKey, {
      sessionArg,
      view: this,
    });
    if (!this.conversation) {
      // pi binary not found — setup notice instead of a crash.
      this.renderSetupNotice();
      return;
    }

    this.renderLayout();
    this.unsubscribe = this.conversation.subscribe((s) => this.render(s));
    this.unsubNotif = this.conversation.onUiNotification((req) => this.handleUiNotification(req));

    // If the conversation is brand new, kick off the handshake.
    void this.conversation.loadHistory().catch(() => undefined);
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubNotif?.();
    this.unsubNotif = null;
    this.plugin.detachView(this);
    this.conversation = null;
    for (const timer of this.renderTimers.values()) window.clearTimeout(timer);
    this.renderTimers.clear();
  }

  private handleUiNotification(req: ExtensionUiRequest): void {
    switch (req.method) {
      case "notify":
        new Notice(req.message, 4000);
        break;
      case "set_editor_text":
        this.inputEl.value = req.text;
        break;
      case "setTitle":
        this.headerTitleEl.setText(req.title);
        break;
      case "setStatus":
      case "setWidget":
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  private renderSetupNotice(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("pi-chat-root");
    const notice = root.createDiv({ cls: "pi-chat-setup-notice" });
    notice.createDiv({ cls: "pi-chat-setup-title", text: "Pi binary not found" });
    notice.createDiv({
      cls: "pi-chat-setup-text",
      text: "The plugin auto-detects pi via your login shell. If it is installed somewhere unusual, set the path in the plugin settings.",
    });
    const btnRow = notice.createDiv({ cls: "pi-chat-modal-actions" });
    new ButtonComponent(btnRow).setButtonText("Open settings").setCta().onClick(() => {
      const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
      if (setting?.open) {
        setting.open();
        setting.openTabById?.("pi-chat-local");
      }
    });
    new ButtonComponent(btnRow).setButtonText("Retry detection").onClick(() => {
      this.plugin.piEnv = null;
      void this.plugin.ensurePiEnv().then(() => void this.onOpen());
    });
  }

  private renderLayout(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("pi-chat-root");
    root.createDiv({ cls: "pi-chat-header" }, (header) => {
      this.headerEl = header;
      this.headerTitleEl = header.createDiv({ cls: "pi-chat-header-title", text: "Pi Chat" });
      this.headerTitleEl.addEventListener("click", () => this.showRename());
      header.createDiv({ cls: "pi-chat-header-spacer" });
      this.modelChipEl = header.createDiv({ cls: "pi-chat-chip pi-chat-chip-model" });
      this.thinkingChipEl = header.createDiv({ cls: "pi-chat-chip pi-chat-chip-thinking" });
      this.modelChipEl.addEventListener("click", () => void this.openModelSwitcher());
      this.thinkingChipEl.addEventListener("click", () => void this.openThinkingSwitcher());
      const menuBtn = header.createEl("button", { cls: "pi-chat-icon-btn" });
      setIcon(menuBtn, "more-horizontal");
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showMenu(menuBtn, e);
      });
    });

    root.createDiv({ cls: "pi-chat-messages" }, (messages) => {
      this.messagesEl = messages;
      messages.addEventListener("scroll", () => {
        const nearBottom =
          messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
        this.scrollPinned = nearBottom;
      });
    });

    root.createDiv({ cls: "pi-chat-status-bar" }, (bar) => {
      this.statusEl = bar.createDiv({ cls: "pi-chat-status" });
      const actions = bar.createDiv({ cls: "pi-chat-status-actions" });

      // Tab picker (left): shows the tab's session name.
      this.tabPickerEl = actions.createEl("button", { cls: "pi-chat-tab-picker" });
      this.tabPickerLabel = this.tabPickerEl.createSpan({ cls: "pi-chat-tab-picker-label" });
      const tabIcon = this.tabPickerEl.createSpan({ cls: "pi-chat-tab-picker-icon" });
      setIcon(tabIcon, "hash");
      this.tabPickerEl.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.showTabMenu(this.tabPickerEl, e);
      });

      // Session picker (right): switch this tab to any saved session.
      this.sessionPickerEl = actions.createEl("button", { cls: "pi-chat-session-picker" });
      this.sessionPickerLabel = this.sessionPickerEl.createSpan({
        cls: "pi-chat-session-picker-label",
        text: "Sessions",
      });
      const iconSpan = this.sessionPickerEl.createSpan({ cls: "pi-chat-session-picker-icon" });
      setIcon(iconSpan, "chevron-down");
      this.sessionPickerEl.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.showSessionMenu(this.sessionPickerEl, e);
      });
    });

    // Rename box: bottom-left, just above the message input box.
    root.createDiv({ cls: "pi-chat-name-bar" }, (bar) => {
      const icon = bar.createSpan({ cls: "pi-chat-name-icon" });
      setIcon(icon, "pencil");
      this.nameInputEl = bar.createEl("input", {
        cls: "pi-chat-name-input",
        attr: { placeholder: "Session name — click to rename", spellcheck: "false" },
      });
      this.nameInputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.applyRenameFromInput();
        } else if (e.key === "Escape") {
          this.revertNameInput();
        }
      });
      this.nameInputEl.addEventListener("blur", () => this.applyRenameFromInput());
    });

    root.createDiv({ cls: "pi-chat-input-bar" }, (bar) => {
      this.inputEl = bar.createEl("textarea", {
        cls: "pi-chat-input",
        attr: { placeholder: "Message Pi… (Enter to send, Shift+Enter for newline)", rows: "2" },
      });
      this.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.sendCurrentInput();
        }
      });
      this.sendBtn = new ButtonComponent(bar).setButtonText("Send").setCta();
      this.sendBtn.buttonEl.addClass("pi-chat-send-btn");
      this.sendBtn.onClick(() => this.sendCurrentInput());
    });

    this.messagesEl.createDiv({
      cls: "pi-chat-welcome",
      text: "Start typing to begin a new session, or pick an existing session from the Sessions picker (bottom-right).",
    });
  }

  // -------------------------------------------------------------------------
  // State -> DOM
  // -------------------------------------------------------------------------

  private render(state: UiState): void {
    // Header + tab title (tab names come from the Rename button)
    const title = state.sessionName || "Pi Chat";
    if (this.headerTitleEl.getText() !== title) this.headerTitleEl.setText(title);
    if (this.headerTitleEl.getAttribute("data-name") !== state.sessionName) {
      this.headerTitleEl.setAttribute("data-name", state.sessionName ?? "");
    }
    // Refresh the visible tab label whenever the session name changes.
    if (this.lastTabTitle !== title) {
      this.lastTabTitle = title;
      (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    }

    this.modelChipEl.setText(state.model ? `${state.model.provider}/${state.model.name}` : "model…");
    this.thinkingChipEl.setText(state.thinkingLevel ? `thinking: ${state.thinkingLevel}` : "thinking…");

    // Tab picker (bottom-right, left): the tab's session name.
    this.tabPickerLabel.setText(state.sessionName || "Unnamed");
    this.tabPickerEl.setAttribute("title", state.sessionFile || "");

    // Rename box: keep in sync unless the user is mid-edit.
    if (document.activeElement !== this.nameInputEl) {
      this.nameInputEl.value = state.sessionName || "";
    }

    // Status strip
    this.renderStatus(state);

    // Messages (diff by key)
    this.renderMessages(state);

    // Send/Stop button
    const running = state.isRunning || state.isStreaming;
    if (running) {
      if (this.sendBtn.buttonEl.getText() !== "Stop") {
        this.sendBtn.setButtonText("Stop");
        this.sendBtn.buttonEl.removeClass("is-cta");
        this.sendBtn.buttonEl.addClass("pi-chat-stop-btn");
      }
    } else {
      if (this.sendBtn.buttonEl.getText() !== "Send") {
        this.sendBtn.setButtonText("Send");
        this.sendBtn.buttonEl.removeClass("pi-chat-stop-btn");
        this.sendBtn.buttonEl.addClass("is-cta");
      }
    }
  }

  private renderStatus(state: UiState): void {
    this.statusEl.empty();
    const bits: string[] = [];
    if (state.phase === "spawning") bits.push("connecting…");
    if (state.isStreaming) bits.push("● streaming…");
    if (state.isRunning && !state.isStreaming) bits.push("working…");
    if (state.pendingQueue > 0) bits.push(`${state.pendingQueue} queued`);
    if (state.isCompacting) bits.push("compacting…");
    if (state.autoRetry) bits.push(`retrying (${state.autoRetry.attempt}/${state.autoRetry.maxAttempts})…`);
    if (bits.length === 0) {
      this.statusEl.setText("");
      return;
    }
    this.statusEl.setText(bits.join("  ·  "));
  }

  private renderMessages(state: UiState): void {
    const seen = new Set<string>();

    // The welcome hint only belongs on a genuinely empty (fresh) session.
    const welcome = this.messagesEl.querySelector(".pi-chat-welcome");
    if (state.messages.length > 0) {
      welcome?.remove();
    }

    // Keep scroll pinned only when we were already near the bottom and are
    // streaming; otherwise let the user read without yanking.
    const wasPinned = this.scrollPinned;

    // Remove stale message nodes.
    for (const key of this.messageEls.keys()) {
      if (!state.messages.some((m) => m.key === key)) {
        this.messageEls.get(key)?.remove();
        this.messageEls.delete(key);
        const t = this.renderTimers.get(key);
        if (t) window.clearTimeout(t);
        this.renderTimers.delete(key);
      }
    }

    for (const message of state.messages) {
      seen.add(message.key);
      let el = this.messageEls.get(message.key);
      if (!el) {
        el = this.messagesEl.createDiv({ cls: `pi-chat-msg pi-chat-msg-${message.kind}` });
        this.messageEls.set(message.key, el);
      }
      el.toggleClass("pi-chat-streaming", !!message.streaming);
      el.toggleClass("pi-chat-pending", !!message.pending);
      this.renderMessageInto(el, message, state);
    }

    // Extension dialogs.
    this.renderExtensionRequests(state);

    // Error banner.
    const errEl = this.messagesEl.querySelector(".pi-chat-fatal");
    if (state.error && state.phase === "error") {
      if (!errEl) {
        const div = this.messagesEl.createDiv({ cls: "pi-chat-msg pi-chat-msg-error pi-chat-fatal" });
        div.createDiv({ text: state.error });
        if (state.stderr.length > 0) {
          div.createDiv({ cls: "pi-chat-fatal-details", text: state.stderr.join("\n") });
        }
        const btn = div.createDiv({ cls: "pi-chat-modal-actions" });
        new ButtonComponent(btn).setButtonText("Retry").onClick(() => void this.retry());
        new ButtonComponent(btn).setButtonText("Dismiss").onClick(() => {
          div.remove();
          this.conversation?.dispatch({ type: "clear_error" });
        });
      }
    } else if (errEl) {
      errEl.remove();
    }

    if (wasPinned) this.scrollToBottom();
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  /** Restart the underlying subprocess and re-attach to a fresh conversation. */
  async retry(): Promise<void> {
    const key = this.getState().sessionKey;
    if (!key) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubNotif?.();
    this.unsubNotif = null;
    const conv = await this.plugin.retryConversation(this);
    if (!conv) return;
    this.conversation = conv;
    this.messagesEl.empty();
    this.messageEls.clear();
    this.messagesEl.createDiv({
      cls: "pi-chat-welcome",
      text: "Start typing to begin a new session, or pick an existing session from the Sessions picker (bottom-right).",
    });
    this.unsubscribe = conv.subscribe((s) => this.render(s));
    this.unsubNotif = conv.onUiNotification((req) => this.handleUiNotification(req));
    void conv.loadHistory().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Message rendering
  // -------------------------------------------------------------------------

  private renderMessageInto(el: HTMLElement, message: UiMessage, _state: UiState): void {
    const mdKey = `${message.key}-md`;
    const toolKey = `${message.key}-tools`;

    switch (message.kind) {
      case "user":
        this.renderMarkdownThrottled(el, message.text, mdKey, message);
        break;
      case "assistant":
        this.renderMarkdownThrottled(el, message.text, mdKey, message);
        this.renderThinkingBlock(el, message);
        this.renderToolCalls(el, message, toolKey);
        break;
      case "tool":
        this.renderToolCalls(el, message, toolKey);
        break;
      case "system":
        this.renderSystemRow(el, message);
        break;
      case "error":
        this.renderSystemRow(el, message, true);
        break;
    }
  }

  private renderMarkdownThrottled(
    el: HTMLElement,
    markdown: string,
    key: string,
    message: UiMessage,
  ): void {
    let mdEl = el.querySelector<HTMLElement>(".pi-chat-md");
    if (!mdEl) {
      mdEl = el.createDiv({ cls: "pi-chat-md" });
    }

    const now = Date.now();
    const last = this.lastRender.get(key) ?? 0;
    const render = () => {
      this.lastRender.set(key, Date.now());
      const timer = this.renderTimers.get(key);
      if (timer) window.clearTimeout(timer);
      this.renderTimers.delete(key);
      mdEl!.empty();
      // MarkdownRenderer.render can throw on broken markdown; guard it.
      void MarkdownRenderer.render(this.app, markdown, mdEl!, this.getVaultRoot(), this)
        .catch(() => {
          mdEl!.createDiv({ text: markdown });
        });
    };

    if (!message.streaming || now - last >= RENDER_THROTTLE_MS) {
      render();
    } else if (!this.renderTimers.has(key)) {
      const timer = window.setTimeout(render, RENDER_THROTTLE_MS);
      this.renderTimers.set(key, timer);
    }
  }

  private getVaultRoot(): string {
    const vault = this.app.vault;
    return vault.getRoot ? (vault.getRoot() as unknown as { path: string }).path ?? "/" : "/";
  }

  private renderThinkingBlock(el: HTMLElement, message: UiMessage): void {
    const existing = el.querySelector<HTMLElement>(".pi-chat-thinking");
    const hasThinking = !!message.thinking && message.thinking.trim().length > 0;
    if (!hasThinking) {
      existing?.remove();
      return;
    }
    if (existing && existing.getAttribute("data-content") === message.thinking) return;
    existing?.remove();

    const block = el.createDiv({ cls: "pi-chat-thinking pi-chat-thinking-collapsed" });
    block.setAttribute("data-content", message.thinking ?? "");
    const summary = block.createDiv({ cls: "pi-chat-thinking-summary" });
    summary.setText("thinking");
    const body = block.createDiv({ cls: "pi-chat-thinking-body pi-chat-hidden" });
    body.setText(message.thinking ?? "");
    summary.addEventListener("click", () => {
      block.classList.toggle("pi-chat-thinking-collapsed");
      body.classList.toggle("pi-chat-hidden");
    });
  }

  private renderToolCalls(el: HTMLElement, message: UiMessage, key: string): void {
    const calls = message.toolCalls ?? [];
    const existing = el.querySelector<HTMLElement>(`.pi-chat-tools[data-key="${key}"]`);
    if (calls.length === 0) {
      existing?.remove();
      return;
    }
    if (existing) existing.remove();

    const container = el.createDiv({ cls: "pi-chat-tools", attr: { "data-key": key } });
    for (const call of calls) {
      this.renderToolRow(container, call, message);
    }
  }

  private renderToolRow(container: HTMLElement, call: ToolCallUi, message: UiMessage): void {
    const row = container.createDiv({ cls: `pi-chat-tool pi-chat-tool-${call.status}` });
    const header = row.createDiv({ cls: "pi-chat-tool-header" });

    const icon = header.createSpan({ cls: "pi-chat-tool-icon" });
    setIcon(icon, toolIconFor(call.name));
    const name = header.createSpan({ cls: "pi-chat-tool-name", text: call.name });
    if (call.argsSummary) {
      header.createSpan({ cls: "pi-chat-tool-args", text: call.argsSummary });
    }
    const status = header.createSpan({ cls: "pi-chat-tool-status" });
    status.setText(statusTextFor(call.status));
    header.addEventListener("click", () => row.classList.toggle("pi-chat-tool-expanded"));

    // Clickable file link for edit/write on vault files.
    const filePath = filePathFromTool(call.name, call.args);
    if (filePath) {
      const link = header.createEl("a", { cls: "pi-chat-tool-file", text: `↗ ${filePath}` });
      link.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openVaultFile(filePath);
      });
    }

    const body = row.createDiv({ cls: "pi-chat-tool-body pi-chat-hidden" });
    if (call.args) {
      body.createEl("pre", { cls: "pi-chat-tool-args-block", text: call.args });
    }
    if (call.output) {
      body.createEl("pre", { cls: "pi-chat-tool-output", text: call.output });
    }
    if (call.result) {
      const label = call.isError ? "result (error)" : "result";
      body.createEl("div", { cls: "pi-chat-tool-result-label", text: label });
      body.createEl("pre", { cls: "pi-chat-tool-result", text: call.result });
    }
  }

  private renderSystemRow(el: HTMLElement, message: UiMessage, error = false): void {
    const text = message.text || (message.customType ? `[${message.customType}]` : "");
    el.setText(text);
    el.toggleClass("pi-chat-msg-error", error);
    el.toggleClass("pi-chat-msg-system", !error);
  }

  private renderExtensionRequests(state: UiState): void {
    // Find the container for extension dialogs.
    let extContainer = this.messagesEl.querySelector<HTMLElement>(".pi-chat-ext-container");
    if (!extContainer) {
      extContainer = this.messagesEl.createDiv({ cls: "pi-chat-ext-container" });
    } else {
      extContainer.empty();
    }
    for (const req of state.extensionRequests) {
      this.renderExtensionRequest(extContainer, req);
    }
  }

  private renderExtensionRequest(container: HTMLElement, req: ExtensionUiRequest): void {
    const form = container.createDiv({ cls: "pi-chat-ext-form" });
    const reqTitle = "title" in req ? req.title : undefined;
    const title = form.createDiv({ cls: "pi-chat-ext-title", text: reqTitle || req.method });

    const respond = (payload: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
      this.conversation?.answerExtension(req.id, payload.value, payload.confirmed, payload.cancelled);
    };

    switch (req.method) {
      case "select": {
        for (const option of req.options) {
          const btn = new ButtonComponent(form).setButtonText(option);
          btn.buttonEl.addClass("pi-chat-ext-option");
          btn.onClick(() => respond({ value: option }));
        }
        if (req.timeout) {
          form.createDiv({ cls: "pi-chat-ext-hint", text: `auto-resolves in ${Math.round(req.timeout / 1000)}s if unanswered` });
        }
        break;
      }
      case "confirm": {
        if (req.message) form.createDiv({ cls: "pi-chat-ext-message", text: req.message });
        const actions = form.createDiv({ cls: "pi-chat-modal-actions" });
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => respond({ cancelled: true }));
        new ButtonComponent(actions).setButtonText("Confirm").setCta().onClick(() => respond({ confirmed: true }));
        break;
      }
      case "input": {
        const input = form.createEl("input", { type: "text", cls: "pi-chat-ext-input" });
        if (req.placeholder) input.setAttribute("placeholder", req.placeholder);
        const actions = form.createDiv({ cls: "pi-chat-modal-actions" });
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => respond({ cancelled: true }));
        new ButtonComponent(actions).setButtonText("OK").setCta().onClick(() => respond({ value: input.value }));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") respond({ value: input.value });
        });
        input.focus();
        break;
      }
      case "editor": {
        const textarea = form.createEl("textarea", { cls: "pi-chat-ext-editor", attr: { rows: "6" } });
        textarea.value = req.prefill ?? "";
        const actions = form.createDiv({ cls: "pi-chat-modal-actions" });
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => respond({ cancelled: true }));
        new ButtonComponent(actions).setButtonText("OK").setCta().onClick(() => respond({ value: textarea.value }));
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private sendCurrentInput(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const conv = this.conversation;
    if (!conv) return;

    const running = conv.state.isRunning || conv.state.isStreaming;
    if (this.sendBtn.buttonEl.getText() === "Stop" && running) {
      conv.abort();
      return;
    }
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    void conv.prompt(text);
  }

  private async openModelSwitcher(): Promise<void> {
    const conv = this.conversation;
    if (!conv) return;
    let models = conv.state.availableModels;
    if (models.length === 0) models = await conv.refreshModels().catch(() => []);
    if (models.length === 0) {
      new Notice("No models available from Pi.");
      return;
    }
    new ModelSwitcherModal(this.app, models, (m) => void conv.setModel(m)).open();
  }

  private async openThinkingSwitcher(): Promise<void> {
    const conv = this.conversation;
    if (!conv) return;
    let levels = conv.state.availableThinkingLevels;
    if (levels.length === 0) levels = await conv.refreshThinkingLevels().catch(() => []);
    if (levels.length === 0) {
      new Notice("This model has no thinking levels.");
      return;
    }
    new ThinkingLevelModal(this.app, levels, (l: ThinkingLevel) => void conv.setThinkingLevel(l)).open();
  }

  private showRename(): void {
    const conv = this.conversation;
    if (!conv) return;
    new RenameSessionModal(this.app, conv.state.sessionName ?? "", (name) => void conv.rename(name)).open();
  }

  private applyRenameFromInput(): void {
    const conv = this.conversation;
    if (!conv) return;
    const value = this.nameInputEl.value.trim();
    if (value && value !== conv.state.sessionName) {
      void conv.rename(value);
    } else {
      this.revertNameInput();
    }
  }

  private revertNameInput(): void {
    if (this.conversation) this.nameInputEl.value = this.conversation.state.sessionName || "";
    this.nameInputEl.blur();
  }

  /** Bottom-right tab picker: switch tabs and manage the current tab. */
  private showTabMenu(anchor: HTMLElement, evt?: MouseEvent): void {
    const conv = this.conversation;
    if (!conv) return;
    const menu = new Menu();

    // Other open Pi Chat tabs — clicking one makes it active (its session
    // then becomes the checked one in the Sessions picker).
    const others = this.app.workspace
      .getLeavesOfType("pi-chat")
      .filter((l) => l.view !== this);
    for (const leaf of others) {
      const v = leaf.view as PiChatView;
      const name = v.conversation?.state.sessionName || "Unnamed";
      menu.addItem((item) =>
        item
          .setSection("tabs")
          .setTitle(name)
          .setIcon("file-text")
          .onClick(() => this.app.workspace.setActiveLeaf(leaf, { focus: true })),
      );
    }
    if (others.length > 0) menu.addSeparator();

    menu.addItem((item) =>
      item
        .setSection("actions")
        .setTitle("Rename session…")
        .setIcon("pencil")
        .onClick(() => this.showRename()),
    );
    menu.addItem((item) =>
      item
        .setSection("actions")
        .setTitle("New chat in this tab")
        .setIcon("plus")
        .onClick(() => void conv.newSession()),
    );
    if (conv.sessionFile) {
      menu.addItem((item) =>
        item
          .setSection("actions")
          .setTitle("Copy session file path")
          .setIcon("copy")
          .onClick(() => void navigator.clipboard.writeText(conv.sessionFile ?? "")),
      );
    }
    if (evt) {
      menu.showAtMouseEvent(evt);
    } else {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }
  }

  /** Bottom-right session picker: jump the current tab to any saved session. */
  private async showSessionMenu(anchor: HTMLElement, evt: MouseEvent): Promise<void> {
    const conv = this.conversation;
    if (!conv) return;
    const sessions = await this.plugin.listVaultSessions();
    const menu = new Menu();

    const currentFile = conv.sessionFile;
    const shown = sessions.slice(0, 12);
    for (const s of shown) {
      const label = sessionMenuLabel(s);
      const active = s.file === currentFile;
      menu.addItem((item) => {
        item.setTitle(label);
        if (active) item.setChecked(true);
        item.onClick(() => void conv.switchSession(s.file));
        return item;
      });
    }

    menu.addItem((item) =>
      item
        .setSection("more")
        .setTitle("Browse all sessions…")
        .setIcon("search")
        .onClick(() => {
          const modal = new ResumeSessionModal(this.app, sessions, (s) => void conv.switchSession(s.file));
          modal.open();
        }),
    );
    menu.addItem((item) =>
      item
        .setSection("more")
        .setTitle("New chat in this tab")
        .setIcon("plus")
        .onClick(() => void conv.newSession()),
    );

    if (evt) {
      menu.showAtMouseEvent(evt);
    } else {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }
  }

  private showMenu(anchor: HTMLElement, evt?: MouseEvent): void {
    const conv = this.conversation;
    if (!conv) return;
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("New chat in this tab")
        .setIcon("plus")
        .onClick(() => void conv.newSession()),
    );
    menu.addItem((item) =>
      item
        .setTitle("Rename session…")
        .setIcon("pencil")
        .onClick(() => {
          this.showRename();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Session info…")
        .setIcon("info")
        .onClick(() => {
          void conv.getStats().then((stats) => {
            new SessionInfoModal(this.app, stats, conv.state.sessionName ?? "Session info").open();
          });
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Export as HTML…")
        .setIcon("file-code")
        .onClick(() => {
          const folder = this.plugin.settings.exportFolder;
          void conv.exportHtml(folder).then((path) => {
            if (path) new Notice(`Session exported to ${path}`);
          });
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Abort")
        .setIcon("octagon-x")
        .onClick(() => conv.abort()),
    );
    // Open the menu at the real cursor position (or at the anchor button as a
    // fallback). A synthetic MouseEvent would open at screen origin 0,0 — the
    // far left of the window.
    if (evt) {
      menu.showAtMouseEvent(evt);
    } else {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }
  }

  private openVaultFile(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice(`Not a vault file: ${path}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolIconFor(name: string): string {
  switch (name) {
    case "bash":
      return "terminal";
    case "edit":
      return "pencil";
    case "write":
      return "file-plus";
    case "read":
      return "file-text";
    case "glob":
      return "search";
    case "grep":
      return "search";
    case "list":
      return "list";
    default:
      return "wrench";
  }
}

/** Compact label for the session picker menu: the session's tab name.
 *  Tab names come from the Rename button (pi's session_info name). Unnamed
 *  sessions show a clean placeholder instead of raw message content. */
function sessionMenuLabel(s: { name?: string; id: string; mtime: number }): string {
  const label = s.name && s.name.length > 0 ? s.name : "Unnamed session";
  const date = new Date(s.mtime).toLocaleDateString();
  return `${label}  ·  ${date}`;
}

function statusTextFor(status: ToolCallUi["status"]): string {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "…";
    case "success":
      return "✓";
    case "error":
      return "✗";
  }
}

/** Extract a vault-relative file path from edit/write tool args. */
function filePathFromTool(name: string, args: string): string | null {
  if (name !== "edit" && name !== "write") return null;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (typeof parsed.path === "string" && parsed.path.length > 0) return parsed.path;
  } catch {
    /* ignore */
  }
  return null;
}
