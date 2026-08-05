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
import { conversationLabel } from "./conversation-store";
import type { ExtensionUiRequest, ImageContent, ThinkingLevel } from "./types";
import {
  CommandPickerModal,
  ConfirmModal,
  ModelSwitcherModal,
  RenameSessionModal,
  SessionInfoModal,
  ThinkingLevelModal,
} from "./modals";

export const VIEW_TYPE_PI_CHAT = "pi-chat";

const RENDER_THROTTLE_MS = 100;

interface ViewStatePayload {
  conversationId?: string;
  [key: string]: unknown;
}

export class PiChatView extends ItemView {
  plugin: PiChatPlugin;
  conversation: Conversation | null = null;
  /** View state (conversationId) kept in sync with the leaf's ViewState. */
  private viewState: ViewStatePayload = {};

  private headerEl!: HTMLElement;
  private nameInputEl!: HTMLInputElement;
  private messagesEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private tabPickerEl!: HTMLButtonElement;
  private tabPickerLabel!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: ButtonComponent;
  private stopBtn!: ButtonComponent;
  private previewBarEl!: HTMLElement;
  /** Pasted images awaiting send. */
  private pastedImages: ImageContent[] = [];
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
    const record = this.currentRecord();
    if (record) return conversationLabel(record);
    return this.conversation?.state.sessionName || "Pi Chat";
  }

  /** The registry record this view is bound to, if any. */
  private currentRecord(): import("./conversation-store").ConversationRecord | undefined {
    const id = this.getState().conversationId;
    return id ? this.plugin.getConversation(id) : undefined;
  }

  getIcon(): string {
    return "bot-message-square";
  }

  getState(): ViewStatePayload {
    return this.viewState;
  }

  async setState(state: unknown, result: import("obsidian").ViewStateResult): Promise<void> {
    const incoming = (state as ViewStatePayload) ?? {};
    // Layout restore often delivers {} — keep the id this view bound during
    // onOpen so it gets persisted on the next layout save.
    if (!incoming.conversationId && this.viewState.conversationId) {
      incoming.conversationId = this.viewState.conversationId;
    }
    this.viewState = incoming;
    await super.setState(state, result);
    // Obsidian calls onOpen before setState for new views. If the leaf's state
    // arrives pointing at a different conversation than the one this view
    // bound during onOpen, re-bind so the pane shows the intended one.
    if (incoming.conversationId && this.conversation && this.conversation.key !== incoming.conversationId) {
      await this.rebindConversation(incoming.conversationId);
    }
  }

  /** Swap this view to a different conversation (same leaf, fresh subprocess). */
  private async rebindConversation(id: string): Promise<void> {
    const oldId = this.conversation?.key;
    this.viewState = { conversationId: id };
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubNotif?.();
    this.unsubNotif = null;
    if (oldId && oldId !== id) {
      this.plugin.detachViewFor(oldId, this);
      // If the previous id was only a placeholder created while opening (no
      // session, no name), drop it instead of leaving an empty registry entry.
      const old = this.plugin.getConversation(oldId);
      if (old && !old.sessionFile && !old.name) this.plugin.deleteConversation(oldId);
    }
    const conv = await this.plugin.getOrCreateConversation(id, { view: this, force: true });
    if (!conv) return;
    this.conversation = conv;
    this.renderLayout();
    this.unsubscribe = conv.subscribe((s) => this.render(s));
    this.unsubNotif = conv.onUiNotification((req) => this.handleUiNotification(req));
    void conv.loadHistory().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async onOpen(): Promise<void> {
    const state = this.getState();
    // A pane always displays one conversation. If the leaf has none yet (e.g.
    // an old layout), create a fresh registry entry so we never bind outside
    // the plugin's own list.
    const conversationId =
      state.conversationId ?? this.plugin.createConversation().id;
    // Persist a generated id back into the view state so layout saves restore
    // this same conversation.
    if (!state.conversationId) this.viewState = { ...this.viewState, conversationId };

    this.conversation = await this.plugin.getOrCreateConversation(conversationId, {
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
    // Escape aborts a running agent turn from anywhere in the view.
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const conv = this.conversation;
      if (conv && conv.state.isRunning) {
        e.preventDefault();
        e.stopPropagation();
        conv.abort();
      }
    });
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
      // Rename box: bottom-left, same level as the pickers.
      const rename = bar.createDiv({ cls: "pi-chat-status-rename" });
      const icon = rename.createSpan({ cls: "pi-chat-name-icon" });
      setIcon(icon, "pencil");
      this.nameInputEl = rename.createEl("input", {
        cls: "pi-chat-name-input",
        attr: { placeholder: "Conversation name — click to rename", spellcheck: "false" },
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

      this.statusEl = bar.createDiv({ cls: "pi-chat-status" });
      const actions = bar.createDiv({ cls: "pi-chat-status-actions" });

      // Tab/session picker (bottom-right): which session this pane shows.
      // The pane is one leaf; the picker's entries are named sessions that
      // get switched in place (switch_session) — like Claudian's list.
      this.tabPickerEl = actions.createEl("button", { cls: "pi-chat-tab-picker" });
      this.tabPickerLabel = this.tabPickerEl.createSpan({ cls: "pi-chat-tab-picker-label" });
      const tabIcon = this.tabPickerEl.createSpan({ cls: "pi-chat-tab-picker-icon" });
      setIcon(tabIcon, "hash");
      this.tabPickerEl.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.showTabMenu(this.tabPickerEl, e);
      });
    });

    root.createDiv({ cls: "pi-chat-preview-bar" }, (bar) => {
      this.previewBarEl = bar;
      bar.hide();
    });

    root.createDiv({ cls: "pi-chat-input-bar" }, (bar) => {
      this.inputEl = bar.createEl("textarea", {
        cls: "pi-chat-input",
        attr: { placeholder: "Message Pi… (Enter to send, / for commands, Shift+Enter for newline)", rows: "2" },
      });
      this.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.sendCurrentInput();
        } else if (e.key === "/") {
          // Type "/" at the start of a message (or after whitespace) to
          // browse slash commands (skills, templates, extension commands).
          // keydown fires before the character lands, so check the value
          // that will precede it.
          const value = this.inputEl.value;
          if (value.length === 0 || /\s$/.test(value)) {
            void this.openCommandPicker();
          }
        }
      });

      // Paste support: image files from the clipboard become attachments.
      this.inputEl.addEventListener("paste", (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const imageItems = Array.from(items).filter((i) => i.type.startsWith("image/"));
        if (imageItems.length === 0) return;
        e.preventDefault();
        for (const item of imageItems) {
          const file = item.getAsFile();
          if (!file) continue;
          if (this.pastedImages.length >= 4) {
            new Notice("Max 4 images per message.");
            break;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const data = String(reader.result).split(",")[1] ?? "";
            if (!data) return;
            this.pastedImages = [
              ...this.pastedImages,
              { type: "image", data, mimeType: file.type || "image/png" },
            ];
            this.renderPastedImages();
          };
          reader.readAsDataURL(file);
        }
      });
      this.sendBtn = new ButtonComponent(bar).setButtonText("Send").setCta();
      this.sendBtn.buttonEl.addClass("pi-chat-send-btn");
      this.sendBtn.onClick(() => this.sendCurrentInput());

      // Stop button: visible only while the agent is running.
      this.stopBtn = new ButtonComponent(bar).setButtonText("Stop").setWarning();
      this.stopBtn.buttonEl.addClass("pi-chat-stop-btn");
      this.stopBtn.buttonEl.setAttribute("title", "Abort (Esc)");
      this.stopBtn.onClick(() => void this.conversation?.abort());
      this.stopBtn.buttonEl.hide();
    });

    this.messagesEl.createDiv({
      cls: "pi-chat-welcome",
      text: "Start typing to begin a new conversation, or pick an existing conversation from the picker (bottom-right).",
    });
  }

  // -------------------------------------------------------------------------
  // State -> DOM
  // -------------------------------------------------------------------------

  private render(state: UiState): void {
    // Stop button shows only while the agent is running.
    this.stopBtn.buttonEl.style.cssText = state.isRunning ? "" : "display: none";

    // The conversation record is the source of truth for the name (a fresh
    // conversation has no Pi session name yet, but the user may have renamed
    // it). Fall back to the Pi session name when there's no record.
    const record = this.currentRecord();
    const convName = record ? conversationLabel(record) : state.sessionName;

    // Header + tab title (tab names come from the Rename button)
    const title = convName || "Pi Chat";
    if (this.headerTitleEl.getText() !== title) this.headerTitleEl.setText(title);
    if (this.headerTitleEl.getAttribute("data-name") !== (record?.name ?? state.sessionName ?? "")) {
      this.headerTitleEl.setAttribute("data-name", record?.name ?? state.sessionName ?? "");
    }
    // Refresh the visible tab label whenever the session name changes.
    if (this.lastTabTitle !== title) {
      this.lastTabTitle = title;
      (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    }

    this.modelChipEl.setText(state.model ? `${state.model.provider}/${state.model.name}` : "model…");
    this.thinkingChipEl.setText(state.thinkingLevel ? `thinking: ${state.thinkingLevel}` : "thinking…");

    // Tab picker (bottom-right, left): the conversation's name.
    this.tabPickerLabel.setText(convName || "Unnamed");
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
    const id = this.getState().conversationId;
    if (!id) return;
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
      text: "Start typing to begin a new conversation, or pick an existing conversation from the picker (bottom-right).",
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
        this.renderMessageImages(el, message);
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
    const images = this.pastedImages.length > 0 ? this.pastedImages : undefined;
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.pastedImages = [];
    this.renderPastedImages();
    void conv.prompt(text, images);
  }

  /** Rebuild the pasted-image preview strip above the composer. */
  private renderPastedImages(): void {
    this.previewBarEl.empty();
    if (this.pastedImages.length === 0) {
      this.previewBarEl.hide();
      return;
    }
    this.previewBarEl.show();
    this.pastedImages.forEach((img, i) => {
      const wrap = this.previewBarEl.createDiv({ cls: "pi-chat-preview" });
      const el = wrap.createEl("img", {
        cls: "pi-chat-preview-img",
        attr: { src: `data:${img.mimeType};base64,${img.data}` },
      });
      const remove = wrap.createEl("button", { cls: "pi-chat-preview-remove" });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        this.pastedImages = this.pastedImages.filter((_, idx) => idx !== i);
        this.renderPastedImages();
      });
    });
  }

  /** Render pasted-image thumbnails inside a user message row. */
  private renderMessageImages(el: HTMLElement, message: UiMessage): void {
    if (!message.images || message.images.length === 0) return;
    let imagesEl = el.querySelector<HTMLElement>(".pi-chat-msg-images");
    if (!imagesEl) {
      imagesEl = el.createDiv({ cls: "pi-chat-msg-images" });
    } else {
      imagesEl.empty();
    }
    for (const img of message.images) {
      imagesEl.createEl("img", {
        cls: "pi-chat-msg-image",
        attr: { src: `data:${img.mimeType};base64,${img.data}` },
      });
    }
  }

  /** Open the slash-command picker; insert the chosen command into the input. */
  private async openCommandPicker(): Promise<void> {
    const conv = this.conversation;
    if (!conv) return;
    let commands: import("./types").SlashCommand[] = [];
    try {
      commands = await conv.getCommands();
    } catch {
      return; // session not ready yet
    }
    if (commands.length === 0) return;
    new CommandPickerModal(this.app, commands, (command) => {
      // Replace the trailing "/" (and any partial command the user typed in
      // the modal's own search box) with the full chosen command.
      const value = this.inputEl.value;
      const slashIdx = value.lastIndexOf("/");
      this.inputEl.value =
        (slashIdx >= 0 ? value.slice(0, slashIdx + 1) : value) + command.name;
      this.inputEl.focus();
      this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
    }).open();
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
    const record = this.currentRecord();
    const currentName = record?.name || conv.state.sessionName || "";
    new RenameSessionModal(
      this.app,
      currentName,
      (name) => void this.renameConversation(name),
    ).open();
  }

  /** Rename the current conversation (registry + its contained Pi session). */
  private renameConversation(name: string): void {
    const conv = this.conversation;
    if (!conv) return;
    const id = this.getState().conversationId;
    if (id) this.plugin.renameConversation(id, name);
    void conv.rename(name);
    // The record is the label source now; reflect the rename immediately even
    // if the Pi session name hasn't propagated (fresh conversations).
    this.render(conv.state);
  }

  private applyRenameFromInput(): void {
    const conv = this.conversation;
    if (!conv) return;
    const value = this.nameInputEl.value.trim();
    if (value && value !== conv.state.sessionName) {
      this.renameConversation(value);
    } else {
      this.revertNameInput();
    }
  }

  private revertNameInput(): void {
    if (this.conversation) this.nameInputEl.value = this.conversation.state.sessionName || "";
    this.nameInputEl.blur();
  }

  /** Bottom-right tab picker: the pane's sessions ("tabs"), switched in place. */
  /** Bottom-right picker: the plugin's conversations, managed here. */
  private async showTabMenu(anchor: HTMLElement, evt?: MouseEvent): Promise<void> {
    const conv = this.conversation;
    if (!conv) return;
    const currentId = this.getState().conversationId;
    const records = this.plugin.listConversations();
    const menu = new Menu();

    // Every plugin-owned conversation (newest first). Picking one switches
    // this pane to it; the current one is checked.
    for (const record of records) {
      const label = conversationLabel(record);
      const active = record.id === currentId;
      menu.addItem((item) => {
        item.setTitle(label);
        if (active) item.setChecked(true);
        item.onClick(() => void this.switchToConversation(record));
        return item;
      });
    }

    menu.addItem((item) =>
      item
        .setTitle("New conversation")
        .setIcon("plus")
        .onClick(() => {
          const record = this.plugin.createConversation();
          void this.switchToConversation(record);
        }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Rename conversation…")
        .setIcon("pencil")
        .onClick(() => this.showRename()),
    );
    if (currentId) {
      menu.addItem((item) =>
        item
          .setTitle("Delete this conversation…")
          .setIcon("trash-2")
          .setWarning(true)
          .onClick(() => void this.deleteCurrentConversation()),
      );
    }
    if (evt) {
      menu.showAtMouseEvent(evt);
    } else {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }
  }

  /** Switch this pane to a conversation (re-binds the view + subprocess). */
  private async switchToConversation(record: import("./conversation-store").ConversationRecord): Promise<void> {
    const currentId = this.getState().conversationId;
    if (record.id === currentId) return;
    await this.plugin.showConversationInLeaf(this.leaf, record.id);
  }

  /** Delete the current conversation, then park the pane on another one. */
  private async deleteCurrentConversation(): Promise<void> {
    const currentId = this.getState().conversationId;
    if (!currentId) return;
    const record = this.plugin.getConversation(currentId);
    const label = record ? conversationLabel(record) : "this conversation";
    const confirmed = await new Promise<boolean>((resolve) => {
      const modal = new ConfirmModal(this.app, `Delete “${label}”?`, `Its contained Pi session file will also be removed. This cannot be undone.`, (ok) => resolve(ok));
      modal.open();
    });
    if (!confirmed) return;
    // Remove the contained Pi session file too, so the registry is the single
    // source of truth and stray sessions don't linger.
    if (record?.sessionFile) {
      try {
        await this.plugin.deleteConversationFile(record.sessionFile);
      } catch (e) {
        console.warn("[pi-chat] could not delete session file", e);
      }
    }
    this.plugin.deleteConversation(currentId);
    // Park the pane on the most recent remaining conversation. Only create a
    // fresh one when the registry would otherwise be empty — deleting must
    // never appear to create a replacement unnamed conversation.
    const remaining = this.plugin.listConversations();
    const next = remaining[0] ?? this.plugin.createConversation();
    await this.plugin.showConversationInLeaf(this.leaf, next.id);
    new Notice("Conversation deleted.");
  }

  private showMenu(anchor: HTMLElement, evt?: MouseEvent): void {
    const conv = this.conversation;
    if (!conv) return;
    const menu = new Menu();
    // The tab picker (bottom-right) already covers switching tabs, renaming
    // and new chat — this menu holds the session utilities only.
    menu.addItem((item) =>
      item
        .setTitle("Conversation info…")
        .setIcon("info")
        .onClick(() => {
          void conv.getStats().then((stats) => {
            new SessionInfoModal(this.app, stats, conv.state.sessionName ?? "Conversation info").open();
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
