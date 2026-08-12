import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { KnowledgeBase } from "./knowledgeBase";
import type { ThoughtRecord } from "./knowledgeBase";
import type { Thought } from "./types";

export const SIBLINGS_VIEW_TYPE = "knowledge-brain-siblings";

/**
 * Right-sidebar pane showing the siblings of the note currently open in the
 * editor — thoughts that share at least one parent with it. Scoped to the
 * default folder, mirroring the graph.
 */
export class SiblingsView extends ItemView {
  private kb: KnowledgeBase;
  private container: HTMLElement;
  private currentId = "";
  private unsubscribe: () => void = () => {};

  constructor(leaf: WorkspaceLeaf, kb: KnowledgeBase) {
    super(leaf);
    this.kb = kb;
  }

  getViewType(): string {
    return SIBLINGS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Knowledge Brain siblings";
  }

  getIcon(): string {
    return "users";
  }

  async onOpen(): Promise<void> {
    this.container = this.contentEl.createDiv({ cls: "kb-siblings-view" });
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
        text: "Open a markdown note in the default folder to see its siblings.",
      });
      return;
    }
    const header = this.container.createDiv({ cls: "kb-siblings-header" });
    header.createSpan({ text: `Siblings of "${thought.title}"` });
    const siblings = this.kb
      .siblingsOf(thought.id)
      .filter((r) => this.kb.isInDefaultFolder(r.path));

    if (siblings.length === 0) {
      this.container.createDiv({
        cls: "setting-item-description",
        text: "This thought shares no parents with other thoughts in the default folder.",
      });
      return;
    }
    const list = this.container.createDiv({ cls: "kb-siblings-list" });
    for (const rec of siblings) {
      this.renderSibling(list, rec);
    }
  }

  private renderSibling(list: HTMLElement, rec: ThoughtRecord): void {
    const item = list.createDiv({ cls: "kb-siblings-item" });
    item.createDiv({ cls: "kb-siblings-title", text: rec.title });
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
