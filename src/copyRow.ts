import { Notice } from "obsidian";
import type { FollowupQuestion } from "./ai";

const MAX_TITLE = 40;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice("Copied to clipboard");
  } catch (e) {
    new Notice(
      `Knowledge Brain: could not copy — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function addCopyButton(row: HTMLElement, copyText: string): void {
  const copy = row.createEl("button", {
    cls: "mod-muted kb-copy-btn",
    text: "Copy",
    attr: { title: "Copy to clipboard" },
  });
  copy.onclick = (evt) => {
    evt.stopPropagation();
    void copyToClipboard(copyText);
  };
}

/** Single-line suggestion row: main action button plus a Copy button. */
export function addCopyableSuggestion(
  parent: HTMLElement,
  label: string,
  copyText: string,
  onClick: () => void,
): void {
  const row = parent.createDiv({ cls: "kb-copy-row" });
  const main = row.createEl("button", { cls: "kb-suggestion", text: label });
  main.onclick = onClick;
  addCopyButton(row, copyText);
}

/**
 * Follow-up question row: the question on its own line, a small "answered in …"
 * note underneath. Keeps a long question plus its covered note from ballooning
 * into one unwieldy line. Copy always copies the full untruncated text.
 */
export function addFollowupRow(
  parent: HTMLElement,
  q: FollowupQuestion,
  onClick: () => void,
): void {
  const row = parent.createDiv({ cls: "kb-copy-row kb-followup-row" });
  const main = row.createEl("button", { cls: "kb-suggestion" });
  main.onclick = onClick;
  main.createSpan({ cls: "kb-followup-question", text: q.q });
  if (q.covered_id && q.covered_title) {
    main.createSpan({
      cls: "kb-followup-answered",
      text: `answered in "${truncate(q.covered_title, MAX_TITLE)}"`,
    });
  }
  const full = q.covered_id && q.covered_title ? `  (answered in "${q.covered_title}")` : "";
  addCopyButton(row, `${q.q}${full}`);
}
