import { Modal, TFile, type App } from "obsidian";
import { KnowledgeBase } from "./knowledgeBase";
import type { ThoughtRecord } from "./knowledgeBase";

const MAX_RESULTS = 12;

/** Quick palette over all thoughts, powered by the KB's BM25 index. */
export class ThoughtSearchModal extends Modal {
  private kb: KnowledgeBase;
  private input: HTMLInputElement;
  private resultsEl: HTMLElement;
  private items: ThoughtRecord[] = [];
  private highlight = 0;
  private activeRow: HTMLElement | null = null;
  private debounce: number | null = null;

  constructor(app: App, kb: KnowledgeBase) {
    super(app);
    this.kb = kb;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("kb-search-modal");
    contentEl.createEl("h3", { text: "Search thoughts" });
    this.input = contentEl.createEl("input", {
      cls: "kb-search-input",
      attr: { type: "text", placeholder: "Search thoughts…" },
    });
    this.input.focus();
    this.input.oninput = () => {
      if (this.debounce !== null) {
        window.clearTimeout(this.debounce);
      }
      this.debounce = window.setTimeout(() => this.runSearch(this.input.value), 80);
    };
    this.input.onkeydown = (evt: KeyboardEvent) => {
      if (evt.key === "ArrowDown") {
        evt.preventDefault();
        this.move(1);
      } else if (evt.key === "ArrowUp") {
        evt.preventDefault();
        this.move(-1);
      } else if (evt.key === "Enter") {
        evt.preventDefault();
        const item = this.items[this.highlight];
        if (item) {
          this.openThought(item);
        }
      } else if (evt.key === "Escape") {
        this.close();
      }
    };
    this.resultsEl = contentEl.createDiv({ cls: "kb-search-results" });
    this.runSearch("");
  }

  onClose(): void {
    if (this.debounce !== null) {
      window.clearTimeout(this.debounce);
      this.debounce = null;
    }
    this.contentEl.empty();
  }

  private runSearch(query: string): void {
    this.items = query.trim()
      ? this.kb.search(query.trim(), MAX_RESULTS)
      : [...this.kb.listRecords()].reverse().slice(0, MAX_RESULTS);
    this.highlight = 0;
    this.activeRow = null;
    this.renderResults();
  }

  private renderResults(): void {
    this.resultsEl.empty();
    if (this.items.length === 0) {
      this.resultsEl.createEl("p", {
        cls: "kb-search-empty",
        text: "No matching thoughts.",
      });
      return;
    }
    this.items.forEach((rec, i) => {
      const row = this.resultsEl.createDiv({
        cls: "kb-search-row" + (i === this.highlight ? " kb-search-row-active" : ""),
      });
      if (i === this.highlight) {
        this.activeRow = row;
      }
      row.createDiv({ cls: "kb-search-title", text: rec.title });
      const snippet = (rec.content || "").replace(/\s+/g, " ").trim();
      if (snippet) {
        row.createDiv({ cls: "kb-search-snippet", text: snippet.slice(0, 120) });
      }
      const chips: string[] = [];
      if (rec.status) {
        chips.push(rec.status);
      }
      chips.push(...rec.tags);
      if (chips.length > 0) {
        const chipRow = row.createDiv({ cls: "kb-search-chips" });
        for (const chip of chips) {
          chipRow.createSpan({ cls: "kb-chip", text: `#${chip}` });
        }
      }
      row.onclick = () => this.openThought(rec);
      row.onmousemove = () => this.setHighlight(i);
    });
  }

  private setHighlight(i: number): void {
    if (i === this.highlight || i < 0 || i >= this.items.length) {
      return;
    }
    this.highlight = i;
    this.activeRow?.removeClass("kb-search-row-active");
    const next = this.resultsEl.children[i] as HTMLElement | undefined;
    if (next) {
      next.addClass("kb-search-row-active");
    }
    this.activeRow = next ?? null;
  }

  private move(delta: number): void {
    if (this.items.length === 0) {
      return;
    }
    const next = this.highlight + delta;
    if (next < 0 || next >= this.items.length) {
      return;
    }
    this.setHighlight(next);
  }

  private openThought(rec: ThoughtRecord): void {
    this.close();
    const file = this.app.vault.getAbstractFileByPath(rec.path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
