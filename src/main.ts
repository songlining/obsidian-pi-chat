/**
 * Pi Chat — Obsidian plugin.
 *
 * Thin shell over the user's local `pi` binary (RPC mode). One `pi --mode rpc`
 * subprocess per open conversation leaf, spawned with cwd = vault root and the
 * login-shell environment so ~/.pi providers, auth, models, extensions, skills
 * and sessions work exactly as in the terminal.
 */
import { Plugin, Notice, TFile } from "obsidian";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { PiChatView, VIEW_TYPE_PI_CHAT } from "./pi-chat-view";
import { Conversation } from "./conversation";
import { detectPi, getPiVersion, type PiEnvironment } from "./env";
import { getSessionDir } from "./session-store";
import {
  createConversationRecord,
  newConversationId,
  sortConversations,
  type ConversationRecord,
} from "./conversation-store";
import { DEFAULT_SETTINGS, PiChatSettingTab, type PiChatSettings } from "./modals";

interface ConversationEntry {
  conversation: Conversation;
  sessionArg?: string[];
  views: Set<PiChatView>;
}

export default class PiChatPlugin extends Plugin {
  settings: PiChatSettings = { ...DEFAULT_SETTINGS };
  piEnv: PiEnvironment | null = null;
  private conversations = new Map<string, ConversationEntry>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, this.settings);

    this.registerView(VIEW_TYPE_PI_CHAT, (leaf) => new PiChatView(leaf, this));

    this.addRibbonIcon("bot-message-square", "Pi Chat — new conversation", () => void this.openNewChat());
    this.addCommand({
      id: "new-chat",
      name: "Pi Chat: New conversation",
      callback: () => void this.openNewChat(),
    });
    this.addCommand({
      id: "ask-about-selection",
      name: "Pi Chat: Ask Pi about the selection",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "E" }],
      editorCallback: (editor, view) => void this.openSelectionPrompt(editor, view),
    });
    // Right-click a selection in any note → “Ask Pi about selection”.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        menu.addItem((item) =>
          item
            .setTitle("Ask Pi about selection")
            .setIcon("bot-message-square")
            .onClick(() => void this.openSelectionPrompt(editor, view)),
        );
      }),
    );
    // Right-click a note in the file explorer (or its tab header) → the note's
    // content becomes part of the Pi Chat context.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        menu.addItem((item) =>
          item
            .setTitle("Ask Pi about this note")
            .setIcon("bot-message-square")
            .onClick(() => void this.openNotePrompt(file)),
        );
      }),
    );

    this.addSettingTab(new PiChatSettingTab(this.app, this, this.settings, (s) => void this.saveSettings()));

    // Detect pi lazily in the background; do not block plugin load.
    void this.ensurePiEnv();
  }

  onunload(): void {
    for (const entry of this.conversations.values()) {
      entry.conversation.dispose();
    }
    this.conversations.clear();
  }

  // -------------------------------------------------------------------------
  // Pi environment
  // -------------------------------------------------------------------------

  async ensurePiEnv(): Promise<PiEnvironment | null> {
    if (this.piEnv) return this.piEnv;
    this.piEnv = await detectPi(this.settings.piPath);
    if (this.piEnv.binaryPath) {
      this.piEnv.version = await getPiVersion(this.piEnv.binaryPath, this.piEnv.env);
      console.info(
        `[pi-chat] using pi ${this.piEnv.version} at ${this.piEnv.binaryPath}`,
        ...this.piEnv.diagnostics,
      );
    }
    return this.piEnv;
  }

  get piBinaryPath(): string | null {
    return this.piEnv?.binaryPath ?? null;
  }

  // -------------------------------------------------------------------------
  // Conversation registry
  // -------------------------------------------------------------------------

  getConversation(id: string): ConversationRecord | undefined {
    return this.settings.conversations.find((c) => c.id === id);
  }

  listConversations(): ConversationRecord[] {
    return sortConversations(this.settings.conversations);
  }

  /** Create and persist a fresh, empty conversation. */
  createConversation(): ConversationRecord {
    const record = createConversationRecord();
    this.settings.conversations.push(record);
    void this.saveSettings();
    return record;
  }

  /**
   * Conversation id for a pane that has none: reuse the most recent existing
   * conversation so restarts with a stale layout don't spawn new unnamed
   * ones. Only creates when the registry is completely empty.
   */
  reuseOrCreateConversationId(): string {
    const existing = this.listConversations()[0];
    return existing ? existing.id : this.createConversation().id;
  }

  renameConversation(id: string, name: string): void {
    const record = this.getConversation(id);
    if (!record) return;
    record.name = name.trim();
    record.updatedAt = Date.now();
    void this.saveSettings();
  }

  /** Record which Pi session a conversation now contains. */
  setConversationSession(id: string, file: string): void {
    const record = this.getConversation(id);
    if (!record) return;
    if (record.sessionFile === file) return;
    record.sessionFile = file;
    record.updatedAt = Date.now();
    void this.saveSettings();
  }

  /** Remove a conversation (and its contained Pi session file) from the registry. */
  deleteConversation(id: string): void {
    this.settings.conversations = this.settings.conversations.filter((c) => c.id !== id);
    void this.saveSettings();
  }

  /**
   * Delete a Pi session file owned by a conversation. Only files inside the
   * vault's session directory are touched, never anything else.
   */
  async deleteConversationFile(file: string): Promise<void> {
    const dir = getSessionDir(this.getVaultPath());
    if (!file.startsWith(dir + "/") || !file.endsWith(".jsonl")) {
      throw new Error(`Refusing to delete ${file}: outside session dir`);
    }
    await rm(file, { force: true });
  }

  // -------------------------------------------------------------------------
  // Conversation lifecycle
  // -------------------------------------------------------------------------

  /**
   * Get (or create) the conversation wrapper for a conversation id and attach
   * a view. Resolves the id to a registry record: a conversation that has
   * already contained a Pi session resumes that file; a fresh one spawns a new
   * Pi session on first message.
   */
  async getOrCreateConversation(
    id: string,
    opts: { view: PiChatView; force?: boolean },
  ): Promise<Conversation | null> {
    const env = await this.ensurePiEnv();
    if (!env?.binaryPath) {
      new Notice("Pi binary not found. Configure it in Pi Chat settings.");
      return null;
    }

    // Unknown id (e.g. leftover leaf from an old layout): create a record so
    // the pane stays bound to something in the registry.
    let record = this.getConversation(id);
    if (!record) {
      record = createConversationRecord(id);
      this.settings.conversations.push(record);
      void this.saveSettings();
    }

    let entry = this.conversations.get(id);
    if (entry && !opts.force && entry.conversation.session.isAlive) {
      entry.views.add(opts.view);
      return entry.conversation;
    }

    if (entry) {
      // Dead conversation: tear it down before recreating.
      entry.conversation.dispose();
    } else {
      entry = { conversation: null as unknown as Conversation, views: new Set() };
      this.conversations.set(id, entry);
    }

    const resolvedArg = record.sessionFile ? ["--session", record.sessionFile] : undefined;
    const vaultPath = this.getVaultPath();
    const contextAppend = this.getShadowedContextFile(vaultPath);
    const conversation = new Conversation(
      id,
      {
        binaryPath: env.binaryPath,
        cwd: vaultPath,
        env: env.env,
        sessionArg: resolvedArg,
        extraArgs: [
          ...(this.settings.extraArgs ?? []),
          // Pi loads one context file per directory (AGENTS.md preferred over
          // CLAUDE.md). If the vault has both, the vault's CLAUDE.md is shadowed
          // and never reaches the model; append it so the agent establishes its
          // full vault context.
          ...(contextAppend ? ["--append-system-prompt", contextAppend] : []),
        ],
        version: env.version ?? undefined,
      },
      {
        onSessionFile: (file) => {
          // The conversation now contains a real Pi session — persist it so
          // switching back resumes the same file.
          this.setConversationSession(id, file);
        },
        onSpawnError: (message) => {
          console.warn("[pi-chat] spawn handshake failed:", message);
        },
      },
    );

    entry.conversation = conversation;
    entry.sessionArg = resolvedArg;
    entry.views.add(opts.view);
    conversation.start();
    return conversation;
  }

  detachView(view: PiChatView): void {
    const id = view.getState().conversationId;
    if (id) this.detachViewFor(id, view);
  }

  /** Detach a view from a specific conversation (grace-disposes the subprocess). */
  detachViewFor(id: string, view: PiChatView): void {
    const entry = this.conversations.get(id);
    if (!entry) return;
    entry.views.delete(view);
    // Keep the subprocess alive briefly in case the leaf re-attaches
    // (layout switches, tab moves); dispose after a grace period.
    if (entry.views.size === 0) {
      const t = window.setTimeout(() => {
        const e = this.conversations.get(id);
        if (e && e.views.size === 0) {
          e.conversation.dispose();
          this.conversations.delete(id);
        }
      }, 5000);
      (entry as ConversationEntry & { disposeTimer?: number }).disposeTimer = t;
    }
  }

  async retryConversation(view: PiChatView): Promise<Conversation | null> {
    const id = view.getState().conversationId;
    if (!id) return null;
    // Force a fresh conversation on the same id (reuses persisted sessionArg).
    return this.getOrCreateConversation(id, { view, force: true });
  }

  // -------------------------------------------------------------------------
  // Opening leaves
  // -------------------------------------------------------------------------

  private async openLeaf(state: { conversationId?: string }): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    // If no conversation is specified, the view creates a fresh one on open.
    await leaf.setViewState({
      type: VIEW_TYPE_PI_CHAT,
      active: true,
      state: state.conversationId ? { conversationId: state.conversationId } : {},
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async openNewChat(): Promise<void> {
    await this.ensurePiEnv();
    // A brand-new conversation, bound into a fresh leaf state. Passing the id
    // explicitly matters: setViewState on a live leaf calls setState in place,
    // and without an id the current conversation would just be kept.
    const record = this.createConversation();
    const leaves = this.app.workspace.getLeavesOfType("pi-chat");
    const active = this.app.workspace.activeLeaf;
    const target =
      active && active.view instanceof PiChatView
        ? active
        : leaves.length > 0
          ? leaves[0]
          : null;
    if (target) {
      // One pane: switch it to the new conversation instead of stacking leaves.
      await this.showConversationInLeaf(target, record.id);
    } else {
      await this.openLeaf({ conversationId: record.id });
    }
  }

  /** Switch the given leaf to a conversation (re-binds the view to it). */
  async showConversationInLeaf(leaf: import("obsidian").WorkspaceLeaf, conversationId: string): Promise<void> {
    await this.ensurePiEnv();
    await leaf.setViewState({
      type: VIEW_TYPE_PI_CHAT,
      active: true,
      state: { conversationId },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Selection-pinned prompt: pre-fill the active conversation's composer with
   * the selected text (byte-exact, fenced) so the user can ask Pi to fix /
   * rewrite / summarise it. Creates a conversation if none is open.
   */
  async openSelectionPrompt(
    editor: import("obsidian").Editor,
    view: import("obsidian").MarkdownView | import("obsidian").MarkdownFileInfo,
  ): Promise<void> {
    const selection = editor.getSelection();
    if (!selection) {
      new Notice("Select some text in a note first, then ask Pi about it.");
      return;
    }
    const piChat = await this.focusPiChatPane();
    if (!piChat) return;

    const path = view.file ? view.file.path : "";
    const name = view.file ? view.file.basename : "the note";
    const preamble = path ? `Selected from [[${path}|${name}]] (${path}):\n\n` : "Selected text:\n\n";
    // Four-backtick fence keeps the selection byte-exact even if it contains ```
    const text = `${preamble}\`\`\`\`text\n${selection}\n\`\`\`\`\n\n`;
    piChat.prefillComposer(text);
    new Notice("Selection sent to Pi Chat — type what to do with it, then press Enter.");
  }

  /**
   * File-explorer variant of the same idea: right-click a note on the left →
   * "Ask Pi about this note" — the note's content becomes part of the message
   * context (capped), with its path named so pi can read the full note if asked.
   */
  async openNotePrompt(file: TFile): Promise<void> {
    const piChat = await this.focusPiChatPane();
    if (!piChat) return;

    let content = "";
    try {
      content = await this.app.vault.read(file);
    } catch {
      content = "";
    }
    const cap = 8000;
    const truncated = content.length > cap;
    if (truncated) content = content.slice(0, cap) + "\n… (truncated — pi can read the full note via its tools)";

    const name = file.basename;
    const preamble = `Selected note: [[${file.path}|${name}]] (${file.path})\n\n`;
    const text = `${preamble}\`\`\`\`text\n${content}\n\`\`\`\`\n\n`;
    piChat.prefillComposer(text);
    new Notice("Note added to Pi Chat — type what to do with it, then press Enter.");
  }

  /**
   * Ensure a Pi Chat pane exists, activate it, and return its view once the
   * composer is ready. Creates a fresh conversation when none is open.
   */
  private async focusPiChatPane(): Promise<PiChatView | null> {
    await this.ensurePiEnv();
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_CHAT)[0] ?? null;
    const active = this.app.workspace.activeLeaf;
    if (active && active.view instanceof PiChatView) leaf = active;
    if (!leaf) {
      const freshLeaf = this.app.workspace.getRightLeaf(false);
      if (!freshLeaf) {
        new Notice("Could not open the Pi Chat panel.");
        return null;
      }
      leaf = freshLeaf;
      await freshLeaf.setViewState({ type: VIEW_TYPE_PI_CHAT, active: true, state: {} });
    }
    this.app.workspace.revealLeaf(leaf);

    const piChat = leaf.view instanceof PiChatView ? leaf.view : null;
    if (!piChat) return null;
    // The view binds its DOM (and composer) synchronously on open; wait briefly
    // if the leaf was just created.
    const t0 = Date.now();
    while (!piChat.hasComposer() && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return piChat;
  }

  private getVaultPath(): string {
    // Desktop-only plugin: adapter is a FileSystemAdapter with the OS path.
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    if (adapter.getBasePath) return adapter.getBasePath();
    return this.app.vault.getRoot().path ?? "/";
  }

  /**
   * Pi's context-file discovery loads at most ONE file per directory and
   * prefers AGENTS.md over CLAUDE.md. When a vault has both at its root, the
   * vault's CLAUDE.md is shadowed. Return its path so the plugin can append
   * it explicitly (or null when pi already loads it).
   */
  private getShadowedContextFile(vaultPath: string): string | null {
    const has = (name: string) => existsSync(join(vaultPath, name));
    const agentsExists = has("AGENTS.md") || has("AGENTS.MD");
    const claudeExists = has("CLAUDE.md") || has("CLAUDE.MD");
    if (agentsExists && claudeExists) {
      return join(vaultPath, has("CLAUDE.md") ? "CLAUDE.md" : "CLAUDE.MD");
    }
    return null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
