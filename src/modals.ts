/**
 * Modal dialogs: resume session, model switcher, thinking-level switcher,
 * session stats, rename, and the settings tab.
 */
import {
  App,
  ButtonComponent,
  FuzzySuggestModal,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  TextComponent,
} from "obsidian";
import type { Model, SessionStatsData, SlashCommand, ThinkingLevel } from "./types";
import { sessionDisplayName, sessionSubtitle, type SessionSummary } from "./session-store";

// ---------------------------------------------------------------------------
// Slash commands (skills, templates, extension commands)
// ---------------------------------------------------------------------------

export class CommandPickerModal extends FuzzySuggestModal<SlashCommand> {
  private itemsList: SlashCommand[];
  private onChoose: (command: SlashCommand) => void;

  constructor(app: App, commands: SlashCommand[], onChoose: (command: SlashCommand) => void) {
    super(app);
    this.onChoose = onChoose;
    this.itemsList = commands;
    this.setPlaceholder("Type to filter slash commands (skills, templates, extensions)…");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "insert command" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  getItems(): SlashCommand[] {
    return this.itemsList;
  }

  getItemText(command: SlashCommand): string {
    return `${command.name} ${command.description}`;
  }

  renderSuggestion(match: import("obsidian").FuzzyMatch<SlashCommand>, el: HTMLElement): void {
    const command = match.item;
    el.empty();
    const nameEl = el.createDiv({ cls: "pi-chat-suggestion-name" });
    nameEl.setText(`/${command.name}`);
    const subEl = el.createDiv({ cls: "pi-chat-suggestion-sub" });
    subEl.setText(`${command.source}${command.description ? ` — ${command.description}` : ""}`);
  }

  onChooseItem(command: SlashCommand, _evt: MouseEvent | KeyboardEvent): void {
    this.onChoose(command);
  }
}

// ---------------------------------------------------------------------------
// Resume session
// ---------------------------------------------------------------------------

export class ResumeSessionModal extends FuzzySuggestModal<SessionSummary> {
  private itemsList: SessionSummary[];
  private onChoose: (s: SessionSummary) => void;

  constructor(app: App, items: SessionSummary[], onChoose: (s: SessionSummary) => void) {
    super(app);
    this.onChoose = onChoose;
    this.itemsList = items;
    this.setPlaceholder("Resume a Pi session…");
  }

  getItems(): SessionSummary[] {
    return this.itemsList;
  }

  getItemText(item: SessionSummary): string {
    return `${sessionDisplayName(item)} ${item.id}`;
  }

  renderSuggestion(match: import("obsidian").FuzzyMatch<SessionSummary>, el: HTMLElement): void {
    const item = match.item;
    el.empty();
    const nameEl = el.createDiv({ cls: "pi-chat-suggestion-name" });
    nameEl.setText(sessionDisplayName(item));
    const subEl = el.createDiv({ cls: "pi-chat-suggestion-sub" });
    subEl.setText(sessionSubtitle(item));
  }

  onChooseItem(item: SessionSummary, _evt: MouseEvent | KeyboardEvent): void {
    this.onChoose(item);
  }
}

// ---------------------------------------------------------------------------
// Model switcher
// ---------------------------------------------------------------------------

export class ModelSwitcherModal extends FuzzySuggestModal<Model> {
  private itemsList: Model[];
  private onChoose: (model: Model) => void;

  constructor(app: App, models: Model[], onChoose: (model: Model) => void) {
    super(app);
    this.onChoose = onChoose;
    this.itemsList = models;
    this.setPlaceholder("Switch model…");
  }

  getItems(): Model[] {
    return this.itemsList;
  }

  getItemText(model: Model): string {
    return `${model.provider}/${model.name} (${model.id})`;
  }

  renderSuggestion(match: import("obsidian").FuzzyMatch<Model>, el: HTMLElement): void {
    const model = match.item;
    el.empty();
    const nameEl = el.createDiv({ cls: "pi-chat-suggestion-name" });
    nameEl.setText(`${model.name}`);
    const subEl = el.createDiv({ cls: "pi-chat-suggestion-sub" });
    const context = model.contextWindow
      ? `context ${(model.contextWindow / 1000).toFixed(0)}k`
      : "";
    subEl.setText(`${model.provider} · ${model.id} ${context}`);
  }

  onChooseItem(model: Model, _evt: MouseEvent | KeyboardEvent): void {
    this.onChoose(model);
  }
}

// ---------------------------------------------------------------------------
// Thinking level
// ---------------------------------------------------------------------------

export class ThinkingLevelModal extends SuggestModal<ThinkingLevel> {
  private itemsList: ThinkingLevel[];
  private onChoose: (level: ThinkingLevel) => void;

  constructor(app: App, levels: ThinkingLevel[], onChoose: (level: ThinkingLevel) => void) {
    super(app);
    this.onChoose = onChoose;
    this.itemsList = levels;
    this.setPlaceholder("Thinking level…");
  }

  getSuggestions(_query: string): ThinkingLevel[] {
    return this.itemsList;
  }

  renderSuggestion(level: ThinkingLevel, el: HTMLElement): void {
    el.setText(level);
  }

  onChooseSuggestion(level: ThinkingLevel, _evt: MouseEvent | KeyboardEvent): void {
    this.onChoose(level);
  }
}

// ---------------------------------------------------------------------------
// Session info (stats)
// ---------------------------------------------------------------------------

export class SessionInfoModal extends Modal {
  constructor(app: App, stats: SessionStatsData | null, name: string) {
    super(app);
    this.titleEl.setText(name || "Session info");
    this.contentEl.addClass("pi-chat-stats-modal");

    if (!stats) {
      this.contentEl.createDiv({ text: "No session stats available." });
      return;
    }
    const rows: [string, string][] = [
      ["Messages", `${stats.userMessages} user / ${stats.assistantMessages} assistant`],
      ["Tool calls", `${stats.toolCalls} calls / ${stats.toolResults} results`],
      ["Tokens", stats.tokens ? `${stats.tokens.total.toLocaleString()} total` : "—"],
      [
        "Token breakdown",
        stats.tokens
          ? `in ${stats.tokens.input.toLocaleString()} · out ${stats.tokens.output.toLocaleString()} · cacheRead ${stats.tokens.cacheRead.toLocaleString()}`
          : "—",
      ],
      ["Cost", stats.cost != null ? `$${stats.cost.toFixed(4)}` : "—"],
    ];
    if (stats.contextUsage) {
      const pct =
        stats.contextUsage.percent != null
          ? `${stats.contextUsage.percent.toFixed(0)}%`
          : "—";
      rows.push([
        "Context window",
        `${stats.contextUsage.tokens?.toLocaleString() ?? "—"} / ${stats.contextUsage.contextWindow.toLocaleString()} (${pct})`,
      ]);
    }
    if (stats.sessionId) rows.push(["Session id", stats.sessionId]);
    if (stats.sessionFile) rows.push(["File", stats.sessionFile]);

    const table = this.contentEl.createEl("table");
    for (const [k, v] of rows) {
      const tr = table.createEl("tr");
      tr.createEl("td", { text: k, cls: "pi-chat-stats-key" });
      tr.createEl("td", { text: v });
    }
  }
}

// ---------------------------------------------------------------------------
// Rename session
// ---------------------------------------------------------------------------

export class RenameSessionModal extends Modal {
  constructor(
    app: App,
    currentName: string,
    onSubmit: (name: string) => void,
  ) {
    super(app);
    this.titleEl.setText("Rename session");

    const input = new TextComponent(this.contentEl);
    input.setPlaceholder("Session name");
    input.inputEl.addClass("pi-chat-rename-input");
    if (currentName) input.setValue(currentName);
    input.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        onSubmit(input.getValue().trim());
        this.close();
      }
    });

    const row = this.contentEl.createDiv({ cls: "pi-chat-modal-actions" });
    new ButtonComponent(row)
      .setButtonText("Cancel")
      .onClick(() => this.close());
    new ButtonComponent(row)
      .setButtonText("Rename")
      .setCta()
      .onClick(() => {
        onSubmit(input.getValue().trim());
        this.close();
      });
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface PiChatSettings {
  /** Manual pi binary path override. Empty = auto-detect. */
  piPath: string;
  /** Extra CLI args passed to `pi --mode rpc ...` (escape hatch). */
  extraArgs: string[];
  /** Folder (relative to vault) for HTML exports. */
  exportFolder: string;
  /** sessionKey -> sessionFile mapping for tab restore across restarts. */
  tabSessions: Record<string, string>;
}

export const DEFAULT_SETTINGS: PiChatSettings = {
  piPath: "",
  extraArgs: [],
  exportFolder: "pi-chat-exports",
  tabSessions: {},
};

export class PiChatSettingTab extends PluginSettingTab {
  private settings: PiChatSettings;
  private onChange: (s: PiChatSettings) => void;

  constructor(app: App, plugin: Plugin, settings: PiChatSettings, onChange: (s: PiChatSettings) => void) {
    super(app, plugin);
    this.settings = settings;
    this.onChange = onChange;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Pi Chat" });
    containerEl.createEl("p", {
      text: "Thin shell over your local pi binary. Providers, auth, models, extensions and skills come from ~/.pi — the plugin stores no keys.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Pi binary path")
      .setDesc("Leave empty to auto-detect via your login shell (recommended).")
      .addText((text) =>
        text
          .setPlaceholder("auto-detect")
          .setValue(this.settings.piPath)
          .onChange(async (value) => {
            this.settings.piPath = value;
            this.onChange(this.settings);
          }),
      );

    new Setting(containerEl)
      .setName("Extra CLI args")
      .setDesc("Extra arguments appended to `pi --mode rpc …` (e.g. --model anthropic/sonnet).")
      .addText((text) =>
        text
          .setPlaceholder("--model anthropic/sonnet")
          .setValue(this.settings.extraArgs.join(" "))
          .onChange(async (value) => {
            this.settings.extraArgs = value.split(/\s+/).filter(Boolean);
            this.onChange(this.settings);
          }),
      );

    new Setting(containerEl)
      .setName("HTML export folder")
      .setDesc("Vault-relative folder where exported session HTML files are written.")
      .addText((text) =>
        text
          .setPlaceholder("pi-chat-exports")
          .setValue(this.settings.exportFolder)
          .onChange(async (value) => {
            this.settings.exportFolder = value.trim() || "pi-chat-exports";
            this.onChange(this.settings);
          }),
      );

    containerEl.createEl("p", {
      text: "Sessions, providers and models are Pi's, not the plugin's. Resume lists this vault's sessions from ~/.pi/agent/sessions.",
      cls: "setting-item-description",
    });
  }
}
