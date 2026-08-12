import { App, Modal, normalizePath, Notice, Plugin, Setting, TFile } from "obsidian";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Build an SVG child element with the given attributes. */
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

/**
 * Hand-drawn graph glyph. Drawn via DOM so the ribbon icon is visible even when
 * a Lucide icon name fails to resolve in the host Obsidian build.
 */
function applyGraphIcon(el: HTMLElement): void {
  el.empty();
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    width: "100%",
    height: "100%",
  });
  const node = (cx: number, cy: number): SVGCircleElement =>
    svgEl("circle", {
      cx: String(cx),
      cy: String(cy),
      r: "2.4",
      fill: "currentColor",
      stroke: "none",
    });
  const link = (x1: number, y1: number, x2: number, y2: number): SVGLineElement =>
    svgEl("line", {
      x1: String(x1),
      y1: String(y1),
      x2: String(x2),
      y2: String(y2),
    });
  svg.append(
    node(5, 12),
    node(12, 4.5),
    node(12, 19.5),
    node(19, 12),
    link(7.4, 11, 9.6, 6.9),
    link(7.4, 13, 9.6, 17.1),
    link(14.4, 6.9, 16.6, 11),
    link(14.4, 17.1, 16.6, 13),
  );
  el.append(svg);
}

import { KnowledgeBase, sanitizeTitle } from "./knowledgeBase";
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
    await this.loadSettings();

    this.kb = new KnowledgeBase(this.app);
    this.ai = new AiService(this.kb);
    this.kb.setDefaultFolder(this.settings.defaultFolder);
    this.kb.setTagSeparator(this.settings.tagSeparator);

    this.addSettingTab(
      new KnowledgeBrainSettingsTab(
        this.app,
        this,
        this.settings,
        (next) => {
          const paneChanged =
            next.combineSidebarPanes !== this.settings.combineSidebarPanes;
          this.settings = next;
          this.kb.setDefaultFolder(next.defaultFolder);
          this.kb.setTagSeparator(next.tagSeparator);
          void this.saveSettings().then(() => {
            if (paneChanged) {
              // The user explicitly switched the pane mode — apply the full
              // layout (open the mode's panes), unlike a plain startup.
              this.syncSidebarPanes(true);
            }
          });
        },
        async () => this.resetSettings(),
      ),
    );

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
      name: "Open graph",
      callback: () => void this.activateView(GRAPH_VIEW_TYPE),
    });
    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => void this.activateView(CHAT_VIEW_TYPE),
    });
    this.addCommand({
      id: "open-followups",
      name: "Open follow-up questions",
      callback: () => void this.openFollowupsPane(true),
    });
    this.addCommand({
      id: "open-backlinks",
      name: "Open backlinks",
      callback: () => void this.openBacklinksPane(true),
    });
    this.addCommand({
      id: "open-siblings",
      name: "Open siblings",
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
      id: "create-thought-from-selection",
      name: "Create thought from selection",
      editorCallback: (editor, view) => {
        void this.createThoughtFromSelection(editor.getSelection(), view.file);
      },
    });
    this.addCommand({
      id: "copy-thought-link",
      name: "Copy link to active thought",
      callback: () => this.copyThoughtLink(),
    });
    this.addCommand({
      id: "search-thoughts",
      name: "Search thoughts",
      callback: () => new ThoughtSearchModal(this.app, this.kb).open(),
    });
    this.addCommand({
      id: "set-thought-status",
      name: "Set status of active thought",
      callback: () => {
        const thought = this.getActiveThought();
        if (thought) {
          new SetStatusModal(this.app, this.kb, thought.id).open();
        }
      },
    });
    this.addCommand({
      id: "set-thought-tags",
      name: "Set tags of active thought",
      callback: () => {
        const thought = this.getActiveThought();
        if (thought) {
          new SetTagsModal(this.app, this.kb, thought.id).open();
        }
      },
    });
    this.addCommand({
      id: "generate-thought-tags",
      name: "Generate tags for active thought (AI)",
      callback: () => {
        const thought = this.getActiveThought();
        if (thought) {
          new SuggestTagsModal(this.app, this.kb, this.ai, () => this.settings, thought).open();
        }
      },
    });
    this.addCommand({
      id: "generate-thought-status",
      name: "Generate status for active thought (AI)",
      callback: () => {
        const thought = this.getActiveThought();
        if (thought) {
          new SuggestStatusModal(this.app, this.kb, this.ai, () => this.settings, thought).open();
        }
      },
    });
    this.addCommand({
      id: "reload-index",
      name: "Reload index",
      callback: () => void this.init(),
    });

    // Load the note index without blocking registration. Failures are surfaced
    // as a Notice + console error instead of silently killing startup.
    void this.init();
    // Right-sidebar panes. onLayoutReady ensures the workspace layout exists
    // before we create leaves. On startup we only enforce the combine mode —
    // panes the user has closed must not be re-opened (openSeparatePanes=false).
    this.app.workspace.onLayoutReady(() => {
      this.syncSidebarPanes(false);
    });
  }

  private async init(): Promise<void> {
    try {
      await this.kb.load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Knowledge Brain: failed to load notes — ${msg}`);
    }
  }

  onunload(): void {
    // Event refs are torn down via this.register; views detach themselves.
  }

  // ------------------------------------------------------------- views

  private async activateView(type: string): Promise<void> {
    try {
      const existing = this.app.workspace.getLeavesOfType(type);
      // 'tab' always opens a dedicated, focused tab in the main area. getLeaf(false)
      // can drop the view into a sidebar panel or background tab the user misses.
      const leaf = existing[0] ?? this.app.workspace.getLeaf("tab");
      if (!leaf) {
        new Notice(`Knowledge Brain: could not get a leaf for '${type}'`);
        return;
      }
      await leaf.setViewState({ type, active: true });
      await this.app.workspace.revealLeaf(leaf);
    } catch (e) {
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
   * Open a KB pane in the right sidebar as a tab, guaranteeing at most one leaf
   * of `type` exists there. When `reveal` is false an existing tab is left
   * untouched so Obsidian's remembered active tab (the one the user last
   * selected) stays selected — the plugin does not steal focus on load. Stray
   * leaves (floated, in another dock, or duplicates restored from a stale
   * workspace layout) are detached so a pane type never shows more than once.
   */
  private async ensurePaneInRightDock(type: string, reveal: boolean): Promise<void> {
    try {
      const leaves = this.app.workspace.getLeavesOfType(type);
      const keep = leaves[0];
      if (keep && keep.getRoot() === this.app.workspace.rightSplit) {
        for (let i = 1; i < leaves.length; i++) {
          leaves[i].detach();
        }
        if (reveal) {
          await this.app.workspace.revealLeaf(keep);
        }
        return;
      }
      // No usable right-dock tab: remove any stray leaves and open a proper
      // right-dock tab without forcing it active.
      for (const leaf of leaves) {
        leaf.detach();
      }
      await this.app.workspace.ensureSideLeaf(type, "right", {
        active: reveal,
        reveal,
        split: false,
      });
    } catch {
      // Opening a sidebar pane must never break plugin startup or settings.
    }
  }

  /**
   * Startup-only: collapse duplicate leaves of `type` to a single right-dock
   * tab. If the user has no such pane open, does nothing — a pane they closed
   * stays closed.
   */
  private tidyPane(type: string): void {
    if (this.app.workspace.getLeavesOfType(type).length > 0) {
      void this.ensurePaneInRightDock(type, false);
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
   * Align the right-dock panes with the combine setting, and collapse any
   * duplicates so a pane type never appears twice. When merging is on the
   * combined pane also carries follow-ups, so the separate follow-ups/backlinks/
   * siblings tabs are detached and the single combined tab is kept. When merging
   * is off the combined pane is removed and the separate panes are opened only
   * when `openSeparatePanes` is true — that is, when the user just switched the
   * mode in settings. On startup it stays false: existing panes are deduplicated
   * (a stale workspace layout can restore several copies) but none are re-opened,
   * so tabs the user has closed stay closed.
   */
  private syncSidebarPanes(openSeparatePanes: boolean): void {
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
      if (openSeparatePanes) {
        void this.openBacklinksPane();
        void this.openSiblingsPane();
        void this.openFollowupsPane();
      } else {
        // Startup: dedupe any panes restored from the layout, but do not create
        // panes the user has closed.
        this.tidyPane(BACKLINKS_VIEW_TYPE);
        this.tidyPane(SIBLINGS_VIEW_TYPE);
        this.tidyPane(FOLLOWUPS_VIEW_TYPE);
      }
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

  /** Create a new thought whose content is the selected text (title from its first line). */
  private async createThoughtFromSelection(
    selection: string,
    file: TFile | null,
  ): Promise<void> {
    const content = selection.trim();
    if (!content) {
      new Notice("Knowledge Brain: select some text in a note first.");
      return;
    }
    const title = sanitizeTitle(
      content
        .split("\n")[0]
        .replace(/^#+\s*/, "")
        .replace(/[*_`~]/g, "")
        .trim()
        .slice(0, 60),
    );
    const uniqueTitle = this.uniqueThoughtTitle(title);
    // Optionally file the new thought under the note the text was selected from.
    const parentId = file?.basename ?? "";
    const parents =
      parentId && parentId !== uniqueTitle && this.kb.getThought(parentId)
        ? [parentId]
        : [];
    try {
      const thought = await this.kb.createThought(uniqueTitle, content, parents, "", [], "");
      new Notice(`Created "${thought.title}"`);
      const path = normalizePath(
        this.settings.defaultFolder
          ? `${this.settings.defaultFolder}/${thought.title}.md`
          : `${thought.title}.md`,
      );
      const created = this.app.vault.getAbstractFileByPath(path);
      if (created instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(created);
      }
    } catch (e) {
      new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private uniqueThoughtTitle(title: string): string {
    if (!this.kb.getThought(title)) {
      return title;
    }
    let n = 2;
    while (this.kb.getThought(`${title} ${n}`)) {
      n++;
    }
    return `${title} ${n}`;
  }

  /** Copy a [[wikilink]] to the active markdown note. */
  private copyThoughtLink(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Knowledge Brain: no active markdown note.");
      return;
    }
    const link = `[[${file.basename}]]`;
    void navigator.clipboard.writeText(link).then(
      () => new Notice(`Copied ${link}`),
      () => new Notice("Knowledge Brain: could not copy to clipboard."),
    );
  }

  // ---------------------------------------------------------- settings

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
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
    this.syncSidebarPanes(true);
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
