import { ItemView, WorkspaceLeaf } from "obsidian";
import {
  AiService,
  FOLLOWUP_GROUPS,
  type FollowupGroup,
  type FollowupQuestion,
} from "./ai";
import { addFollowupRow } from "./copyRow";
import { KnowledgeBase } from "./knowledgeBase";
import type { PluginSettings, Thought } from "./types";

export const FOLLOWUPS_VIEW_TYPE = "knowledge-brain-followups";

const GROUP_LABELS: Record<FollowupGroup, string> = {
  scientific: "Scientific",
  practical: "Practical",
  comparative: "Comparative",
  historical: "Historical",
  causal: "Causal",
  critical: "Critical",
};

/**
 * Right-sidebar pane showing follow-up questions for the note currently open
 * in the editor, when that note lives inside the default folder. Regenerates
 * when the active note changes; clicking a question hands it to the chat view.
 */
export class FollowUpsView extends ItemView {
  private kb: KnowledgeBase;
  private ai: AiService;
  private getSettings: () => PluginSettings;
  private onAsk: (thought: Thought, question: string, type: string) => void;
  private container: HTMLElement;
  private currentId = "";
  private genToken = 0;
  private paused = false;
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
    return FOLLOWUPS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Follow-up questions";
  }

  getIcon(): string {
    return "message-circle-question";
  }

  /** The follow-ups currently shown in this pane (or null if none rendered). */
  getCurrentFollowups(): Record<FollowupGroup, FollowupQuestion[]> | null {
    return this.lastGroups;
  }

  async onOpen(): Promise<void> {
    this.container = this.contentEl.createDiv({ cls: "kb-followups-view" });
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
    this.genToken++;
    this.container.empty();
    // When paused, don't auto-generate — just show the toggle + a hint.
    if (this.paused) {
      this.renderPaused();
      return;
    }
    if (!thought) {
      this.renderHint(
        "Open a markdown note in the default folder to see follow-up questions here.",
      );
      return;
    }
    const token = this.genToken;
    this.container.createDiv({ cls: "setting-item-description" }).createEl("small", {
      text: `Generating follow-ups for "${thought.title}"...`,
    });
    this.container.createDiv({ cls: "setting-item-description" }).createEl("small", {
      text: `Generating follow-ups for "${thought.title}"...`,
    });
    try {
      const groups = await this.ai.followups(thought, this.getSettings());
      if (token !== this.genToken) {
        return;
      }
      this.renderQuestions(thought, groups);
    } catch (e) {
      if (token !== this.genToken) {
        return;
      }
      this.container.empty();
      this.container.createDiv({
        cls: "kb-chat-error",
        text: `Could not generate follow-ups: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  private renderQuestions(
    thought: Thought,
    groups: Record<FollowupGroup, FollowupQuestion[]>,
  ): void {
    this.lastGroups = groups;
    this.container.empty();
    const header = this.container.createDiv({ cls: "kb-followups-header" });
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
      this.paused = true;
      this.currentId = "";
      void this.maybeRefresh();
    };

    let any = false;
    for (const group of FOLLOWUP_GROUPS) {
      const items = groups[group] ?? [];
      if (items.length === 0) {
        continue;
      }
      any = true;
      const g = this.container.createDiv({ cls: "kb-followups-group" });
      g.createDiv({ cls: "kb-followups-group-label", text: GROUP_LABELS[group] });
      for (const q of items) {
        addFollowupRow(g, q, () => this.onAsk(thought, q.q, group));
      }
    }
    if (!any) {
      this.container.createDiv({
        cls: "setting-item-description",
        text: "No follow-up questions could be generated for this thought.",
      });
    }
  }

  private renderHint(text: string): void {
    const div = this.container.createDiv({ cls: "kb-followups-hint" });
    div.createSpan({ text });
  }

  /** Paused state: show a Resume button and a hint instead of generating. */
  private renderPaused(): void {
    const header = this.container.createDiv({ cls: "kb-followups-header" });
    header.createSpan({ text: "Follow-up questions (paused)" });
    const resume = header.createEl("button", { text: "Resume", cls: "mod-muted" });
    resume.onclick = () => {
      this.paused = false;
      this.currentId = "";
      void this.maybeRefresh();
    };
    this.renderHint(
      "Automatic follow-up generation is paused. Click Resume to regenerate for the current note.",
    );
  }
}
