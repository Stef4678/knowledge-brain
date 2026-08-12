import {
  App,
  TFile,
  parseYaml,
  stringifyYaml,
  normalizePath,
  type EventRef,
  type TAbstractFile,
} from "obsidian";
import { QUESTION_TYPES } from "./types";
import type { GraphData, Thought, ThoughtLink } from "./types";
import { buildBm25Index, type Bm25Index } from "./bm25";

/** Thought with the resolved node-link shape (parents as nested thoughts). */
export interface ThoughtRecord {
  id: string;
  title: string;
  path: string;
  content: string;
  source: string;
  question_type: string;
  tags: string[];
  status: string;
  created_at: string;
  updated_at: string;
  parents: string[];
  parentLabels: Record<string, string>;
  extra: Record<string, unknown>;
}

const KB_KEYS = new Set([
  "parents",
  "parent_labels",
  "source",
  "question_type",
  "tags",
  "status",
  "created_at",
  "updated_at",
]);

function now(): string {
  return new Date().toISOString();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  if (typeof v === "string" && v.trim()) {
    return [v];
  }
  return [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Normalize frontmatter tags into a deduped string array. Accepts `[a, b]`,
 * a single `a`, or a comma string `"a, b"` — the forms Obsidian authors use.
 * Multi-word tags are joined with the configured separator so Obsidian treats
 * them as a single valid tag (spaces would render them struck out).
 */
function toTagArray(v: unknown, separator: "-" | "_"): string[] {
  const raw: unknown[] = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const itemText = typeof item === "string" ? item : "";
    for (const part of itemText.split(",")) {
      const tag = part
        .trim()
        .toLowerCase()
        .replace(/^#+/, "")
        .replace(/[\s-_]+/g, separator)
        .replace(new RegExp(`^[${separator}]+|[${separator}]+$`, "g"), "");
      if (tag && !seen.has(tag)) {
        seen.add(tag);
        out.push(tag);
      }
    }
  }
  return out;
}

/** Characters Obsidian forbids in note filenames. */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/**
 * Clean a title so it is a valid Obsidian note name: drop characters Obsidian
 * disallows and Windows quirks (trailing dots/spaces, a trailing .md). Used for
 * AI-suggested titles and as a final guard before creating a note.
 */
export function sanitizeTitle(title: string, fallback = "Untitled"): string {
  let t = title
    .replace(/[\r\n]+/g, " ")
    .replace(ILLEGAL_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/\.md$/i, "").replace(/[.\s]+$/, "").replace(/^[.\s]+/, "");
  return t || fallback;
}

/** Split `content` into { frontmatter (object), body (string) }. */
function splitFrontmatter(content: string): {
  fm: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { fm: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end < 0) {
    return { fm: {}, body: content };
  }
  const block = content.slice(3, end);
  let fm: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(block);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    fm = {};
  }
  let body = content.slice(end + 4);
  if (body.startsWith("\n")) {
    body = body.slice(1);
  }
  return { fm, body };
}

/** Turn a record into a full markdown file string (frontmatter + body). */
function serializeThought(rec: ThoughtRecord): string {
  const fm: Record<string, unknown> = { ...rec.extra };
  fm.parents = rec.parents;
  if (Object.keys(rec.parentLabels).length > 0) {
    fm.parent_labels = rec.parentLabels;
  }
  if (rec.source) {
    fm.source = rec.source;
  }
  if (rec.question_type) {
    fm.question_type = rec.question_type;
  }
  if (rec.tags.length > 0) {
    fm.tags = rec.tags;
  }
  if (rec.status) {
    fm.status = rec.status;
  }
  fm.created_at = rec.created_at;
  fm.updated_at = rec.updated_at;
  return `---\n${stringifyYaml(fm)}---\n\n${rec.content}`;
}

const VALID_QUESTION_TYPES = new Set<string>(QUESTION_TYPES);

function guessTimestamp(file: TFile): string {
  const mtime = file.stat?.mtime;
  if (mtime) {
    return new Date(mtime).toISOString();
  }
  return now();
}

/**
 * In-memory index over the vault: every markdown note is a thought; direction
 * lives in `parents:` frontmatter (Obsidian links are undirected). Kept in sync
 * with the vault via metadata events and the plugin's own writes.
 */
export class KnowledgeBase {
  private app: App;
  private records = new Map<string, ThoughtRecord>();
  private listeners = new Set<() => void>();
  private eventRefs: Array<() => void> = [];
  private pending = new Set<string>();
  private flushTimer: number | null = null;
  /** Bumped on every index change so cached derived data (e.g. BM25) can invalidate. */
  revision = 0;
  /** Memoized BM25 index for `search()`, rebuilt when `revision` moves. */
  private searchIndex: Bm25Index | null = null;
  private searchBuiltFor = -1;
  /** Folder where new thoughts are created; empty string = vault root. */
  private defaultFolder = "";
  /** Separator used between words in multi-word tags. */
  private tagSeparator: "-" | "_" = "-";

  constructor(app: App) {
    this.app = app;
  }

  /** Set the default folder for new thoughts. Empty string = vault root. */
  setDefaultFolder(folder: string): void {
    this.defaultFolder = folder.trim().replace(/^\/+|\/+$/g, "");
  }

  /** Set the separator used between words in multi-word tags. */
  setTagSeparator(sep: "-" | "_"): void {
    this.tagSeparator = sep;
  }

  /** True when `path` sits inside the default folder (vault root when empty). */
  isInDefaultFolder(path: string): boolean {
    if (!this.defaultFolder) {
      return true;
    }
    return path === this.defaultFolder || path.startsWith(this.defaultFolder + "/");
  }

  /** Path used for a new thought (or a freshly created note) with this title. */
  private folderPath(title: string): string {
    return this.defaultFolder
      ? normalizePath(`${this.defaultFolder}/${title}`)
      : normalizePath(title);
  }

  /** Create the parent folder of `path` if it doesn't exist (best-effort). */
  private async ensureParentFolder(path: string): Promise<void> {
    const parent = path.split("/").slice(0, -1).join("/");
    if (!parent || this.app.vault.getAbstractFileByPath(parent)) {
      return;
    }
    try {
      await this.app.vault.createFolder(parent);
    } catch {
      // Already exists or not creatable; file create will surface any real issue.
    }
  }

  // ---------------------------------------------------------------- events

  private notify() {
    this.revision++;
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* a view's render must not break the index */
      }
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private scheduleFlush() {
    if (this.flushTimer !== null) {
      return;
    }
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flushPending();
    }, 30);
  }

  private queue(path: string) {
    this.pending.add(path);
    this.scheduleFlush();
  }

  private async flushPending() {
    const paths = [...this.pending];
    this.pending.clear();
    for (const path of paths) {
      await this.processPath(path);
    }
    this.notify();
  }

  private isIgnoredPath(path: string): boolean {
    const configDir = this.app.vault.configDir;
    return (
      path.startsWith(`${configDir}/`) ||
      path.startsWith(".trash/") ||
      path === ".trash"
    );
  }

  registerHandlers(): void {
    const vault = this.app.vault;
    const metadataCache = this.app.metadataCache;
    const onCreate = (file: TAbstractFile) => {
      if (file instanceof TFile && file.extension === "md") {
        this.queue(file.path);
      }
    };
    const onModify = (file: TAbstractFile) => {
      if (file instanceof TFile && file.extension === "md") {
        this.queue(file.path);
      }
    };
    const onRename = (file: TAbstractFile, oldPath: string) => {
      if (!(file instanceof TFile) || file.extension !== "md") {
        return;
      }
      void this.handleRename(file, oldPath);
    };
    const onDelete = (file: TAbstractFile) => {
      if (!(file instanceof TFile) || file.extension !== "md") {
        return;
      }
      void this.handleDelete(file);
    };

    const refs: EventRef[] = [
      vault.on("create", onCreate),
      vault.on("modify", onModify),
      vault.on("rename", onRename),
      vault.on("delete", onDelete),
      metadataCache.on("changed", onModify),
    ];
    this.eventRefs.push(() => {
      for (const ref of refs) {
        vault.offref(ref);
        metadataCache.offref(ref);
      }
    });
  }

  onunload(): void {
    for (const off of this.eventRefs) {
      off();
    }
    this.eventRefs = [];
    this.listeners.clear();
  }

  // ------------------------------------------------------------- loading

  async load(): Promise<void> {
    await this.rebuild();
    this.notify();
  }

  /** Full rescan of the vault. Used on startup and as a safety net. */
  async rebuild(): Promise<void> {
    const configDir = this.app.vault.configDir;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter(
        (f) =>
          !f.path.startsWith(`${configDir}/`) && !f.path.startsWith(".trash/"),
      );
    const seen = new Set<string>();
    this.records.clear();
    for (const file of files) {
      let rec: ThoughtRecord;
      try {
        rec = await this.readThought(file);
      } catch (e) {
        // A single unreadable note must not abort the whole index load.
        console.error(`[Knowledge Brain] skipping unreadable note "${file.path}":`, e);
        continue;
      }
      if (seen.has(file.basename)) {
        console.warn(
          `[Knowledge Brain] duplicate thought title "${file.basename}" — only the first file is indexed`,
        );
        continue;
      }
      seen.add(file.basename);
      this.records.set(rec.id, rec);
    }
    this.notify();
  }

  private async readThought(file: TFile): Promise<ThoughtRecord> {
    const content = await this.app.vault.cachedRead(file);
    const { fm, body } = splitFrontmatter(content);
    const id = file.basename;
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(fm)) {
      if (!KB_KEYS.has(key)) {
        extra[key] = fm[key];
      }
    }
    const created = str(fm.created_at) || guessTimestamp(file);
    return {
      id,
      title: id,
      path: file.path,
      content: body,
      source: str(fm.source),
      question_type: str(fm.question_type),
      tags: toTagArray(fm.tags, this.tagSeparator),
      status: str(fm.status),
      created_at: created,
      updated_at: str(fm.updated_at) || created,
      parents: toStrArray(fm.parents),
      parentLabels: isPlainObject(fm.parent_labels)
        ? (fm.parent_labels as Record<string, string>)
        : {},
      extra,
    };
  }

  // ------------------------------------------------------- event handlers

  private async processPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== "md") {
      // A note was deleted; handled by onDelete. Nothing to do here.
      return;
    }
    if (this.isIgnoredPath(path)) {
      return;
    }
    const rec = await this.readThought(file);
    this.records.set(rec.id, rec);
  }

  private async handleRename(file: TFile, oldPath: string): Promise<void> {
    const newPath = file.path;
    // Root -> root rename: the thought id (basename) changed. Update references
    // from other thoughts that listed the old id as a parent.
    const oldId = oldPath.replace(/\.md$/, "").split("/").pop() ?? oldPath;
    const newId = file.basename;
    if (oldId === newId) {
      this.queue(newPath);
      return;
    }
    if (this.records.has(oldId)) {
      const rec = this.records.get(oldId)!;
      rec.id = newId;
      rec.title = newId;
      rec.path = newPath;
      rec.updated_at = now();
      this.records.delete(oldId);
      this.records.set(newId, rec);
    }
    await this.rewriteParentRefs(oldId, newId);
    this.notify();
  }

  private async handleDelete(file: TFile): Promise<void> {
    const id = file.basename;
    if (this.records.delete(id)) {
      this.notify();
    }
  }

  /** Replace every reference to `oldId` with `newId` in parents / labels. */
  private async rewriteParentRefs(oldId: string, newId: string): Promise<void> {
    const touched = [...this.records.values()].filter((r) => r.parents.includes(oldId));
    for (const rec of touched) {
      rec.parents = rec.parents.map((p) => (p === oldId ? newId : p));
      if (rec.parentLabels[oldId] !== undefined) {
        rec.parentLabels[newId] = rec.parentLabels[oldId];
        delete rec.parentLabels[oldId];
      }
      await this.writeRecord(rec);
    }
  }

  // -------------------------------------------------------------- queries

  getThought(id: string): Thought | null {
    const rec = this.records.get(id);
    if (!rec) {
      return null;
    }
    return this.toThought(rec);
  }

  getRecord(id: string): ThoughtRecord | null {
    return this.records.get(id) ?? null;
  }

  listThoughts(): Thought[] {
    return [...this.records.values()].map((r) => this.toThought(r));
  }

  listRecords(): ThoughtRecord[] {
    return [...this.records.values()];
  }

  /**
   * BM25 full-text search over all active thoughts. Uses a memoized index that
   * is rebuilt from `revision` — callers may run this on every keystroke.
   */
  search(query: string, limit = 10): ThoughtRecord[] {
    if (this.searchIndex === null || this.searchBuiltFor !== this.revision) {
      this.searchIndex = buildBm25Index(this.listRecords());
      this.searchBuiltFor = this.revision;
    }
    return this.searchIndex.search(query, limit);
  }

  /** Sorted, deduped union of all tags across active thoughts. */
  allTags(): string[] {
    const seen = new Set<string>();
    for (const rec of this.records.values()) {
      for (const tag of rec.tags) {
        seen.add(tag);
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }

  private toThought(rec: ThoughtRecord, path = new Set<string>()): Thought {
    if (path.has(rec.id)) {
      // A link cycle created outside the plugin: stop recursion here.
      return {
        id: rec.id,
        title: rec.title,
        content: rec.content,
        source: rec.source,
        question_type: rec.question_type,
        tags: rec.tags,
        status: rec.status,
        created_at: rec.created_at,
        updated_at: rec.updated_at,
        parents: [],
        children: [],
        siblings: [],
      };
    }
    const next = new Set(path);
    next.add(rec.id);
    const parents = rec.parents
      .map((p) => this.records.get(p))
      .filter((r): r is ThoughtRecord => !!r)
      .map((r) => this.toThought(r, next));
    const childIds = new Set<string>();
    for (const r of this.records.values()) {
      if (r.parents.includes(rec.id)) {
        childIds.add(r.id);
      }
    }
    const children = [...childIds]
      .map((cid) => this.records.get(cid))
      .filter((r): r is ThoughtRecord => !!r)
      .map((r) => this.toThought(r, next));
    const siblingIds = new Set<string>();
    for (const p of parents) {
      for (const r of this.records.values()) {
        if (r.parents.includes(p.id) && r.id !== rec.id) {
          siblingIds.add(r.id);
        }
      }
    }
    const siblings = [...siblingIds]
      .map((sid) => this.records.get(sid))
      .filter((r): r is ThoughtRecord => !!r)
      .map((r) => this.toThought(r, next));
    return {
      id: rec.id,
      title: rec.title,
      content: rec.content,
      source: rec.source,
      question_type: rec.question_type,
      tags: rec.tags,
      status: rec.status,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      parents,
      children,
      siblings,
    };
  }

  // -------------------------------------------------------------- DAG

  childrenOf(id: string): ThoughtRecord[] {
    return [...this.records.values()].filter((r) => r.parents.includes(id));
  }

  /** Thoughts sharing at least one parent with `id`, excluding itself. */
  siblingsOf(id: string): ThoughtRecord[] {
    const rec = this.records.get(id);
    if (!rec) {
      return [];
    }
    const parentSet = new Set(rec.parents);
    if (parentSet.size === 0) {
      return [];
    }
    return [...this.records.values()].filter(
      (r) => r.id !== id && r.parents.some((p) => parentSet.has(p)),
    );
  }

  descendantsOf(id: string): string[] {
    const out: string[] = [];
    const seen = new Set([id]);
    const stack = [...this.childrenOf(id).map((c) => c.id)];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) {
        continue;
      }
      seen.add(cur);
      out.push(cur);
      for (const c of this.childrenOf(cur)) {
        stack.push(c.id);
      }
    }
    return out;
  }

  isDescendant(startId: string, targetId: string): boolean {
    const seen = new Set<string>();
    const stack = [...this.childrenOf(startId).map((c) => c.id)];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === targetId) {
        return true;
      }
      if (seen.has(cur)) {
        continue;
      }
      seen.add(cur);
      for (const c of this.childrenOf(cur)) {
        stack.push(c.id);
      }
    }
    return false;
  }

  getGraph(onlyDefaultFolder = false): GraphData {
    const nodes = (onlyDefaultFolder ? this.listRecords().filter((r) => this.isInDefaultFolder(r.path)) : this.listRecords()).map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      source: r.source,
      question_type: r.question_type,
      tags: r.tags,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges: ThoughtLink[] = [];
    for (const rec of this.records.values()) {
      if (!nodeIds.has(rec.id)) {
        continue;
      }
      for (const p of rec.parents) {
        if (nodeIds.has(p)) {
          edges.push({
            id: `${p}→${rec.id}`,
            parent_id: p,
            child_id: rec.id,
            label: rec.parentLabels[p] ?? "",
          });
        }
      }
    }
    return { nodes, edges };
  }

  // ------------------------------------------------------------- CRUD

  private assertUniqueTitle(title: string, excludeId?: string): void {
    const key = title.trim().toLowerCase();
    if (!key) {
      throw new Error("Title must not be empty");
    }
    for (const id of this.records.keys()) {
      if (id !== excludeId && id.trim().toLowerCase() === key) {
        throw new Error(`A thought titled "${title}" already exists`);
      }
    }
    const file = this.app.vault.getAbstractFileByPath(`${this.folderPath(title)}.md`);
    if (file instanceof TFile && !this.isIgnoredPath(file.path)) {
      throw new Error(`A thought titled "${title}" already exists`);
    }
  }

  async createThought(
    title: string,
    content = "",
    parents: string[] = [],
    type = "",
    tags: string[] = [],
    status = "",
  ): Promise<Thought> {
    title = sanitizeTitle(title);
    this.assertUniqueTitle(title);
    const rec: ThoughtRecord = {
      id: title,
      title,
      path: `${this.folderPath(title)}.md`,
      content,
      source: "",
      question_type: VALID_QUESTION_TYPES.has(type.trim().toLowerCase())
        ? type.trim().toLowerCase()
        : "",
      tags: toTagArray(tags, this.tagSeparator),
      status: str(status),
      created_at: now(),
      updated_at: now(),
      parents: [],
      parentLabels: {},
      extra: {},
    };
    if (parents.length > 0) {
      await this.setParentsInternal(rec, parents);
    }
    await this.writeRecord(rec);
    this.records.set(rec.id, rec);
    this.notify();
    return this.getThought(rec.id)!;
  }

  private async setParentsInternal(
    rec: ThoughtRecord,
    parents: string[],
  ): Promise<void> {
    // Validate against the existing index; `rec` itself is not registered yet.
    const seen = new Set<string>();
    for (const p of parents) {
      if (p === rec.id) {
        throw new Error("Cannot link a thought to itself");
      }
      if (!this.records.has(p)) {
        throw new Error(`Parent thought "${p}" not found`);
      }
      if (seen.has(p)) {
        throw new Error(`Duplicate parent "${p}"`);
      }
      seen.add(p);
      if (this.isDescendant(rec.id, p)) {
        throw new Error(`Would create a cycle`);
      }
    }
    rec.parents = [...parents];
  }

  private async writeRecord(rec: ThoughtRecord): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(rec.path);
    if (!(file instanceof TFile)) {
      // Create parent folders lazily, only when a thought is actually written.
      await this.ensureParentFolder(rec.path);
    }
    const text = serializeThought(rec);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, text);
    } else {
      await this.app.vault.create(rec.path, text);
    }
    rec.updated_at = now();
  }

  async updateThought(
    id: string,
    patch: {
      title?: string;
      content?: string;
      source?: string;
      question_type?: string;
      tags?: string[];
      status?: string;
    },
  ): Promise<Thought> {
    const rec = this.records.get(id);
    if (!rec) {
      throw new Error("Thought not found");
    }
    if (patch.title !== undefined && patch.title !== rec.title) {
      await this.renameThought(id, patch.title);
      return this.getThought(patch.title)!;
    }
    if (patch.content !== undefined) {
      rec.content = patch.content;
    }
    if (patch.source !== undefined) {
      rec.source = patch.source;
    }
    if (patch.question_type !== undefined) {
      rec.question_type = patch.question_type;
    }
    if (patch.tags !== undefined) {
      rec.tags = toTagArray(patch.tags, this.tagSeparator);
    }
    if (patch.status !== undefined) {
      rec.status = patch.status.trim();
    }
    rec.updated_at = now();
    await this.writeRecord(rec);
    this.notify();
    return this.getThought(id)!;
  }

  async renameThought(id: string, newTitle: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) {
      throw new Error("Thought not found");
    }
    newTitle = newTitle.trim();
    this.assertUniqueTitle(newTitle, id);
    const newPath = `${this.folderPath(newTitle)}.md`;
    const existing = this.app.vault.getAbstractFileByPath(newPath);
    if (existing instanceof TFile) {
      throw new Error(`A thought titled "${newTitle}" already exists`);
    }
    const oldFile = this.app.vault.getAbstractFileByPath(rec.path);
    if (oldFile instanceof TFile) {
      await this.app.vault.rename(oldFile, newPath);
    }
    // Fix any other thought that listed the old id as a parent.
    await this.rewriteParentRefs(id, newTitle);
    rec.id = newTitle;
    rec.title = newTitle;
    rec.path = newPath;
    rec.updated_at = now();
    this.records.delete(id);
    this.records.set(newTitle, rec);
    await this.writeRecord(rec);
    this.notify();
  }

  async deleteThought(id: string, cascade: boolean): Promise<string[]> {
    const ids = [id];
    if (cascade) {
      ids.push(...this.descendantsOf(id));
    }
    for (const cid of ids) {
      const rec = this.records.get(cid);
      if (!rec) {
        continue;
      }
      this.records.delete(cid);
      const file = this.app.vault.getAbstractFileByPath(rec.path);
      if (file instanceof TFile) {
        try {
          // Send to trash per the user's preference (system trash or vault
          // .trash/) so a deleted thought stays recoverable.
          await this.app.fileManager.trashFile(file);
        } catch {
          // File may already be gone; the record is dropped either way.
        }
      }
    }
    this.notify();
    return ids;
  }

  // ------------------------------------------------------------- stats

  /**
   * Aggregated stats over active thoughts. When `onlyDefaultFolder` is true,
   * only thoughts inside the default folder (the graph's "knowledge base") are
   * counted — thoughts stored elsewhere in the vault are excluded.
   */
  stats(onlyDefaultFolder = false): {
    total: number;
    by_source: Record<string, number>;
    by_question_type: Record<string, number>;
  } {
    const by_source: Record<string, number> = {};
    const by_question_type: Record<string, number> = {};
    let total = 0;
    for (const rec of this.records.values()) {
      if (onlyDefaultFolder && !this.isInDefaultFolder(rec.path)) {
        continue;
      }
      total++;
      const src = rec.source || "unknown";
      by_source[src] = (by_source[src] ?? 0) + 1;
      const qt = rec.question_type.trim().toLowerCase();
      const key = VALID_QUESTION_TYPES.has(qt) ? qt : "untyped";
      by_question_type[key] = (by_question_type[key] ?? 0) + 1;
    }
    return {
      total,
      by_source,
      by_question_type,
    };
  }
}

export function displayTitle(t: Thought | ThoughtRecord): string {
  return t.title ?? t.id;
}

export function kbLine(t: Thought): string {
  const snippet = (t.content || "").replace(/\s+/g, " ").trim();
  return `- id ${t.id}: ${t.title}` + (snippet ? ` | ${snippet.slice(0, 150)}` : "");
}
