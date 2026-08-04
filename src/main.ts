/**
 * Pi Chat — Obsidian plugin.
 *
 * Thin shell over the user's local `pi` binary (RPC mode). One `pi --mode rpc`
 * subprocess per open conversation leaf, spawned with cwd = vault root and the
 * login-shell environment so ~/.pi providers, auth, models, extensions, skills
 * and sessions work exactly as in the terminal.
 */
import { Plugin, Notice } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import { PiChatView, VIEW_TYPE_PI_CHAT } from "./pi-chat-view";
import { Conversation } from "./conversation";
import { detectPi, getPiVersion, type PiEnvironment } from "./env";
import { listSessions } from "./session-store";
import { DEFAULT_SETTINGS, PiChatSettingTab, type PiChatSettings } from "./modals";
import { ResumeSessionModal } from "./modals";

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

    this.addRibbonIcon("bot", "Pi Chat — new conversation", () => void this.openNewChat());
    this.addCommand({
      id: "new-chat",
      name: "Pi Chat: New conversation",
      callback: () => void this.openNewChat(),
    });
    this.addCommand({
      id: "resume-session",
      name: "Pi Chat: Resume session…",
      callback: () => void this.openResumeModal(),
    });
    this.addCommand({
      id: "continue-last",
      name: "Pi Chat: Continue last session",
      callback: () => void this.openContinueLast(),
    });

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
  // Conversation lifecycle
  // -------------------------------------------------------------------------

  /**
   * Get (or create) the conversation for a session key and attach a view.
   */
  async getOrCreateConversation(
    key: string,
    opts: { sessionArg?: string[]; view: PiChatView; force?: boolean },
  ): Promise<Conversation | null> {
    const env = await this.ensurePiEnv();
    if (!env?.binaryPath) {
      new Notice("Pi binary not found. Configure it in Pi Chat settings.");
      return null;
    }

    let entry = this.conversations.get(key);
    if (entry && !opts.force && entry.conversation.session.isAlive) {
      entry.views.add(opts.view);
      return entry.conversation;
    }

    if (entry) {
      // Dead conversation: tear it down before recreating.
      entry.conversation.dispose();
    } else {
      entry = { conversation: null as unknown as Conversation, views: new Set() };
      this.conversations.set(key, entry);
    }

    const persisted = this.settings.tabSessions[key];
    const resolvedArg = opts.sessionArg ?? (persisted ? ["--session", persisted] : undefined);
    const vaultPath = this.getVaultPath();
    const contextAppend = this.getShadowedContextFile(vaultPath);
    const conversation = new Conversation(
      key,
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
          // Persist the tab -> session mapping so restarts resume the same file.
          this.settings.tabSessions[key] = file;
          void this.saveSettings();
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
    const key = view.getState().sessionKey;
    if (!key) return;
    const entry = this.conversations.get(key);
    if (!entry) return;
    entry.views.delete(view);
    // Keep the subprocess alive briefly in case the leaf re-attaches
    // (layout switches, tab moves); dispose after a grace period.
    if (entry.views.size === 0) {
      const t = window.setTimeout(() => {
        const e = this.conversations.get(key);
        if (e && e.views.size === 0) {
          e.conversation.dispose();
          this.conversations.delete(key);
        }
      }, 5000);
      (entry as ConversationEntry & { disposeTimer?: number }).disposeTimer = t;
    }
  }

  async retryConversation(view: PiChatView): Promise<Conversation | null> {
    const key = view.getState().sessionKey;
    if (!key) return null;
    // Force a fresh conversation on the same key (reuses persisted sessionArg).
    return this.getOrCreateConversation(key, { view, force: true });
  }

  // -------------------------------------------------------------------------
  // Opening leaves
  // -------------------------------------------------------------------------

  private async openLeaf(state: { sessionKey?: string; sessionArg?: string[] }): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    const sessionKey = state.sessionKey ?? `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await leaf.setViewState({
      type: VIEW_TYPE_PI_CHAT,
      active: true,
      state: { ...state, sessionKey },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async openNewChat(): Promise<void> {
    await this.ensurePiEnv();
    await this.openLeaf({});
  }

  async openContinueLast(): Promise<void> {
    await this.ensurePiEnv();
    await this.openLeaf({ sessionArg: ["-c"] });
  }

  async openResumeModal(): Promise<void> {
    const env = await this.ensurePiEnv();
    if (!env?.binaryPath) {
      new Notice("Pi binary not found. Configure it in Pi Chat settings.");
      return;
    }
    const sessions = await listSessions(this.getVaultPath());
    if (sessions.length === 0) {
      new Notice("No Pi sessions found for this vault.");
      return;
    }
    const modal = new ResumeSessionModal(this.app, sessions, (s) => {
      void this.openLeaf({ sessionArg: ["--session", s.file] });
    });
    modal.open();
  }

  private getVaultPath(): string {
    // Desktop-only plugin: adapter is a FileSystemAdapter with the OS path.
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    if (adapter.getBasePath) return adapter.getBasePath();
    return this.app.vault.getRoot().path ?? "/";
  }

  /** List this vault's Pi sessions (newest first), for resume and the picker. */
  async listVaultSessions(): Promise<Awaited<ReturnType<typeof listSessions>>> {
    return listSessions(this.getVaultPath());
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
