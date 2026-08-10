import { App, Modal, Notice, Plugin, Setting, TFile } from "obsidian";

/**
 * Hand-drawn graph glyph. Injected directly so the ribbon icon is visible even
 * when a Lucide icon name fails to resolve in the host Obsidian build.
 */
const GRAPH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
  '<circle cx="5" cy="12" r="2.4" fill="currentColor" stroke="none"/>' +
  '<circle cx="12" cy="4.5" r="2.4" fill="currentColor" stroke="none"/>' +
  '<circle cx="12" cy="19.5" r="2.4" fill="currentColor" stroke="none"/>' +
  '<circle cx="19" cy="12" r="2.4" fill="currentColor" stroke="none"/>' +
  '<line x1="7.4" y1="11" x2="9.6" y2="6.9"/>' +
  '<line x1="7.4" y1="13" x2="9.6" y2="17.1"/>' +
  '<line x1="14.4" y1="6.9" x2="16.6" y2="11"/>' +
  '<line x1="14.4" y1="17.1" x2="16.6" y2="13"/>' +
  "</svg>";

/** Replace whatever icon renderer put in `el` with the hand-drawn graph glyph. */
function applyGraphIcon(el: HTMLElement): void {
  el.empty();
  el.innerHTML = GRAPH_SVG;
}

import { KnowledgeBase } from "./knowledgeBase";
import { AiService } from "./ai";
import type { FollowupGroup, FollowupQuestion } from "./ai";
import { SuggestStatusModal, SuggestTagsModal } from "./aiModals";
import { ThoughtSearchModal } from "./searchModal";
import { THOUGHT_STATUSES } from "./types";
import { GraphView, GRAPH_VIEW_TYPE } from "./graphView";
import { ChatView, CHAT_VIEW_TYPE } from "./chatView";
import { FollowUpsView, FOLLOWUPS_VIEW_TYPE } from "./followupsView";
import { BacklinksView, BACKLINKS_VIEW_TYPE } from "./backlinksView";
import { SiblingsView, SIBLINGS_VIEW_TYPE } from "./siblingsView";
import {
  CombinedSidebarView,
  COMBINED_SIDEBAR_VIEW_TYPE,
} from "./sidebarPane";
import {
  DEFAULT_SETTINGS,
  KnowledgeBrainSettingsTab,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODELS,
} from "./settings";
import type { PluginSettings, Thought } from "./types";

export default class KnowledgeBrainPlugin extends Plugin {
  private kb: KnowledgeBase;
  private ai: AiService;
  settings: PluginSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    console.log("[Knowledge Brain] onload: starting");
    await this.loadSettings();
    console.log("[Knowledge Brain] onload: settings loaded");

    this.kb = new KnowledgeBase(this.app);
    this.ai = new AiService(this.kb);
    this.kb.setDefaultFolder(this.settings.defaultFolder);
    this.kb.setTagSeparator(this.settings.tagSeparator);

    this.addSettingTab(
      new KnowledgeBrainSettingsTab(
        this.app,
        this,
        this.settings,
        async (next) => {
          const paneChanged =
            next.combineSidebarPanes !== this.settings.combineSidebarPanes;
          this.settings = next;
          this.kb.setDefaultFolder(next.defaultFolder);
          this.kb.setTagSeparator(next.tagSeparator);
          await this.saveSettings();
          if (paneChanged) {
            this.syncSidebarPanes();
          }
        },
        async () => this.resetSettings(),
      ),
    );
    console.log("[Knowledge Brain] onload: settings tab registered");

    // Register everything the user can see/interact with FIRST, before any
    // async data work. A failure while loading notes must not leave the plugin
    // without its ribbon icon, views, or commands.
    this.kb.registerHandlers();
    this.register(() => this.kb.onunload());

    this.registerView(
      GRAPH_VIEW_TYPE,
      (leaf) =>
        new GraphView(
          leaf,
          this.kb,
          this.ai,
          () => this.settings.graphSpacing,
          (v) => {
            this.settings.graphSpacing = v;
            void this.saveSettings();
          },
          () => this.settings,
          () => this.getFollowupGroups(),
        ),
    );
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) => new ChatView(leaf, this.kb, this.ai, () => this.settings),
    );
    this.registerView(BACKLINKS_VIEW_TYPE, (leaf) => new BacklinksView(leaf, this.kb));
    this.registerView(SIBLINGS_VIEW_TYPE, (leaf) => new SiblingsView(leaf, this.kb));
    this.registerView(
      COMBINED_SIDEBAR_VIEW_TYPE,
      (leaf) =>
        new CombinedSidebarView(
          leaf,
          this.kb,
          this.ai,
          () => this.settings,
          (thought, question, type) => this.askFollowup(thought, question, type),
        ),
    );
    this.registerView(
      FOLLOWUPS_VIEW_TYPE,
      (leaf) =>
        new FollowUpsView(
          leaf,
          this.kb,
          this.ai,
          () => this.settings,
          (thought, question, type) => this.askFollowup(thought, question, type),
        ),
    );

    const ribbonEl = this.addRibbonIcon("graph", "Open Knowledge Brain graph", () =>
      void this.activateView(GRAPH_VIEW_TYPE),
    );
    // Always draw our own glyph — guaranteed visible regardless of the Lucide
    // icon-name resolving in the host Obsidian build.
    applyGraphIcon(ribbonEl);

    // Status-bar launchers — always visible even when the left ribbon overflows
    // into its "..." menu.
    const statusGraph = this.addStatusBarItem();
    statusGraph.setText("KB Graph");
    statusGraph.setAttribute("title", "Open Knowledge Brain graph");
    statusGraph.addClass("kb-status");
    statusGraph.addEventListener("click", () => void this.activateView(GRAPH_VIEW_TYPE));

    const statusChat = this.addStatusBarItem();
    statusChat.setText("KB Chat");
    statusChat.setAttribute("title", "Open Knowledge Brain chat");
    statusChat.addClass("kb-status");
    statusChat.addEventListener("click", () => void this.activateView(CHAT_VIEW_TYPE));

    this.addCommand({
      id: "open-graph",
      name: "Open knowledge brain graph",
      callback: () => void this.activateView(GRAPH_VIEW_TYPE),
    });
    this.addCommand({
      id: "open-chat",
      name: "Open knowledge brain chat",
      callback: () => void this.activateView(CHAT_VIEW_TYPE),
    });
    this.addCommand({
      id: "open-followups",
      name: "Open knowledge brain follow-up questions",
      callback: () => void this.openFollowupsPane(true),
    });
    this.addCommand({
      id: "open-backlinks",
      name: "Open knowledge brain backlinks",
      callback: () => void this.openBacklinksPane(true),
    });
    this.addCommand({
      id: "open-siblings",
      name: "Open knowledge brain siblings",
      callback: () => void this.openSiblingsPane(true),
    });
    this.addCommand({
      id: "set-chat-context",
      name: "Set chat context to current note",
      callback: () => this.setContextFromActiveNote(),
    });
    this.addCommand({
      id: "create-thought",
      name: "Create new thought",
      callback: () => {
        const modal = new CreateThoughtModal(this.app, this.kb);
        modal.open();
      },
    });
    this.addCommand({
      id: "search-thoughts",
      name: "Search knowledge brain thoughts",
      callback: () => new ThoughtSearchModal(this.app, this.kb).open(),
    });
    this.addCommand({
      id: "set-thought-status",
      name: "Knowledge Brain: set status of active thought",
      callback: () => {
        const thought = this.getActiveThought();
        if (thought) {
          new SetStatusModal(this.app, this.kb, thought.id).open();
        }
      },
    });
    this.addCommand({
      id: "set-thought-tags",
      name: "Knowledge Brain: set tags of active thought",
      callback: () => {
        const thought = this.getActiveThought();
        if (thought) {
          new SetTagsModal(this.app, this.kb, thought.id).open();
        }
      },
    });
    this.addCommand({
      id: "generate-thought-tags",
      name: "Knowledge Brain: generate tags for active thought (AI)",
      callback: () => {
        const thought = this.getActiveThought();
        if (thought) {
          new SuggestTagsModal(this.app, this.kb, this.ai, () => this.settings, thought).open();
        }
      },
    });
    this.addCommand({
      id: "generate-thought-status",
      name: "Knowledge Brain: generate status for active thought (AI)",
      callback: () => {
        const thought = this.getActiveThought();
        if (thought) {
          new SuggestStatusModal(this.app, this.kb, this.ai, () => this.settings, thought).open();
        }
      },
    });
    this.addCommand({
      id: "reload-index",
      name: "Knowledge Brain: reload index",
      callback: () => void this.init(),
    });
    console.log("[Knowledge Brain] onload: views, ribbon, commands registered");

    // Load the note index without blocking registration. Failures are surfaced
    // as a Notice + console error instead of silently killing startup.
    void this.init();
    // Right-sidebar panes. onLayoutReady ensures the workspace layout exists
    // before we create leaves.
    this.app.workspace.onLayoutReady(() => {
      this.syncSidebarPanes();
    });
  }

  private async init(): Promise<void> {
    try {
      console.log("[Knowledge Brain] loading index...");
      await this.kb.load();
      console.log(
        `[Knowledge Brain] index loaded: ${this.kb.listThoughts().length} thoughts`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Knowledge Brain] failed to load index:", e);
      new Notice(`Knowledge Brain: failed to load notes — ${msg}`);
    }
  }

  onunload(): void {
    // Event refs are torn down via this.register; views detach themselves.
  }

  // ------------------------------------------------------------- views

  private async activateView(type: string): Promise<void> {
    console.log(`[Knowledge Brain] activateView('${type}') called`);
    try {
      const existing = this.app.workspace.getLeavesOfType(type);
      console.log(
        `[Knowledge Brain]   existing leaves of '${type}': ${existing.length}`,
      );
      // 'tab' always opens a dedicated, focused tab in the main area. getLeaf(false)
      // can drop the view into a sidebar panel or background tab the user misses.
      const leaf = existing[0] ?? this.app.workspace.getLeaf("tab");
      if (!leaf) {
        console.error(`[Knowledge Brain]   no leaf available for '${type}'`);
        new Notice(`Knowledge Brain: could not get a leaf for '${type}'`);
        return;
      }
      console.log(`[Knowledge Brain]   opening '${type}' in leaf`);
      await leaf.setViewState({ type, active: true });
      this.app.workspace.revealLeaf(leaf);
      console.log(`[Knowledge Brain]   '${type}' opened; leaves now:`, this.app.workspace.getLeavesOfType(type).length);
    } catch (e) {
      console.error(`[Knowledge Brain]   activateView('${type}') failed:`, e);
      new Notice(
        `Knowledge Brain: failed to open '${type}' — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private getChatView(): ChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    return leaves.length ? (leaves[0].view as ChatView) : null;
  }

  /** Follow-ups currently shown in whichever pane rendered them (or null). */
  private getFollowupGroups(): Record<FollowupGroup, FollowupQuestion[]> | null {
    const fu = this.app.workspace.getLeavesOfType(FOLLOWUPS_VIEW_TYPE)[0]?.view;
    if (fu instanceof FollowUpsView) {
      return fu.getCurrentFollowups();
    }
    const sb = this.app.workspace.getLeavesOfType(COMBINED_SIDEBAR_VIEW_TYPE)[0]?.view;
    if (sb instanceof CombinedSidebarView) {
      return sb.getCurrentFollowups();
    }
    return null;
  }

  /**
   * Merge `leaf` into the existing right-dock tab group, so a Knowledge Brain
   * pane becomes a tab beside Outline/Tags instead of a separate vertical
   * region that stays visible when another tab is active.
   */
  /**
   * Open a KB pane in the right sidebar as a tab inside the existing dock.
   * Grouping APIs (setGroupMember/setGroup) do not merge right-dock leaves in
   * this Obsidian build, so we detach any existing KB leaf and re-create it via
   * ensureSideLeaf, which Obsidian places in the right dock's tab group.
   */
  /**
   * Open a KB pane in the right sidebar as a tab. When `reveal` is false, an
   * existing tab is left untouched so Obsidian's remembered active tab (the
   * one the user last selected) stays selected — the plugin does not steal
   * focus on load. Only stale leaves outside the right dock are recreated.
   */
  private async ensurePaneInRightDock(type: string, reveal: boolean): Promise<void> {
    try {
      const existing = this.app.workspace.getLeavesOfType(type)[0];
      if (existing && existing.getRoot() === this.app.workspace.rightSplit) {
        if (reveal) {
          await this.app.workspace.revealLeaf(existing);
        }
        return;
      }
      // Remove any stale leaf (e.g. created as a separate region), then open a
      // proper right-dock tab without forcing it active.
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        leaf.detach();
      }
      await this.app.workspace.ensureSideLeaf(type, "right", {
        active: reveal,
        reveal,
        split: false,
      });
    } catch (e) {
      console.error(`[Knowledge Brain] open ${type} pane failed:`, e);
    }
  }

  private openFollowupsPane(reveal = false): Promise<void> {
    return this.ensurePaneInRightDock(
      this.settings.combineSidebarPanes ? COMBINED_SIDEBAR_VIEW_TYPE : FOLLOWUPS_VIEW_TYPE,
      reveal,
    );
  }

  /** When merging is on, both backlinks and siblings open the combined pane. */
  private openBacklinksPane(reveal = false): Promise<void> {
    return this.ensurePaneInRightDock(
      this.settings.combineSidebarPanes ? COMBINED_SIDEBAR_VIEW_TYPE : BACKLINKS_VIEW_TYPE,
      reveal,
    );
  }

  private openSiblingsPane(reveal = false): Promise<void> {
    return this.ensurePaneInRightDock(
      this.settings.combineSidebarPanes ? COMBINED_SIDEBAR_VIEW_TYPE : SIBLINGS_VIEW_TYPE,
      reveal,
    );
  }

  /**
   * Align the right-dock panes with the combine setting: detach the leaves the
   * setting no longer wants, then (re)open the right ones. When merging is on,
   * the combined pane also carries follow-ups, so the separate follow-ups tab
   * is detached. Called on startup and whenever the setting changes.
   */
  private syncSidebarPanes(): void {
    const combined = this.settings.combineSidebarPanes;
    if (combined) {
      const stale = [BACKLINKS_VIEW_TYPE, SIBLINGS_VIEW_TYPE, FOLLOWUPS_VIEW_TYPE];
      for (const type of stale) {
        for (const leaf of this.app.workspace.getLeavesOfType(type)) {
          leaf.detach();
        }
      }
      void this.ensurePaneInRightDock(COMBINED_SIDEBAR_VIEW_TYPE, false);
    } else {
      for (const leaf of this.app.workspace.getLeavesOfType(COMBINED_SIDEBAR_VIEW_TYPE)) {
        leaf.detach();
      }
      void this.openBacklinksPane();
      void this.openSiblingsPane();
      void this.openFollowupsPane();
    }
  }

  /** Open the chat view with context set to `thought` and `question` loaded. */
  private askFollowup(thought: Thought, question: string, type: string): void {
    void this.activateView(CHAT_VIEW_TYPE).then(() => {
      const chat = this.getChatView();
      if (!chat) {
        return;
      }
      chat.setContextThought(thought);
      chat.loadQuestion(question, type);
    });
  }

  /** The active markdown note, if it is indexed as a thought (else null). */
  private getActiveThought(): Thought | null {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Knowledge Brain: no active markdown note.");
      return null;
    }
    const thought = this.kb.getThought(file.basename);
    if (!thought) {
      new Notice("Knowledge Brain: the active note is not indexed as a thought.");
      return null;
    }
    return thought;
  }

  private setContextFromActiveNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Knowledge Brain: no active markdown note.");
      return;
    }
    const thought = this.kb.getThought(file.basename);
    if (!thought) {
      new Notice("Knowledge Brain: the active note is not indexed as a thought.");
      return;
    }
    const chat = this.getChatView();
    if (!chat) {
      new Notice("Knowledge Brain: open the chat view first.");
      return;
    }
    chat.setContextThought(thought);
  }

  // ---------------------------------------------------------- settings

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    // Reconcile saved settings that predate a provider's model list: if the
    // stored model is empty or unknown for the selected provider, fall back to
    // that provider's default so the settings field is never empty.
    const s = this.settings;
    const models = PROVIDER_MODELS[s.provider];
    if (!s.model || !models.includes(s.model)) {
      s.model = PROVIDER_DEFAULT_MODELS[s.provider];
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Restore all settings to their defaults and re-apply them to the KB. */
  async resetSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS };
    this.kb.setDefaultFolder(this.settings.defaultFolder);
    this.kb.setTagSeparator(this.settings.tagSeparator);
    await this.saveSettings();
    this.syncSidebarPanes();
  }
}

/** Simple modal for creating a thought with optional parents, tags, status. */
class CreateThoughtModal extends Modal {
  private kb: KnowledgeBase;
  private title = "";
  private content = "";
  private parents = "";
  private tags = "";
  private status = "";

  constructor(app: App, kb: KnowledgeBase) {
    super(app);
    this.kb = kb;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Create thought" });

    new Setting(contentEl)
      .setName("Title")
      .addText((text) =>
        text.onChange((value) => {
          this.title = value.trim();
        }),
      );

    new Setting(contentEl)
      .setName("Content")
      .addTextArea((area) => {
        area.inputEl.rows = 4;
        area.onChange((value) => {
          this.content = value;
        });
      });

    new Setting(contentEl)
      .setName("Parents")
      .setDesc("Existing thought titles, comma-separated.")
      .addText((text) =>
        text.setPlaceholder("Parent One, Parent Two").onChange((value) => {
          this.parents = value;
        }),
      );

    new Setting(contentEl)
      .setName("Tags")
      .setDesc("Comma-separated tags.")
      .addText((text) =>
        text.setPlaceholder("work, personal").onChange((value) => {
          this.tags = value;
        }),
      );

    new Setting(contentEl)
      .setName("Status")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "— none —");
        for (const s of THOUGHT_STATUSES) {
          dropdown.addOption(s, s);
        }
        dropdown.onChange((value) => {
          this.status = value;
        });
      });

    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Create").setCta().onClick(() => void this.submit()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (!this.title) {
      new Notice("Knowledge Brain: title is required.");
      return;
    }
    const parents = this.parents
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const tags = this.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    try {
      const thought = await this.kb.createThought(
        this.title,
        this.content,
        parents,
        "",
        tags,
        this.status,
      );
      new Notice(`Created "${thought.title}"`);
      this.close();
      const file = this.app.vault.getAbstractFileByPath(thought.title + ".md");
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(file);
      }
    } catch (e) {
      new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Modal for setting the workflow status of a thought. */
class SetStatusModal extends Modal {
  private kb: KnowledgeBase;
  private thoughtId: string;

  constructor(app: App, kb: KnowledgeBase, thoughtId: string) {
    super(app);
    this.kb = kb;
    this.thoughtId = thoughtId;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `Set status of "${this.thoughtId}"` });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Idea").onClick(() => void this.apply("idea")),
      )
      .addButton((button) =>
        button.setButtonText("In progress").onClick(() => void this.apply("in progress")),
      )
      .addButton((button) =>
        button.setButtonText("Done").onClick(() => void this.apply("done")),
      );
    new Setting(contentEl).addButton((button) =>
      button.setButtonText("Clear status").onClick(() => void this.apply("")),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async apply(status: string): Promise<void> {
    try {
      await this.kb.updateThought(this.thoughtId, { status });
      this.close();
    } catch (e) {
      new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Modal for setting the tags of a thought (comma-separated). */
class SetTagsModal extends Modal {
  private kb: KnowledgeBase;
  private thoughtId: string;
  private input: HTMLInputElement;

  constructor(app: App, kb: KnowledgeBase, thoughtId: string) {
    super(app);
    this.kb = kb;
    this.thoughtId = thoughtId;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `Set tags for "${this.thoughtId}"` });
    this.input = contentEl.createEl("input", {
      cls: "kb-tags-input",
      attr: { type: "text", placeholder: "work, personal, ai" },
    });
    const thought = this.kb.getThought(this.thoughtId);
    if (thought && thought.tags.length > 0) {
      this.input.value = thought.tags.join(", ");
    }
    this.input.onkeydown = (evt: KeyboardEvent) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        void this.apply();
      }
    };
    new Setting(contentEl)
      .setDesc("Comma-separated tags.")
      .addButton((button) =>
        button.setButtonText("Apply").setCta().onClick(() => void this.apply()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async apply(): Promise<void> {
    const tags = this.input.value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    try {
      await this.kb.updateThought(this.thoughtId, { tags });
      this.close();
    } catch (e) {
      new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
