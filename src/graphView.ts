import { ItemView, Menu, Modal, Setting, TFile, WorkspaceLeaf, type App } from "obsidian";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { FOLLOWUP_GROUPS } from "./ai";
import type { AiService, FollowupGroup, FollowupQuestion } from "./ai";
import { SuggestStatusModal, SuggestTagsModal } from "./aiModals";
import { findSimilarPairs, type SimilarPair } from "./bm25";
import { KnowledgeBase } from "./knowledgeBase";
import { QUESTION_TYPES, THOUGHT_STATUSES } from "./types";
import type { PluginSettings } from "./types";

export const GRAPH_VIEW_TYPE = "knowledge-brain-graph";

/**
 * Read a CSS variable from the body, with a fallback for canvas rendering.
 * Rejects values cytoscape's parser cannot handle (e.g. `hsl(calc(258 - 1), …)`
 * — modern themes compute some variables with calc(), which breaks the canvas).
 */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  if (!value || value.includes("calc(")) {
    return fallback;
  }
  return value;
}

/** One color per workflow status, used to tint graph nodes. */
const STATUS_COLORS: Record<string, string> = {
  idea: "#8ab4e8",
  "in progress": "#e0b564",
  done: "#6fc276",
};

const STATUS_LABELS: Record<string, string> = {
  idea: "Idea",
  "in progress": "In progress",
  done: "Done",
};

/** Sentinel status-filter value meaning "no status set". */
const NO_STATUS_FILTER = "__no_status__";

const TYPE_LABELS: Record<string, string> = {
  scientific: "Scientific",
  practical: "Practical",
  comparative: "Comparative",
  historical: "Historical",
  causal: "Causal",
  critical: "Critical",
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? cssVar("--text-faint", "#8a8a96");
}

export class GraphView extends ItemView {
  private kb: KnowledgeBase;
  private ai: AiService;
  private getSpacing: () => number;
  private setSpacing: (v: number) => void;
  private getSettings: () => PluginSettings;
  private getFollowupGroups: () => Record<FollowupGroup, FollowupQuestion[]> | null;
  private container: HTMLElement;
  private cy: Core | null = null;
  private spacing = 3;
  /** "" = all statuses; NO_STATUS_FILTER = no status; otherwise a status id. */
  private statusFilter = "";
  /** "" = all tags; otherwise an exact tag. */
  private tagFilter = "";
  private previewEl: HTMLElement | null = null;
  private previewHideTimer: number | null = null;
  /** True while the pointer is over a node; wheel zoom is blocked then. */
  private hoveringNode = false;
  /** Removes the document-level wheel zoom blocker on re-render / teardown. */
  private wheelBlocker: (() => void) | null = null;
  private resizeObs: ResizeObserver | null = null;
  private lastLayoutW = 0;
  private lastLayoutH = 0;
  private unsubscribe: () => void = () => {};

  constructor(
    leaf: WorkspaceLeaf,
    kb: KnowledgeBase,
    ai: AiService,
    getSpacing: () => number,
    setSpacing: (v: number) => void,
    getSettings: () => PluginSettings,
    getFollowupGroups: () => Record<FollowupGroup, FollowupQuestion[]> | null,
  ) {
    super(leaf);
    this.kb = kb;
    this.ai = ai;
    this.getSpacing = getSpacing;
    this.setSpacing = setSpacing;
    this.getSettings = getSettings;
    this.getFollowupGroups = getFollowupGroups;
  }

  getViewType(): string {
    return GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Knowledge Brain Graph";
  }

  getIcon(): string {
    return "graph";
  }

  async onOpen(): Promise<void> {
    this.container = this.contentEl.createDiv({ cls: "kb-graph-view" });
    this.spacing = this.getSpacing();
    // Guard against a stuck/legacy value at the dense minimum: open readably.
    if (!(this.spacing >= 1)) {
      this.spacing = 3;
    }
    this.unsubscribe = this.kb.onChange(() => this.render());
    // The preview is mounted on <body> (not inside this container), so it would
    // keep showing even after the graph tab loses focus. Hide it the moment the
    // graph view is no longer the active leaf — e.g. when the user opens a note.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf !== this.leaf) {
          this.hidePreview();
        }
      }),
    );
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe();
    this.clearPreviewTimer();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.previewEl?.remove();
    this.previewEl = null;
    this.wheelBlocker?.();
    this.wheelBlocker = null;
    this.cy?.destroy();
    this.cy = null;
    this.container.empty();
  }

  private openThought(id: string): void {
    this.hidePreview();
    const rec = this.kb.getRecord(id);
    if (!rec) {
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(rec.path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  private clearPreviewTimer(): void {
    if (this.previewHideTimer !== null) {
      window.clearTimeout(this.previewHideTimer);
      this.previewHideTimer = null;
    }
  }

  /** Show a hover tooltip with the thought's status, tags, and content. */
  private showPreview(node: cytoscape.NodeSingular): void {
    this.clearPreviewTimer();
    if (this.previewEl) {
      return;
    }
    const rec = this.kb.getRecord(String(node.id()));
    if (!rec) {
      return;
    }
    // Mount on <body>, not the container: cytoscape binds a capture-phase
    // wheel handler on its container, so a wheel event over a container child
    // (the preview) would zoom the graph instead of scrolling the panel.
    const preview = document.body.createDiv({ cls: "kb-graph-preview" });
    preview.createDiv({ cls: "kb-graph-preview-title", text: rec.title });
    const meta: string[] = [];
    if (rec.status) {
      meta.push(STATUS_LABELS[rec.status] ?? rec.status);
    }
    if (rec.question_type) {
      meta.push(TYPE_LABELS[rec.question_type] ?? rec.question_type);
    }
    if (meta.length > 0) {
      preview.createDiv({ cls: "kb-graph-preview-meta", text: meta.join(" · ") });
    }
    if (rec.tags.length > 0) {
      const chips = preview.createDiv({ cls: "kb-graph-preview-chips" });
      for (const tag of rec.tags) {
        chips.createSpan({ cls: "kb-chip", text: `#${tag}` });
      }
    }
    preview.createDiv({
      cls: "kb-graph-preview-body",
      text: rec.content.trim() || "(no content)",
    });
    // Place the preview next to the node (never over it) in viewport
    // coordinates, since it now lives on <body>.
    const pos = node.renderedPosition();
    const rect = this.container.getBoundingClientRect();
    const pad = 16;
    const pw = preview.offsetWidth || 260;
    const ph = preview.offsetHeight || 240;
    let left = rect.left + pos.x + pad;
    let top = rect.top + pos.y + pad;
    if (left + pw > window.innerWidth - pad && rect.left + pos.x - pw - pad >= 0) {
      left = rect.left + pos.x - pw - pad;
    }
    if (top + ph > window.innerHeight - pad && rect.top + pos.y - ph - pad >= 0) {
      top = rect.top + pos.y - ph - pad;
    }
    preview.style.left = `${Math.max(pad, left)}px`;
    preview.style.top = `${Math.max(pad, top)}px`;
    // Keep the panel alive once the mouse reaches it, so it can be scrolled.
    preview.onmouseenter = () => this.clearPreviewTimer();
    preview.onmouseleave = () => this.scheduleHidePreview();
    this.previewEl = preview;
  }

  private scheduleHidePreview(): void {
    this.clearPreviewTimer();
    this.previewHideTimer = window.setTimeout(() => this.hidePreview(), 250);
  }

  private hidePreview(): void {
    this.clearPreviewTimer();
    this.previewEl?.remove();
    this.previewEl = null;
  }

  private render(): void {
    this.container.empty();
    this.clearPreviewTimer();
    this.previewEl?.remove();
    this.previewEl = null;
    const graph = this.kb.getGraph(true);

    if (graph.nodes.length === 0) {
      const empty = this.container.createDiv({ cls: "kb-graph-empty" });
      empty.createEl("p", {
        text: "No thoughts yet. Create a note (any markdown note is a thought) and it will appear here.",
      });
      return;
    }

    // Apply status + tag filters. Edges whose endpoints are filtered out go too.
    let nodes = graph.nodes;
    if (this.statusFilter) {
      nodes = nodes.filter((n) =>
        this.statusFilter === NO_STATUS_FILTER
          ? !n.status
          : n.status === this.statusFilter,
      );
    }
    if (this.tagFilter) {
      nodes = nodes.filter((n) => n.tags.includes(this.tagFilter));
    }
    const kept = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter(
      (e) => kept.has(e.parent_id) && kept.has(e.child_id),
    );

    const canvas = this.container.createDiv({ cls: "kb-graph-canvas" });
    const toolbar = this.container.createDiv({ cls: "kb-graph-toolbar" });
    const count = toolbar.createSpan({
      cls: "kb-graph-count",
      text: `${nodes.length} thoughts · ${edges.length} links`,
    });
    void count;

    const statusSelect = toolbar.createEl("select") as HTMLSelectElement;
    statusSelect.addClass("kb-graph-filter");
    const statusOptions: Array<[string, string]> = [
      ["", "All statuses"],
      ...THOUGHT_STATUSES.map((s): [string, string] => [s, STATUS_LABELS[s] ?? s]),
      [NO_STATUS_FILTER, "No status"],
    ];
    for (const [value, label] of statusOptions) {
      statusSelect.createEl("option", { text: label, attr: { value } });
    }
    statusSelect.value = this.statusFilter;
    statusSelect.onchange = () => {
      this.statusFilter = statusSelect.value;
      this.render();
    };

    const tagSelect = toolbar.createEl("select") as HTMLSelectElement;
    tagSelect.addClass("kb-graph-filter");
    tagSelect.createEl("option", { text: "All tags", attr: { value: "" } });
    for (const tag of this.kb.allTags()) {
      tagSelect.createEl("option", { text: tag, attr: { value: tag } });
    }
    tagSelect.value = this.tagFilter;
    tagSelect.onchange = () => {
      this.tagFilter = tagSelect.value;
      this.render();
    };

    const statsBtn = toolbar.createEl("button", {
      cls: "mod-muted",
      text: "Statistics",
      attr: { title: "Knowledge base statistics" },
    });
    statsBtn.onclick = () => this.showStatistics();

    const simBtn = toolbar.createEl("button", {
      cls: "mod-muted",
      text: "Check similarity",
      attr: { title: "Find the most similar thoughts in the default folder" },
    });
    simBtn.onclick = () => void this.showSimilarity();
    toolbar.createSpan({ text: "Spacing:" });
    const slider = toolbar.createEl("input", {
      attr: { type: "range", min: "0.6", max: "6", step: "0.1" },
    });
    (slider as HTMLInputElement).value = String(this.spacing);
    const val = toolbar.createSpan({ text: this.spacing.toFixed(1) });
    slider.oninput = () => {
      const v = parseFloat((slider as HTMLInputElement).value) || this.spacing;
      this.spacing = v;
      val.setText(v.toFixed(1));
      this.setSpacing(v);
      this.relayout();
    };

    const legend = this.container.createDiv({ cls: "kb-graph-legend" });
    legend.createSpan({ text: "click a node to open" });

    // Status legend (only for statuses present in the filtered graph).
    const presentStatuses = new Set(nodes.map((n) => n.status).filter(Boolean));
    for (const s of THOUGHT_STATUSES) {
      if (presentStatuses.has(s)) {
        const item = legend.createSpan({ cls: "kb-graph-legend-type" });
        item.createSpan({
          cls: "kb-graph-swatch",
          attr: { style: `background: ${STATUS_COLORS[s]}` },
        });
        item.createSpan({ text: STATUS_LABELS[s] ?? s });
      }
    }
    if (nodes.some((n) => !n.status)) {
      const item = legend.createSpan({ cls: "kb-graph-legend-type" });
      item.createSpan({
        cls: "kb-graph-swatch",
        attr: { style: `background: ${cssVar("--text-faint", "#8a8a96")}` },
      });
      item.createSpan({ text: "No status" });
    }

    if (nodes.length === 0) {
      const empty = canvas.createDiv({ cls: "kb-graph-empty" });
      empty.createEl("p", { text: "No thoughts match the current filter." });
      return;
    }

    const nodeBorder = cssVar("--background-modifier-border", "#888");
    const labelColor = cssVar("--text-normal", "#333");
    const edgeColor = cssVar("--text-faint", "#999");

    // Degree (in + out) per node, so the width/height mapData works — without
    // a `degree` data field cytoscape's mapping fails and nodes render tiny.
    const degrees = new Map<string, number>();
    for (const n of nodes) {
      degrees.set(n.id, 0);
    }
    for (const e of edges) {
      degrees.set(e.parent_id, (degrees.get(e.parent_id) ?? 0) + 1);
      degrees.set(e.child_id, (degrees.get(e.child_id) ?? 0) + 1);
    }
    const elements: ElementDefinition[] = [
      ...nodes.map((n) => ({
        data: {
          id: n.id,
          label: n.title,
          type: statusColor(n.status),
          status: n.status,
          tags: n.tags,
          question_type: n.question_type,
          content: n.content,
          degree: degrees.get(n.id) ?? 0,
        },
      })),
      ...edges.map((e) => ({
        data: {
          id: e.id,
          source: e.parent_id,
          target: e.child_id,
          label: e.label ?? "",
        },
      })),
    ];

    const cy = cytoscape({
      container: canvas,
      elements,
      // No layout here: breadthfirst derives its node spacing from the
      // container's current extent, so running it during construction (when the
      // freshly-opened tab can still be 0×0) crams every node together. The
      // layout is run explicitly in fitWhenReady once the canvas is sized.
      layout: { name: "null" },
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(type)",
            "border-color": nodeBorder,
            "border-width": 1,
            width: "mapData(degree, 0, 30, 24, 70)",
            height: "mapData(degree, 0, 30, 24, 70)",
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 8,
            label: "data(label)",
            color: labelColor,
            "font-size": 12,
            "text-wrap": "wrap",
            "text-max-width": "90px",
          },
        },
        {
          selector: "edge",
          style: {
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "target-arrow-color": edgeColor,
            "line-color": edgeColor,
            width: 1.5,
            label: "data(label)",
            color: labelColor,
            "font-size": 10,
            "text-rotation": "autorotate",
            "text-margin-x": 6,
            "text-margin-y": 4,
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-width": 3,
            "border-color": cssVar("--text-accent", "#888"),
          },
        },
      ],
      wheelSensitivity: 0.2,
    });
    this.cy = cy;
    this.hoveringNode = false;
    this.wheelBlocker?.();
    // Block wheel-driven zoom while the pointer is over a node or the preview
    // is open — a touch-sensitive mouse/trackpad emits tiny scroll deltas just
    // from moving the cursor, which would otherwise zoom the graph a bit per
    // hover. Ctrl/Cmd+scroll still zooms (browser convention). Capture on
    // <document> runs before cytoscape's capture handler on its container.
    const blockWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        return;
      }
      if (
        (this.hoveringNode || this.previewEl) &&
        this.container.contains(e.target as Node)
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("wheel", blockWheel, { capture: true, passive: false });
    this.wheelBlocker = () => {
      document.removeEventListener("wheel", blockWheel, true);
    };
    // Always lay out a freshly-built graph: with the null layout all nodes sit
    // at the origin, and the ResizeObserver below only re-runs on a size
    // CHANGE — so a same-size rebuild (e.g. after creating a thought) would
    // leave everything piled at one point unless we lay out here directly.
    this.lastLayoutW = 0;
    this.lastLayoutH = 0;
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      this.runLayout(false);
      this.centerGraph();
      this.lastLayoutW = canvas.clientWidth;
      this.lastLayoutH = canvas.clientHeight;
    }
    this.observeCanvas(canvas);

    cy.on("tap", "node", (evt) => {
      this.openThought(String(evt.target.id()));
    });

    cy.on("mouseover", "node", (evt) => {
      this.hoveringNode = true;
      this.showPreview(evt.target as cytoscape.NodeSingular);
    });
    cy.on("mouseout", "node", () => {
      this.hoveringNode = false;
      this.scheduleHidePreview();
    });

    cy.on("cxttap", "node", (evt) => {
      this.showNodeMenu(evt.originalEvent, String(evt.target.id()));
    });
  }

  /**
   * Watch the canvas size and re-run the layout whenever it changes. A freshly
   * opened (or background) tab can have a tiny/zero canvas during the first
   * render; laying out at that size crams all nodes together. The observer
   * fires again once the canvas reaches its real size, so the layout always
   * ends up correct — no more "looks fine after reopen".
   */
  private observeCanvas(canvas: HTMLElement): void {
    this.resizeObs?.disconnect();
    this.resizeObs = new ResizeObserver(() => {
      if (!this.cy) {
        return;
      }
      this.cy.resize();
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && h > 0 && (w !== this.lastLayoutW || h !== this.lastLayoutH)) {
        this.lastLayoutW = w;
        this.lastLayoutH = h;
        this.runLayout(false);
        this.centerGraph();
      }
    });
    this.resizeObs.observe(canvas);
  }

  /** Run the breadthfirst layout. `fit` fits the whole graph into the view. */
  private runLayout(fit: boolean): void {
    if (!this.cy) {
      return;
    }
    this.cy.elements().layout({
      name: "breadthfirst",
      directed: true,
      roots: this.cy.nodes().filter((n) => n.indegree() === 0).map((n) => n.id()),
      spacingFactor: this.spacing,
      animate: false,
      fit,
    } as cytoscape.LayoutOptions).run();
  }

  /**
   * Center the graph at zoom 1 (natural node size — never zoomed out to fit,
   * which is what makes nodes look small and close together on larger graphs).
   * Only zoom to fill when the whole graph already fits at zoom >= 1.
   */
  private centerGraph(): void {
    if (!this.cy) {
      return;
    }
    this.cy.zoom(1);
    this.cy.center(this.cy.elements());
    const box = this.cy.elements().boundingBox();
    const bw = box.x2 - box.x1;
    const bh = box.y2 - box.y1;
    // Zoom to fill only when it needs no more than a modest zoom-in. A
    // filtered-down subset (e.g. one node) would otherwise be blown up to fill
    // the viewport — a single node filling the screen, with its label dwarfed
    // beside it. Keep small subsets at natural size.
    if (bw > 0 && bh > 0 && bw < this.cy.width() && bh < this.cy.height()) {
      const fillZoom = Math.min(
        (this.cy.width() - 100) / bw,
        (this.cy.height() - 100) / bh,
      );
      if (fillZoom <= 1.5) {
        this.cy.fit(this.cy.elements(), 50);
      }
    }
  }

  /** Re-run the layout when the user moves the spacing slider. */
  private relayout(): void {
    // fit:false keeps the current zoom/pan — moving the slider changes node
    // positions only, so nodes and edges never shrink.
    this.runLayout(false);
  }

  /** Show the most similar thoughts in the default folder (local, no API). */
  private async showSimilarity(): Promise<void> {
    const records = this.kb
      .listRecords()
      .filter((r) => this.kb.isInDefaultFolder(r.path));
    const pairs = findSimilarPairs(records, 0.35, 30);
    new SimilarityModal(this.app, pairs, (id) => this.openThought(id)).open();
  }

  /** Open the KB statistics modal (scoped to the default-folder knowledge base). */
  private showStatistics(): void {
    new StatisticsModal(
      this.app,
      this.kb,
      this.kb.stats(true),
      this.getFollowupGroups,
    ).open();
  }

  /** Right-click a node: AI tag/status suggestions, or delete. */
  private showNodeMenu(evt: MouseEvent, id: string): void {
    const thought = this.kb.getThought(id);
    if (!thought) {
      return;
    }
    // The hover preview may be open and, being positioned next to the node,
    // would overlap the context menu and block its items. Hide it first.
    this.hidePreview();
    const settings = this.getSettings();
    const menu = new Menu();
    if (settings.enableAiTags) {
      menu.addItem((item) =>
        item
          .setTitle("Suggest tags (AI)")
          .setIcon("tag")
          .onClick(() =>
            new SuggestTagsModal(this.app, this.kb, this.ai, this.getSettings, thought).open(),
          ),
      );
    }
    if (settings.enableAiStatus) {
      menu.addItem((item) =>
        item
          .setTitle("Suggest status (AI)")
          .setIcon("check")
          .onClick(() =>
            new SuggestStatusModal(this.app, this.kb, this.ai, this.getSettings, thought).open(),
          ),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("Delete").setIcon("trash").onClick(() => void this.maybeDelete(id)),
    );
    menu.showAtMouseEvent(evt);
  }

  /** Right-click a node offers to delete it. */
  private async maybeDelete(id: string): Promise<void> {
    const thought = this.kb.getThought(id);
    if (!thought) {
      return;
    }
    if (window.confirm(`Delete "${thought.title}"? This cannot be undone.`)) {
      await this.kb.deleteThought(id, false);
    }
  }
}

/** Lists the most similar thought pairs with their similarity percentage. */
class SimilarityModal extends Modal {
  private pairs: SimilarPair[];
  private onOpenThought: (id: string) => void;

  constructor(app: App, pairs: SimilarPair[], onOpenThought: (id: string) => void) {
    super(app);
    this.pairs = pairs;
    this.onOpenThought = onOpenThought;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Similar thoughts" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Pairs above 35% similarity, ranked. Click Open to jump to a note.",
    });
    if (this.pairs.length === 0) {
      contentEl.createEl("p", { text: "No similar pairs found in the default folder." });
      return;
    }
    for (const p of this.pairs) {
      const percent = Math.round(p.score * 100);
      new Setting(contentEl)
        .setName(`${p.a} ↔ ${p.b}`)
        .setDesc(`${percent}% similar`)
        .addButton((button) =>
          button.setButtonText("Open").onClick(() => {
            this.close();
            this.onOpenThought(p.a);
          }),
        );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Knowledge base statistics: totals, thought types, and shown follow-ups. */
class StatisticsModal extends Modal {
  private kb: KnowledgeBase;
  private stats: { total: number; by_question_type: Record<string, number> };
  private getFollowupGroups: () => Record<FollowupGroup, FollowupQuestion[]> | null;

  constructor(
    app: App,
    kb: KnowledgeBase,
    stats: { total: number; by_question_type: Record<string, number> },
    getFollowupGroups: () => Record<FollowupGroup, FollowupQuestion[]> | null,
  ) {
    super(app);
    this.kb = kb;
    this.stats = stats;
    this.getFollowupGroups = getFollowupGroups;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Statistics" });

    const graph = this.kb.getGraph(true);
    new Setting(contentEl)
      .setName("Total thoughts")
      .setDesc(`${this.stats.total} in the knowledge base`);
    new Setting(contentEl)
      .setName("Links")
      .setDesc(`${graph.edges.length} in the graph`);

    contentEl.createEl("h4", { text: "By thought type" });
    let anyType = false;
    for (const t of QUESTION_TYPES) {
      const count = this.stats.by_question_type[t] ?? 0;
      if (count > 0) {
        anyType = true;
      }
      new Setting(contentEl).setName(TYPE_LABELS[t]).setDesc(String(count));
    }
    const untyped = this.stats.by_question_type["untyped"] ?? 0;
    if (untyped > 0 || !anyType) {
      new Setting(contentEl).setName("Untyped").setDesc(String(untyped));
    }

    contentEl.createEl("h4", { text: "Follow-up questions" });
    const groups = this.getFollowupGroups();
    if (!groups) {
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "Open a thought in the default folder and let follow-ups generate to see counts here.",
      });
      return;
    }
    let total = 0;
    for (const g of FOLLOWUP_GROUPS) {
      const count = groups[g]?.length ?? 0;
      total += count;
      new Setting(contentEl).setName(TYPE_LABELS[g]).setDesc(String(count));
    }
    new Setting(contentEl).setName("Total").setDesc(String(total));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
