import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import {
  FOLLOWUP_GROUPS,
  type AiService,
  type FollowupGroup,
  type FollowupQuestion,
  type Suggestion,
} from "./ai";
import { addFollowupRow, copyToClipboard } from "./copyRow";
import { KnowledgeBase, sanitizeTitle, type ThoughtRecord } from "./knowledgeBase";
import { hasApiKey } from "./settings";
import type { PluginSettings, Thought } from "./types";

export const ORPHAN_RADAR_VIEW_TYPE = "knowledge-brain-orphan-radar";

/** Short human date for a row label, e.g. "Mar 3, 2026". */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleDateString();
}

/**
 * Right-sidebar pane showing thoughts with no parent (roots that nothing links
 * up to) plus the active note's unanswered follow-up questions. The orphan
 * list is purely local; suggesting a link makes a single AI call per orphan.
 */
export class OrphanRadarView extends ItemView {
  private kb: KnowledgeBase;
  private ai: AiService;
  private getSettings: () => PluginSettings;
  private onAsk: (thought: Thought, question: string, type: string) => void;
  private container: HTMLElement;
  private genToken = 0;
  private inFlight = new Set<string>();
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
    return ORPHAN_RADAR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Orphan radar";
  }

  getIcon(): string {
    return "radar";
  }

  async onOpen(): Promise<void> {
    this.container = this.contentEl.createDiv({ cls: "kb-orphan-view" });
    this.registerEvent(
      this.app.workspace.on("file-open", () => void this.refresh()),
    );
    this.unsubscribe = this.kb.onChange(() => void this.refresh());
    this.register(() => this.unsubscribe());
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.container.empty();
  }

  /** Thoughts with no parent (roots) — nothing links up to them. */
  private orphans(): ThoughtRecord[] {
    return this.kb
      .listRecords()
      .filter(
        (r) => this.kb.isInDefaultFolder(r.path) && r.parents.length === 0,
      )
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
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

  /** Re-render both sections. The follow-up half is async and gen-token gated. */
  private async refresh(): Promise<void> {
    const thought = this.currentThought();
    const token = ++this.genToken;
    this.container.empty();
    this.renderOrphans();
    await this.renderFollowups(thought, token);
  }

  // ----------------------------------------------------------- orphans

  private renderOrphans(): void {
    const orphans = this.orphans();
    const section = this.container.createDiv({ cls: "kb-orphan-section" });
    const header = section.createDiv({ cls: "kb-orphan-header" });
    header.createSpan({ text: `Orphaned thoughts (${orphans.length})` });
    if (orphans.length === 0) {
      section.createDiv({
        cls: "kb-orphan-hint",
        text: "No orphaned thoughts — every thought has a parent.",
      });
      return;
    }
    for (const rec of orphans) {
      this.renderOrphanRow(section, rec);
    }
  }

  private renderOrphanRow(parent: HTMLElement, rec: ThoughtRecord): void {
    const row = parent.createDiv({ cls: "kb-orphan-row" });
    row.dataset.orphanId = rec.id;
    const title = row.createEl("button", {
      cls: "kb-orphan-title",
      text: rec.title,
      attr: { title: "Open this note" },
    });
    title.onclick = () => {
      const file = this.app.vault.getAbstractFileByPath(rec.path);
      if (file instanceof TFile) {
        void this.app.workspace.getLeaf(false).openFile(file);
      }
    };
    row.createSpan({ cls: "kb-orphan-date", text: shortDate(rec.created_at) });

    if (this.inFlight.has(rec.id)) {
      row.createSpan({ cls: "setting-item-description", text: "Suggesting…" });
      return;
    }
    if (!hasApiKey(this.getSettings())) {
      return;
    }
    const suggest = row.createEl("button", {
      cls: "mod-muted kb-orphan-suggest",
      text: "Suggest link",
      attr: { title: "Ask the AI where this thought belongs" },
    });
    suggest.onclick = () => void this.suggestLink(rec.id);
  }

  private async suggestLink(id: string): Promise<void> {
    if (this.inFlight.has(id)) {
      return;
    }
    const rec = this.kb.getRecord(id);
    if (!rec) {
      return;
    }
    this.inFlight.add(id);
    try {
      const suggestions = await this.ai.suggestParents(
        rec.title,
        rec.content,
        this.getSettings(),
        // Exclude the orphan itself from the candidate set so the model can
        // never suggest linking a thought under itself, and ask for a whole
        // specific-to-general chain of parents (e.g. Cats -> Carnivores ->
        // Mammals -> Animals) so the orphan can be filed under several topics.
        { childId: rec.id, hierarchy: true },
      );
      this.renderSuggestions(rec.id, suggestions);
    } catch (e) {
      new Notice(
        `Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Inline suggestion rows under an orphan's row: one action + Copy each. */
  private renderSuggestions(id: string, suggestions: Suggestion[]): void {
    const rec = this.kb.getRecord(id);
    if (!rec) {
      return;
    }
    // Drop the "Suggest link" button, leaving the title + date. Find the row
    // by id so a refresh mid-flight (kb.onChange) still targets the right row.
    let row: HTMLElement | null = null;
    for (const r of Array.from(
      this.container.querySelectorAll<HTMLElement>(".kb-orphan-row"),
    )) {
      if (r.dataset.orphanId === id) {
        row = r;
        break;
      }
    }
    if (row) {
      for (const b of Array.from(row.querySelectorAll("button.kb-orphan-suggest"))) {
        b.remove();
      }
    }
    const box = (row ?? this.container).createDiv({ cls: "kb-orphan-actions" });
    if (suggestions.length === 0) {
      box.createDiv({
        cls: "kb-orphan-hint",
        text: "No suggestions returned — try again or link manually.",
      });
      return;
    }

    // Rows the user can act on: existing parents plus new-parent proposals
    // that pass the same-topic guard (never file "Cats" under a new note also
    // named "Cats"). The AI may return several parents of a specific-to-general
    // chain, so all of them are actionable.
    const actionable: Suggestion[] = [];
    let keepRootReason = "";
    for (const s of suggestions) {
      if (s.parent_id) {
        actionable.push(s);
      } else if (s.new_parent_title) {
        const proposed = sanitizeTitle(s.new_parent_title).slice(0, 80);
        if (
          proposed &&
          proposed !== "Untitled" &&
          proposed.toLowerCase() !== rec.title.toLowerCase()
        ) {
          actionable.push({ ...s, new_parent_title: proposed });
        }
      } else {
        keepRootReason = s.reason;
      }
    }

    for (const s of actionable) {
      if (s.parent_id) {
        const pid = s.parent_id;
        this.addSuggestionRow(
          box,
          `Under "${s.parent_title ?? pid}"`,
          s.reason,
          () => void this.applyLink(rec.id, pid),
        );
      } else {
        const title = s.new_parent_title ?? "";
        this.addSuggestionRow(
          box,
          `New parent: "${title}"`,
          s.reason,
          () => void this.createNewParent(rec.id, title),
        );
      }
    }

    if (actionable.length >= 2) {
      const chainLabels = actionable.map((s) =>
        s.parent_id
          ? (s.parent_title ?? s.parent_id)
          : (s.new_parent_title ?? "?"),
      );
      this.addSuggestionRow(
        box,
        `Link as hierarchy: ${chainLabels.join(" → ")}`,
        "Files the orphan under the first parent and chains each level under the next; missing notes are created.",
        () => void this.applyAll(rec.id, actionable),
      );
    }

    this.addSuggestionRow(
      box,
      "Keep as root thought",
      keepRootReason,
      () => void this.applyLink(rec.id, null),
      true,
    );
  }

  /** One orphan suggestion: a two-line action button plus a Copy button. */
  private addSuggestionRow(
    box: HTMLElement,
    title: string,
    reason: string,
    onClick: () => void,
    muted = false,
  ): void {
    const row = box.createDiv({ cls: "kb-copy-row" });
    const btn = row.createEl("button", {
      cls: muted ? "mod-muted kb-suggestion" : "kb-suggestion",
    });
    btn.onclick = onClick;
    btn.createSpan({ cls: "kb-orphan-suggest-title", text: title });
    if (reason) {
      btn.createSpan({ cls: "kb-orphan-suggest-reason", text: reason });
    }
    const copy = row.createEl("button", {
      cls: "mod-muted kb-copy-btn",
      text: "Copy",
      attr: { title: "Copy this suggestion" },
    });
    const copyText = reason ? `${title} — ${reason}` : title;
    copy.onclick = (evt) => {
      evt.stopPropagation();
      void copyToClipboard(copyText);
    };
  }

  /**
   * Create a brand-new parent thought (title proposed by the AI) and link the
   * orphan under it. Both actions are one click for the user.
   */
  private async createNewParent(
    orphanId: string,
    parentTitle: string,
  ): Promise<void> {
    const orphan = this.kb.getRecord(orphanId);
    if (!orphan) {
      return;
    }
    const title = sanitizeTitle(parentTitle).slice(0, 80);
    if (!title || title === "Untitled") {
      new Notice("Knowledge Brain: could not use that title for a new parent.");
      return;
    }
    if (title.toLowerCase() === orphan.title.toLowerCase()) {
      new Notice(
        "Knowledge Brain: that parent is the same topic as this thought — try another suggestion.",
      );
      return;
    }
    try {
      // The AI sometimes proposes a new parent that already exists as a note;
      // link under it instead of creating a duplicate.
      const existing = this.kb.getThought(title);
      if (existing) {
        await this.kb.updateThought(orphanId, { parents: [existing.id] });
        new Notice(`Linked "${orphan.title}" under "${existing.title}".`);
      } else {
        const parent = await this.kb.createThought(title, "");
        await this.kb.updateThought(orphanId, { parents: [parent.id] });
        new Notice(`Created "${parent.title}" and linked "${orphan.title}" under it.`);
      }
    } catch (e) {
      new Notice(
        `Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    await this.refresh();
  }

  private async applyLink(id: string, parentId: string | null): Promise<void> {
    try {
      if (parentId) {
        await this.kb.updateThought(id, { parents: [parentId] });
        new Notice(`Linked "${this.kb.getThought(id)?.title}" to a parent.`);
      }
    } catch (e) {
      new Notice(
        `Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    await this.refresh();
  }

  /** Chain an orphan under the suggested parents hierarchically: it links under
   *  the most specific, and each suggested parent under the next more general
   *  one (the most general stays a root). Missing parent notes are created.
   *  Existing notes in the chain are re-parented too. */
  private async applyAll(id: string, suggestions: Suggestion[]): Promise<void> {
    const orphan = this.kb.getRecord(id);
    if (!orphan) {
      return;
    }
    const created: string[] = [];
    try {
      // Resolve each suggestion to a thought id (existing or newly created),
      // keeping the model's most-specific-first order — that order is the chain.
      const chainIds: string[] = [];
      for (const s of suggestions) {
        if (s.parent_id) {
          chainIds.push(s.parent_id);
          continue;
        }
        const title = sanitizeTitle(s.new_parent_title ?? "").slice(0, 80);
        if (
          !title ||
          title === "Untitled" ||
          title.toLowerCase() === orphan.title.toLowerCase()
        ) {
          continue;
        }
        const existing = this.kb.getThought(title);
        if (existing) {
          chainIds.push(existing.id);
        } else {
          const parent = await this.kb.createThought(title, "");
          chainIds.push(parent.id);
          created.push(parent.title);
        }
      }
      const unique = Array.from(new Set(chainIds));
      if (unique.length === 0) {
        new Notice("Knowledge Brain: nothing to link — try again.");
        await this.refresh();
        return;
      }
      // Link the orphan under the most specific parent, then chain each level
      // under the next; the most general level stays a root. updateThought
      // validates cycles, so a pre-existing loop here would throw a notice.
      await this.kb.updateThought(id, { parents: [unique[0]] });
      for (let i = 0; i < unique.length - 1; i++) {
        await this.kb.updateThought(unique[i], { parents: [unique[i + 1]] });
      }
      const labels = unique
        .map((pid) => this.kb.getThought(pid)?.title ?? pid)
        .join(" → ");
      new Notice(
        `Chained "${orphan.title}" under ${labels}` +
          (created.length ? ` (created: ${created.join(", ")})` : "") +
          ".",
      );
    } catch (e) {
      new Notice(
        `Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    await this.refresh();
  }

  // --------------------------------------------------------- follow-ups

  private async renderFollowups(thought: Thought | null, token: number): Promise<void> {
    const section = this.container.createDiv({ cls: "kb-orphan-section" });
    const header = section.createDiv({ cls: "kb-orphan-header" });
    header.createSpan({ text: "Unanswered follow-ups" });
    if (!thought) {
      section.createDiv({
        cls: "kb-orphan-hint",
        text: "Open a markdown note in the default folder to see its unanswered follow-ups here.",
      });
      return;
    }
    header.createSpan({ text: `for "${thought.title}"` });
    if (!hasApiKey(this.getSettings())) {
      section.createDiv({
        cls: "kb-orphan-hint",
        text: "Add an API key in settings to generate follow-up questions.",
      });
      return;
    }
    section.createDiv({ cls: "setting-item-description" }).createEl("small", {
      text: `Generating follow-ups for "${thought.title}"…`,
    });
    try {
      const groups = await this.ai.followups(thought, this.getSettings());
      if (token !== this.genToken) {
        return;
      }
      this.renderUnanswered(section, thought, groups);
    } catch (e) {
      if (token !== this.genToken) {
        return;
      }
      this.container.empty();
      this.renderOrphans();
      this.container.createDiv({
        cls: "kb-chat-error",
        text: `Could not generate follow-ups: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  private renderUnanswered(
    section: HTMLElement,
    thought: Thought,
    groups: Record<FollowupGroup, FollowupQuestion[]>,
  ): void {
    section.empty();
    const header = section.createDiv({ cls: "kb-orphan-header" });
    header.createSpan({ text: `Unanswered follow-ups for "${thought.title}"` });
    let any = false;
    for (const group of FOLLOWUP_GROUPS) {
      for (const q of groups[group] ?? []) {
        if (q.covered_id !== null) {
          continue;
        }
        any = true;
        addFollowupRow(section, q, () => this.onAsk(thought, q.q, group));
      }
    }
    if (!any) {
      section.createDiv({
        cls: "kb-orphan-hint",
        text: "All follow-up questions for this thought are already answered elsewhere in the graph.",
      });
    }
  }
}
