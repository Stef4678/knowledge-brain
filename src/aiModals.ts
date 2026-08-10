import { Modal, Notice, Setting, type App } from "obsidian";
import { AiService } from "./ai";
import { KnowledgeBase } from "./knowledgeBase";
import { THOUGHT_STATUSES } from "./types";
import type { PluginSettings, Thought } from "./types";

const STATUS_LABELS: Record<string, string> = {
  idea: "Idea",
  "in progress": "In progress",
  done: "Done",
};

/** Propose AI-generated tags for a thought; Apply merges them with existing. */
export class SuggestTagsModal extends Modal {
  private kb: KnowledgeBase;
  private ai: AiService;
  private getSettings: () => PluginSettings;
  private thought: Thought;

  constructor(
    app: App,
    kb: KnowledgeBase,
    ai: AiService,
    getSettings: () => PluginSettings,
    thought: Thought,
  ) {
    super(app);
    this.kb = kb;
    this.ai = ai;
    this.getSettings = getSettings;
    this.thought = thought;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `Tags for "${this.thought.title}"` });
    contentEl.createEl("p", {
      cls: "setting-item-description kb-ai-hint",
      text: "Generating tag suggestions…",
    });
    void this.run();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    let tags: string[];
    try {
      tags = await this.ai.suggestTags(this.thought, this.getSettings());
    } catch (e) {
      this.close();
      new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const { contentEl } = this;
    contentEl.empty();
    if (tags.length === 0) {
      contentEl.createEl("h3", { text: `Tags for "${this.thought.title}"` });
      contentEl.createEl("p", { text: "The model did not suggest any tags." });
      return;
    }
    contentEl.createEl("h3", { text: `Tags for "${this.thought.title}"` });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Suggested tags (existing tags are kept; suggested ones are added):",
    });
    const chips = contentEl.createDiv({ cls: "kb-search-chips" });
    for (const tag of tags) {
      chips.createSpan({ cls: "kb-chip", text: `#${tag}` });
    }
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(`Apply ${tags.length} tag${tags.length === 1 ? "" : "s"}`)
          .setCta()
          .onClick(() => void this.apply(tags)),
      );
  }

  private async apply(tags: string[]): Promise<void> {
    try {
      const merged = [...new Set([...this.thought.tags, ...tags])];
      await this.kb.updateThought(this.thought.id, { tags: merged });
      this.close();
      new Notice(
        `Tags updated on "${this.thought.title}" (${merged.length} total).`,
      );
    } catch (e) {
      new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Propose an AI-generated workflow status for a thought; Apply sets it. */
export class SuggestStatusModal extends Modal {
  private kb: KnowledgeBase;
  private ai: AiService;
  private getSettings: () => PluginSettings;
  private thought: Thought;

  constructor(
    app: App,
    kb: KnowledgeBase,
    ai: AiService,
    getSettings: () => PluginSettings,
    thought: Thought,
  ) {
    super(app);
    this.kb = kb;
    this.ai = ai;
    this.getSettings = getSettings;
    this.thought = thought;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `Status for "${this.thought.title}"` });
    contentEl.createEl("p", {
      cls: "setting-item-description kb-ai-hint",
      text: "Analyzing the thought…",
    });
    void this.run();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    let status: string;
    let reason: string;
    try {
      const result = await this.ai.suggestStatus(this.thought, this.getSettings());
      status = result.status;
      reason = result.reason;
    } catch (e) {
      this.close();
      new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Status for "${this.thought.title}"` });
    if (!status) {
      contentEl.createEl("p", { text: "The model did not return a valid status." });
    } else {
      contentEl.createEl("p", {
        cls: "kb-ai-status",
        text: `AI suggests: ${STATUS_LABELS[status] ?? status}`,
      });
      if (reason) {
        contentEl.createEl("p", { cls: "kb-ai-reason", text: reason });
      }
      new Setting(contentEl)
        .setName("Choose status")
        .setDesc("Or pick a different one of the three statuses.")
        .addButton((button) =>
          button.setButtonText("Apply").setCta().onClick(() => void this.apply(status)),
        );
    }
    // The user can always pick any of the three statuses.
    const row = contentEl.createDiv({ cls: "kb-status-row" });
    for (const s of THOUGHT_STATUSES) {
      const btn = row.createEl("button", { cls: "kb-status-btn", text: STATUS_LABELS[s] });
      btn.onclick = () => void this.apply(s);
    }
  }

  private async apply(status: string): Promise<void> {
    try {
      await this.kb.updateThought(this.thought.id, { status });
      this.close();
      new Notice(`Status set to "${STATUS_LABELS[status] ?? status}" on "${this.thought.title}".`);
    } catch (e) {
      new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
