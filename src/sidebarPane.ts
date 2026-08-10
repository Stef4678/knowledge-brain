import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { AiService, FOLLOWUP_GROUPS, type FollowupGroup, type FollowupQuestion } from "./ai";
import { addFollowupRow } from "./copyRow";
import { KnowledgeBase } from "./knowledgeBase";
import type { ThoughtRecord } from "./knowledgeBase";
import type { PluginSettings, Thought } from "./types";

export const COMBINED_SIDEBAR_VIEW_TYPE = "knowledge-brain-sidebar";

const GROUP_LABELS: Record<FollowupGroup, string> = {
  scientific: "Scientific",
  practical: "Practical",
  comparative: "Comparative",
  historical: "Historical",
  causal: "Causal",
  critical: "Critical",
};

/**
 * Right-sidebar pane combining backlinks, siblings, and follow-up questions of
 * the note currently open in the editor into one tab (when the "Backlinks &
 * siblings in one pane" setting is on). The container scrolls vertically when
 * the content exceeds the pane height.
 */
export class CombinedSidebarView extends ItemView {
  private kb: KnowledgeBase;
  private ai: AiService;
  private getSettings: () => PluginSettings;
  private onAsk: (thought: Thought, question: string, type: string) => void;
  private container: HTMLElement;
  private currentId = "";
  private genToken = 0;
  private followupsPaused = false;
  private lastGroups: Record<FollowupGroup, FollowupQuestion[]> | null = null;
  private unsubscribe: () => void = () => {};

  constructor(
    leaf: WorkspaceLeaf,
    kb: KnowledgeBase,
    ai: AiService,
    getSettings: () => PluginSettings,
    onAsk: (thought: Thought, question: string, type: string) => void,
  ) {
    super(leaf);
    this.kb = kb;
    this.ai = ai;
    this.getSettings = getSettings;
    this.onAsk = onAsk;
  }

  getViewType(): string {
    return COMBINED_SIDEBAR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Backlinks & siblings";
  }

  getIcon(): string {
    return "layers";
  }

  /** The follow-ups currently shown in this pane (or null if none rendered). */
  getCurrentFollowups(): Record<FollowupGroup, FollowupQuestion[]> | null {
    return this.lastGroups;
  }

  async onOpen(): Promise<void> {
    this.container = this.contentEl.createDiv({ cls: "kb-combined-sidebar" });
    this.registerEvent(
      this.app.workspace.on("file-open", () => void this.maybeRefresh()),
    );
    this.unsubscribe = this.kb.onChange(() => void this.maybeRefresh());
    this.register(() => this.unsubscribe());
    await this.maybeRefresh();
  }

  async onClose(): Promise<void> {
    this.container.empty();
  }

  private currentThought(): Thought | null {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      return null;
    }
    if (!this.kb.isInDefaultFolder(file.path)) {
      return null;
    }
    return this.kb.getThought(file.basename);
  }

  private async maybeRefresh(): Promise<void> {
    const thought = this.currentThought();
    const id = thought ? thought.id : "";
    if (id === this.currentId) {
      return;
    }
    this.currentId = id;
    const token = ++this.genToken;
    this.container.empty();
    if (!thought) {
      this.container.createDiv({
        cls: "setting-item-description",
        text: "Open a markdown note in the default folder to see its siblings, backlinks, and follow-up questions.",
      });
      return;
    }

    // Order matches the setting label: follow-ups, siblings, backlinks.
    if (this.followupsPaused) {
      this.renderFollowupsPaused();
    } else {
      this.renderFollowups(thought, token);
    }

    const siblings = this.kb
      .siblingsOf(thought.id)
      .filter((r) => this.kb.isInDefaultFolder(r.path));
    const backlinks = this.kb
      .childrenOf(thought.id)
      .filter((r) => this.kb.isInDefaultFolder(r.path));

    if (siblings.length === 0 && backlinks.length === 0) {
      this.container.createDiv({
        cls: "setting-item-description",
        text: "This thought has no siblings or backlinks in the default folder.",
      });
    }

    if (siblings.length > 0) {
      const label = this.container.createDiv({ cls: "kb-followups-group-label", text: "Siblings" });
      void label;
      const list = this.container.createDiv({ cls: "kb-siblings-list" });
      for (const rec of siblings) {
        this.renderSibling(list, rec);
      }
    }

    if (backlinks.length > 0) {
      const label = this.container.createDiv({ cls: "kb-followups-group-label", text: "Backlinks" });
      void label;
      const list = this.container.createDiv({ cls: "kb-backlinks-list" });
      for (const rec of backlinks) {
        this.renderBacklink(list, rec);
      }
    }
  }

  /** Follow-ups section: header + Regenerate/Pause, results filled in async. */
  private renderFollowups(thought: Thought, token: number): void {
    const section = this.container.createDiv({ cls: "kb-followups-section" });
    const header = section.createDiv({ cls: "kb-followups-header" });
    header.createSpan({ text: `Follow-ups for "${thought.title}"` });
    const regen = header.createEl("button", { text: "Regenerate", cls: "mod-muted" });
    regen.onclick = () => {
      this.currentId = "";
      void this.maybeRefresh();
    };
    const pauseBtn = header.createEl("button", {
      text: "Pause",
      cls: "mod-muted kb-followups-toggle",
      attr: { title: "Stop generating follow-ups automatically" },
    });
    pauseBtn.onclick = () => {
      this.followupsPaused = true;
      this.currentId = "";
      void this.maybeRefresh();
    };
    const body = section.createDiv({ cls: "kb-followups-body" });
    body.createDiv({ cls: "setting-item-description" }).createEl("small", {
      text: "Generating follow-ups...",
    });
    void this.generateFollowups(thought, token, body);
  }

  /** Paused follow-ups section: Resume button + hint, no generation. */
  private renderFollowupsPaused(): void {
    const section = this.container.createDiv({ cls: "kb-followups-section" });
    const header = section.createDiv({ cls: "kb-followups-header" });
    header.createSpan({ text: "Follow-up questions (paused)" });
    const resume = header.createEl("button", { text: "Resume", cls: "mod-muted" });
    resume.onclick = () => {
      this.followupsPaused = false;
      this.currentId = "";
      void this.maybeRefresh();
    };
    section.createDiv({
      cls: "kb-followups-hint",
      text: "Automatic follow-up generation is paused. Click Resume to regenerate for the current note.",
    });
  }

  private async generateFollowups(
    thought: Thought,
    token: number,
    body: HTMLElement,
  ): Promise<void> {
    let groups: Record<FollowupGroup, FollowupQuestion[]>;
    try {
      groups = await this.ai.followups(thought, this.getSettings());
    } catch (e) {
      if (token !== this.genToken) {
        return;
      }
      body.empty();
      body.createDiv({
        cls: "kb-chat-error",
        text: `Could not generate follow-ups: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    if (token !== this.genToken) {
      return;
    }
    this.lastGroups = groups;
    body.empty();
    let any = false;
    for (const group of FOLLOWUP_GROUPS) {
      const items = groups[group] ?? [];
      if (items.length === 0) {
        continue;
      }
      any = true;
      const g = body.createDiv({ cls: "kb-followups-group" });
      g.createDiv({ cls: "kb-followups-group-label", text: GROUP_LABELS[group] });
      for (const q of items) {
        addFollowupRow(g, q, () => this.onAsk(thought, q.q, group));
      }
    }
    if (!any) {
      body.createDiv({
        cls: "setting-item-description",
        text: "No follow-up questions could be generated for this thought.",
      });
    }
  }

  private renderSibling(list: HTMLElement, rec: ThoughtRecord): void {
    const item = list.createDiv({ cls: "kb-siblings-item" });
    item.createDiv({ cls: "kb-siblings-title", text: rec.title });
    item.onclick = () => this.openThought(rec.id);
  }

  private renderBacklink(list: HTMLElement, rec: ThoughtRecord): void {
    const item = list.createDiv({ cls: "kb-backlinks-item" });
    const label = rec.parentLabels[this.currentId] ?? "";
    item.createDiv({ cls: "kb-backlinks-title", text: rec.title });
    if (label) {
      item.createDiv({ cls: "kb-backlinks-label", text: `label: ${label}` });
    }
    item.onclick = () => this.openThought(rec.id);
  }

  private openThought(id: string): void {
    const rec = this.kb.getRecord(id);
    if (!rec) {
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(rec.path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
