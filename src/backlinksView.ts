import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { KnowledgeBase } from "./knowledgeBase";
import type { ThoughtRecord } from "./knowledgeBase";
import type { Thought } from "./types";

export const BACKLINKS_VIEW_TYPE = "knowledge-brain-backlinks";

/**
 * Right-sidebar pane showing which thoughts link to the note currently open in
 * the editor (children in the DAG — records whose `parents:` lists this note).
 * Restricted to thoughts inside the default folder, mirroring the graph.
 */
export class BacklinksView extends ItemView {
  private kb: KnowledgeBase;
  private container: HTMLElement;
  private currentId = "";
  private unsubscribe: () => void = () => {};

  constructor(leaf: WorkspaceLeaf, kb: KnowledgeBase) {
    super(leaf);
    this.kb = kb;
  }

  getViewType(): string {
    return BACKLINKS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Knowledge Brain backlinks";
  }

  getIcon(): string {
    // Not "link" — Obsidian's built-in Backlinks pane uses that exact icon, so
    // a shared tab strip would show two indistinguishable link icons.
    return "network";
  }

  async onOpen(): Promise<void> {
    this.container = this.contentEl.createDiv({ cls: "kb-backlinks-view" });
    this.registerEvent(
      this.app.workspace.on("file-open", () => void this.maybeRefresh()),
    );
    this.unsubscribe = this.kb.onChange(() => void this.maybeRefresh());
    this.register(() => this.unsubscribe());
    this.maybeRefresh();
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

  private maybeRefresh(): void {
    const thought = this.currentThought();
    const id = thought ? thought.id : "";
    if (id === this.currentId) {
      return;
    }
    this.currentId = id;
    this.container.empty();
    if (!thought) {
      this.container.createDiv({
        cls: "setting-item-description",
        text: "Open a markdown note in the default folder to see its backlinks.",
      });
      return;
    }
    const header = this.container.createDiv({ cls: "kb-backlinks-header" });
    header.createSpan({ text: `Backlinks for "${thought.title}"` });
    const backlinks = this.kb
      .childrenOf(thought.id)
      .filter((r) => this.kb.isInDefaultFolder(r.path));

    if (backlinks.length === 0) {
      this.container.createDiv({
        cls: "setting-item-description",
        text: "No other thoughts in the default folder link to this note.",
      });
      return;
    }
    const list = this.container.createDiv({ cls: "kb-backlinks-list" });
    for (const rec of backlinks) {
      this.renderBacklink(list, rec);
    }
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
