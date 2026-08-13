import { ItemView, Menu, Modal, Setting, TFile, WorkspaceLeaf, type App } from "obsidian";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { FOLLOWUP_GROUPS } from "./ai";
import type { AiService, FollowupGroup, FollowupQuestion } from "./ai";
import { SuggestStatusModal, SuggestTagsModal } from "./aiModals";
import { ConfirmModal } from "./confirmModal";
import { findSimilarPairs, type SimilarPair } from "./bm25";
import { buildContinuousPath, findShortestPath, neighborhoodIds } from "./graphAlgos";
import { KnowledgeBase } from "./knowledgeBase";
import { QUESTION_TYPES, THOUGHT_STATUSES } from "./types";
import type { GraphData, GraphNode, PluginSettings, ThoughtLink } from "./types";

export const GRAPH_VIEW_TYPE = "knowledge-brain-graph";

/** Graph layouts selectable from the toolbar. */
type LayoutName = "breadthfirst" | "concentric" | "cose";

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
  /** Selected graph layout. */
  private layoutName: LayoutName = "breadthfirst";
  /** Neighborhood depth around the focus thought; 0 = show everything. */
  private neighborhoodDepth = 0;
  /** Last indexed thought the user opened (the auto neighborhood center). */
  private activeNoteId: string | null = null;
  /** Manual neighborhood center; null falls back to the active note. */
  private focusId: string | null = null;
  /** Endpoints of the highlighted path (both set = path active). */
  private pathSourceId: string | null = null;
  private pathTargetId: string | null = null;
  /** Node ids of a citation-path highlight (from the chat's "Show in graph"). */
  private highlightPathIds: string[] | null = null;
  /** The "Clear path" toolbar button (always present, hidden when inactive). */
  private clearPathBtn: HTMLButtonElement | null = null;
  /** Knowledge growth timeline state (survives the full re-renders). */
  private timelineActive = false;
  private timelinePlaying = false;
  private timelineIndex = 0;
  private timelineSpeed = 1;
  private timelineTimes: string[] = [];
  private timelineTimer: number | null = null;
  private timelineBar: HTMLElement | null = null;
  private timelineScrubber: HTMLInputElement | null = null;
  private timelineLabel: HTMLElement | null = null;
  private timelinePlayBtn: HTMLButtonElement | null = null;
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
    // Seed the neighborhood center with whatever note is active on open.
    const file = this.app.workspace.getActiveFile();
    if (
      file instanceof TFile &&
      file.extension === "md" &&
      this.kb.getRecord(file.basename)
    ) {
      this.activeNoteId = file.basename;
    }
    // The preview is mounted on <body> (not inside this container), so it would
    // keep showing even after the graph tab loses focus. Hide it the moment the
    // graph view is no longer the active leaf — e.g. when the user opens a note.
    // The same event tracks the active thought for the neighborhood view.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf !== this.leaf) {
          this.hidePreview();
        }
        const current = this.app.workspace.getActiveFile();
        // Only ever SET the tracked note — never null it out. Focusing the
        // graph tab (or another non-note view) yields getActiveFile() === null
        // and would otherwise wipe the neighborhood center mid-look.
        if (
          current instanceof TFile &&
          current.extension === "md" &&
          this.kb.getRecord(current.basename)
        ) {
          const next = current.basename;
          if (next !== this.activeNoteId) {
            this.activeNoteId = next;
            // Follow the active note only in auto mode (no manual focus) and
            // only when the neighborhood view is actually engaged.
            if (this.neighborhoodDepth > 0 && this.focusId === null) {
              this.render();
            }
          }
        }
      }),
    );
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe();
    this.stopTimelineTimer();
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

    // Apply status/tag filters, then the neighborhood view. Edges whose
    // endpoints are filtered out go too.
    const { nodes, edges } = this.computeFilteredGraph(graph);

    const canvas = this.container.createDiv({ cls: "kb-graph-canvas" });
    const toolbar = this.container.createDiv({ cls: "kb-graph-toolbar" });
    const count = toolbar.createSpan({
      cls: "kb-graph-count",
      text: `${nodes.length} thoughts · ${edges.length} links`,
    });
    void count;

    const statusSelect = toolbar.createEl("select");
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

    const tagSelect = toolbar.createEl("select");
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
    slider.value = String(this.spacing);
    const val = toolbar.createSpan({ text: this.spacing.toFixed(1) });
    slider.oninput = () => {
      const v = parseFloat(slider.value) || this.spacing;
      this.spacing = v;
      val.setText(v.toFixed(1));
      this.setSpacing(v);
      this.relayout();
    };

    toolbar.createSpan({ text: "Layout:" });
    const layoutSelect = toolbar.createEl("select");
    layoutSelect.addClass("kb-graph-filter");
    const layoutOptions: Array<[LayoutName, string]> = [
      ["breadthfirst", "Breadth-first"],
      ["concentric", "Concentric"],
      ["cose", "CoSE (force)"],
    ];
    for (const [value, label] of layoutOptions) {
      layoutSelect.createEl("option", { text: label, attr: { value } });
    }
    layoutSelect.value = this.layoutName;
    layoutSelect.onchange = () => {
      this.layoutName = layoutSelect.value as LayoutName;
      // Fit so the newly arranged graph is fully visible; classes persist on
      // the same cy instance, so re-apply the path highlight afterwards.
      this.runLayout(true);
      this.applyPathHighlight();
    };

    toolbar.createSpan({ text: "Neighborhood:" });
    const hoodSelect = toolbar.createEl("select");
    hoodSelect.addClass("kb-graph-filter");
    const hoodOptions: Array<[string, string]> = [
      ["0", "Off"],
      ["1", "1 hop"],
      ["2", "2 hops"],
      ["3", "3 hops"],
    ];
    for (const [value, label] of hoodOptions) {
      hoodSelect.createEl("option", { text: label, attr: { value } });
    }
    hoodSelect.value = String(this.neighborhoodDepth);
    hoodSelect.onchange = () => {
      this.neighborhoodDepth = Number(hoodSelect.value);
      this.render();
    };

    if (this.neighborhoodDepth > 0) {
      const focus = this.currentFocus();
      const focusLabel = toolbar.createSpan({
        cls: "kb-graph-focus-label",
        text: focus ? `Focus: ${focus}` : "Focus: none",
      });
      void focusLabel;
      const changeFocus = toolbar.createEl("button", {
        cls: "mod-muted",
        text: "Change",
        attr: { title: "Pick a thought to center the neighborhood on" },
      });
      changeFocus.onclick = () => this.chooseFocus();
      const clearFocus = toolbar.createEl("button", {
        cls: "mod-muted",
        text: "✕",
        attr: { title: "Center on the active note instead" },
      });
      clearFocus.onclick = () => {
        this.focusId = null;
        this.render();
      };
    }

    const pathBtn = toolbar.createEl("button", {
      cls: "mod-muted",
      text: "Highlight path",
      attr: { title: "Highlight the shortest path between two thoughts" },
    });
    pathBtn.onclick = () => this.showPathPicker();
    // Always render the clear button (hidden unless a path is active) so it is
    // present in the toolbar without requiring a full re-render to appear.
    const clearPath = toolbar.createEl("button", {
      cls: "mod-muted",
      text: "Clear path",
      attr: { title: "Remove the path highlight" },
    });
    clearPath.toggleClass(
      "kb-hidden",
      !(this.pathSourceId && this.pathTargetId) &&
        !(this.highlightPathIds && this.highlightPathIds.length > 0),
    );
    clearPath.onclick = () => {
      this.pathSourceId = null;
      this.pathTargetId = null;
      this.highlightPathIds = null;
      // Keep the button in the DOM (hidden) — showPathPicker re-shows it on the
      // next highlight. Removing it here would orphan the next highlight with no
      // way to clear it until the whole view re-renders.
      if (this.clearPathBtn) {
        this.clearPathBtn.addClass("kb-hidden");
      }
      this.applyPathHighlight();
    };
    this.clearPathBtn = clearPath;

    const exportBtn = toolbar.createEl("button", {
      cls: "mod-muted",
      text: "Export PNG",
      attr: { title: "Download the current graph as a PNG image" },
    });
    exportBtn.onclick = () => {
      if (!this.cy) {
        return;
      }
      // Render the whole graph (not just the visible viewport) at 2x for a
      // crisp shareable image, on the app's background so theme-colored labels
      // stay readable on a light viewer.
      const pngUrl = this.cy.png({
        full: true,
        scale: 2,
        bg: cssVar("--background-primary", "#ffffff"),
      });
      const a = this.container.createEl("a", {
        attr: {
          href: pngUrl,
          download: `knowledge-brain-graph-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
        },
      });
      a.click();
      a.remove();
    };

    const timelineBtn = toolbar.createEl("button", {
      cls: "mod-muted",
      text: "Timeline",
      attr: { title: "Animate the graph from the first thought to now" },
    });
    timelineBtn.onclick = () => {
      this.timelineActive = !this.timelineActive;
      if (!this.timelineActive) {
        this.stopTimelineTimer();
        this.timelinePlaying = false;
      }
      this.render();
    };

    // The playback bar sits below the toolbar and only exists while the
    // timeline is active. Built mid-render it must NOT touch `this.cy` (still
    // the previous instance) — restoreTimeline() at the end of render() wires
    // it to the fresh graph.
    if (this.timelineActive && nodes.length > 0) {
      this.renderTimelineBar();
    }

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
          created_at: n.created_at,
          updated_at: n.updated_at,
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
        {
          selector: "node.kb-graph-focus",
          style: {
            "border-width": 4,
            "border-color": cssVar("--interactive-accent", "#888"),
            "text-outline-width": 2,
            "text-outline-color": cssVar("--background-primary", "#fff"),
          },
        },
        {
          selector: "node.kb-path-node",
          style: {
            "border-width": 3,
            "border-color": cssVar("--text-accent", "#888"),
          },
        },
        {
          selector: "edge.kb-path-edge",
          style: {
            "line-color": cssVar("--text-accent", "#888"),
            "target-arrow-color": cssVar("--text-accent", "#888"),
            width: 3,
          },
        },
        {
          selector: "node.kb-dimmed, edge.kb-dimmed",
          style: {
            opacity: 0.12,
          },
        },
        {
          selector: "node.kb-hidden",
          style: {
            display: "none",
          },
        },
        {
          selector: "edge.kb-hidden",
          style: {
            display: "none",
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
    this.applyPathHighlight();
    // Re-apply the timeline to the fresh graph (render() rebuilt everything).
    // Runs last so hidden nodes never influence layout/centering above.
    if (this.timelineActive) {
      this.restoreTimeline();
    }

    cy.on("tap", "node", (evt) => {
      this.openThought((evt.target as cytoscape.NodeSingular).id());
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
      this.showNodeMenu(
        evt.originalEvent,
        (evt.target as cytoscape.NodeSingular).id(),
      );
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

  /**
   * Run the selected layout. `fit` fits the whole graph into the view. All
   * layouts honor `spacing` via `spacingFactor` so the spacing slider keeps
   * working across them.
   */
  private runLayout(fit: boolean): void {
    if (!this.cy) {
      return;
    }
    switch (this.layoutName) {
      case "concentric":
        this.cy.elements().layout({
          name: "concentric",
          spacingFactor: this.spacing,
          minNodeSpacing: 12,
          avoidOverlap: true,
          nodeDimensionsIncludeLabels: true,
          concentric: (node: cytoscape.NodeSingular) => node.degree(),
          levelWidth: () => 1,
          animate: false,
          fit,
        }).run();
        break;
      case "cose":
        this.cy.elements().layout({
          name: "cose",
          randomize: true,
          // Let the physics treat labels as part of the node box so labels of
          // adjacent nodes don't collide; the spacing slider is applied below.
          nodeDimensionsIncludeLabels: true,
          animate: false,
          fit: false,
        }).run();
        // This cytoscape build applies layout `spacingFactor` only through the
        // animated layoutPositions path, which animate:false skips — so the
        // slider silently did nothing on cose. Replicate the dilation here.
        this.dilateSpacing();
        if (fit) {
          this.cy.fit(this.cy.elements(), 50);
        }
        break;
      default:
        this.cy.elements().layout({
          name: "breadthfirst",
          directed: true,
          roots: this.cy.nodes().filter((n) => n.indegree() === 0).map((n) => n.id()),
          spacingFactor: this.spacing,
          animate: false,
          fit,
        }).run();
    }
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

  /** Scale every node's position away from the graph center by `spacing`. */
  private dilateSpacing(): void {
    if (!this.cy) {
      return;
    }
    const box = this.cy.elements().boundingBox();
    const midX = box.x1 + (box.x2 - box.x1) / 2;
    const midY = box.y1 + (box.y2 - box.y1) / 2;
    this.cy.nodes().forEach((n) => {
      const p = n.position();
      n.position({
        x: midX + (p.x - midX) * this.spacing,
        y: midY + (p.y - midY) * this.spacing,
      });
    });
  }

  /**
   * The nodes/edges actually shown: status + tag filters, then the
   * neighborhood of the focus thought when neighborhood view is on. Shared by
   * render() and applyPathHighlight() so both operate on the same visible set.
   */
  private computeFilteredGraph(graph: GraphData): {
    nodes: GraphNode[];
    edges: ThoughtLink[];
  } {
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
    let kept = new Set(nodes.map((n) => n.id));
    let edges = graph.edges.filter(
      (e) => kept.has(e.parent_id) && kept.has(e.child_id),
    );
    if (this.neighborhoodDepth > 0) {
      const focus = this.currentFocus();
      if (focus && kept.has(focus)) {
        const hood = neighborhoodIds(focus, this.neighborhoodDepth, edges);
        nodes = nodes.filter((n) => hood.has(n.id));
        kept = new Set(nodes.map((n) => n.id));
        edges = edges.filter(
          (e) => kept.has(e.parent_id) && kept.has(e.child_id),
        );
      }
    }
    return { nodes, edges };
  }

  /** The neighborhood center: manual override, else the active note, if indexed. */
  private currentFocus(): string | null {
    const id = this.focusId ?? this.activeNoteId;
    return id && this.kb.getRecord(id) ? id : null;
  }

  /** Apply the focus ring + path highlight to the current graph. */
  private applyPathHighlight(): void {
    if (!this.cy) {
      return;
    }
    this.cy
      .elements()
      .removeClass("kb-graph-focus kb-path-node kb-path-edge kb-dimmed");
    const { nodes } = this.computeFilteredGraph(this.kb.getGraph(true));
    if (this.neighborhoodDepth > 0) {
      const focus = this.currentFocus();
      if (focus && nodes.some((n) => n.id === focus)) {
        this.cy.getElementById(focus).addClass("kb-graph-focus");
      }
    }
    const pathResult = this.currentPath();
    if (!pathResult || pathResult.path.length === 0) {
      return;
    }
    const { path, edges } = pathResult;
    if (path.length === 1) {
      if (this.cy.getElementById(path[0]).length > 0) {
        this.cy.getElementById(path[0]).addClass("kb-path-node");
      }
      return;
    }
    const pathSet = new Set(path);
    this.cy.nodes().forEach((n) => {
      n.addClass(pathSet.has(n.id()) ? "kb-path-node" : "kb-dimmed");
    });
    const edgeIds = new Set<string>();
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const e = edges.find(
        (edge) =>
          (edge.parent_id === a && edge.child_id === b) ||
          (edge.parent_id === b && edge.child_id === a),
      );
      if (e) {
        edgeIds.add(e.id);
      }
    }
    this.cy.edges().forEach((e) => {
      e.addClass(edgeIds.has(String(e.id())) ? "kb-path-edge" : "kb-dimmed");
    });
  }

  /**
   * The path to highlight: the citation chain when one is set (chained over the
   * FULL default-folder graph, so cited thoughts connect even through
   * filtered-out intermediaries), else the manual picker's shortest path over
   * the currently visible edges. Only classes on elements that exist in `cy`
   * have any effect, so filtered-out ids are inert.
   */
  private currentPath(): { path: string[]; edges: ThoughtLink[] } | null {
    if (this.highlightPathIds && this.highlightPathIds.length > 0) {
      const full = this.kb.getGraph(true);
      return {
        path: buildContinuousPath(this.highlightPathIds, full.edges),
        edges: full.edges,
      };
    }
    if (!this.pathSourceId || !this.pathTargetId) {
      return null;
    }
    const { edges } = this.computeFilteredGraph(this.kb.getGraph(true));
    return {
      path: findShortestPath(this.pathSourceId, this.pathTargetId, edges) ?? [],
      edges,
    };
  }

  /**
   * Highlight a concrete set of node ids (e.g. thoughts the chat cited),
   * chaining shortest paths between them over the full default-folder graph.
   * If a cited node is not currently rendered, the view expands (clears
   * status/tag/neighborhood filters) so a citation can never silently fail to
   * highlight.
   */
  highlightPath(ids: string[]): void {
    if (!this.cy) {
      this.highlightPathIds = ids.length > 0 ? ids : null;
      return;
    }
    const full = this.kb.getGraph(true);
    const present = new Set(full.nodes.map((n) => n.id));
    const kept = ids.filter((id) => present.has(id));
    if (kept.length === 0) {
      return;
    }
    this.highlightPathIds = kept;
    const visible = new Set(this.cy.nodes().map((n) => n.id()));
    if (kept.some((id) => !visible.has(id))) {
      this.statusFilter = "";
      this.tagFilter = "";
      this.neighborhoodDepth = 0;
      this.focusId = null;
      this.render();
    } else {
      this.applyPathHighlight();
    }
    if (this.clearPathBtn) {
      this.clearPathBtn.removeClass("kb-hidden");
    }
    const eles = this.cy.getElementById(kept.join(","));
    if (eles.length > 0) {
      this.cy.fit(eles, 50);
    }
  }

  /** Build the playback bar (play, reset, scrubber, date, speed). */
  private renderTimelineBar(): void {
    const bar = this.container.createDiv({ cls: "kb-graph-timeline" });
    this.timelineBar = bar;

    const play = bar.createEl("button", {
      cls: "mod-muted",
      text: "Play",
      attr: { title: "Play the growth animation" },
    });
    this.timelinePlayBtn = play;

    const reset = bar.createEl("button", {
      cls: "mod-muted",
      text: "↺",
      attr: { title: "Restart from the first thought" },
    });

    const scrubber = bar.createEl("input", {
      cls: "kb-timeline-scrubber",
      attr: { type: "range", min: "0", max: "0", step: "1", value: "0" },
    });
    this.timelineScrubber = scrubber;

    const label = bar.createSpan({ cls: "kb-timeline-date", text: "" });
    this.timelineLabel = label;

    const speed = bar.createEl("select");
    speed.addClass("kb-graph-filter");
    for (const v of [0.5, 1, 2]) {
      speed.createEl("option", { text: `${v}×`, attr: { value: String(v) } });
    }
    speed.value = String(this.timelineSpeed);

    play.onclick = () => this.toggleTimelinePlay();
    reset.onclick = () => {
      this.timelineIndex = 0;
      this.timelinePlaying = false;
      this.applyTimeline();
      this.updateTimelineUi();
    };
    scrubber.oninput = () => {
      this.timelinePlaying = false;
      this.timelineIndex = Number(scrubber.value);
      this.applyTimeline();
      this.updateTimelineUi();
    };
    speed.onchange = () => {
      this.timelineSpeed = Number(speed.value);
      if (this.timelinePlaying) {
        this.restartTimelineTimer();
      }
    };
  }

  private toggleTimelinePlay(): void {
    if (this.timelinePlaying) {
      this.stopTimelineTimer();
      this.timelinePlaying = false;
      this.updateTimelineUi();
      return;
    }
    if (this.timelineTimes.length <= 1) {
      return;
    }
    if (this.timelineIndex >= this.timelineTimes.length - 1) {
      this.timelineIndex = 0;
    }
    this.timelinePlaying = true;
    this.updateTimelineUi();
    this.restartTimelineTimer();
  }

  private restartTimelineTimer(): void {
    this.stopTimelineTimer();
    const interval = Math.max(120, 800 / this.timelineSpeed);
    this.timelineTimer = window.setInterval(() => {
      if (this.timelineIndex >= this.timelineTimes.length - 1) {
        this.stopTimelineTimer();
        this.timelinePlaying = false;
        this.updateTimelineUi();
        return;
      }
      this.timelineIndex++;
      this.applyTimeline();
      this.updateTimelineUi();
    }, interval);
  }

  private stopTimelineTimer(): void {
    if (this.timelineTimer !== null) {
      window.clearInterval(this.timelineTimer);
      this.timelineTimer = null;
    }
  }

  /** Recompute the step list from the CURRENT graph, clamp the index, apply. */
  private restoreTimeline(): void {
    if (!this.cy) {
      return;
    }
    const times = new Set<string>();
    this.cy.nodes().forEach((n) => {
      const t = String(n.data("created_at") ?? "");
      if (t) {
        times.add(t);
      }
    });
    this.timelineTimes = [...times].sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );
    if (this.timelineIndex >= this.timelineTimes.length) {
      this.timelineIndex = Math.max(0, this.timelineTimes.length - 1);
    }
    this.applyTimeline();
    this.updateTimelineUi();
  }

  /** Hide nodes created after the cursor and edges touching a hidden node. */
  private applyTimeline(): void {
    if (!this.cy || this.timelineTimes.length === 0) {
      return;
    }
    const cursor = new Date(this.timelineTimes[this.timelineIndex]).getTime();
    const hidden = new Set<string>();
    this.cy.nodes().forEach((n) => {
      const t = String(n.data("created_at") ?? "");
      const ms = t ? new Date(t).getTime() : Number.NEGATIVE_INFINITY;
      const h = Number.isFinite(ms) && ms > cursor;
      if (h) {
        hidden.add(n.id());
      }
      n.toggleClass("kb-hidden", h);
    });
    this.cy.edges().forEach((e) => {
      e.toggleClass(
        "kb-hidden",
        hidden.has(String(e.data("source"))) || hidden.has(String(e.data("target"))),
      );
    });
  }

  private updateTimelineUi(): void {
    if (this.timelineScrubber) {
      this.timelineScrubber.max = String(Math.max(0, this.timelineTimes.length - 1));
      this.timelineScrubber.value = String(this.timelineIndex);
    }
    if (this.timelineLabel) {
      const t = this.timelineTimes[this.timelineIndex];
      this.timelineLabel.setText(t ? new Date(t).toLocaleDateString() : "");
    }
    if (this.timelinePlayBtn) {
      this.timelinePlayBtn.setText(this.timelinePlaying ? "Pause" : "Play");
      this.timelinePlayBtn.disabled = this.timelineTimes.length <= 1;
    }
  }

  /** Open the modal that picks the two endpoints of the path to highlight. */
  private showPathPicker(): void {
    new PathPickerModal(this.app, this.kb, (source, target) => {
      this.highlightPathIds = null;
      this.pathSourceId = source;
      this.pathTargetId = target;
      if (this.clearPathBtn) {
        this.clearPathBtn.removeClass("kb-hidden");
      }
      this.applyPathHighlight();
    }).open();
  }

  /** Open the modal that picks the neighborhood center. */
  private chooseFocus(): void {
    new FocusPickerModal(this.app, this.kb, (id) => {
      this.focusId = id;
      this.render();
    }).open();
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
  private maybeDelete(id: string): void {
    const thought = this.kb.getThought(id);
    if (!thought) {
      return;
    }
    new ConfirmModal(this.app, `Delete "${thought.title}"? This cannot be undone.`, () => {
      void this.kb.deleteThought(id, false);
    }).open();
  }
}

const PICKER_MAX = 12;

/**
 * A searchable thought picker: an input that filters the KB (via the memoized
 * BM25 index) plus a list of clickable result rows. Picking fills the input
 * with the chosen title and fires `onPick` with its id.
 */
function buildThoughtPicker(
  container: HTMLElement,
  kb: KnowledgeBase,
  onPick: (id: string) => void,
  placeholder: string,
): HTMLInputElement {
  const input = container.createEl("input", {
    cls: "kb-search-input",
    attr: { type: "text", placeholder },
  });
  const results = container.createDiv({ cls: "kb-search-results" });
  let debounce: number | null = null;
  const render = (query: string) => {
    const items = query.trim()
      ? kb.search(query.trim(), PICKER_MAX)
      : [...kb.listRecords()].reverse().slice(0, PICKER_MAX);
    results.empty();
    if (items.length === 0) {
      results.createEl("p", {
        cls: "kb-search-empty",
        text: "No matching thoughts.",
      });
      return;
    }
    for (const rec of items) {
      const row = results.createDiv({ cls: "kb-search-row" });
      row.createDiv({ cls: "kb-search-title", text: rec.title });
      row.onclick = () => {
        input.value = rec.title;
        results.empty();
        onPick(rec.id);
      };
    }
  };
  input.oninput = () => {
    if (debounce !== null) {
      window.clearTimeout(debounce);
    }
    debounce = window.setTimeout(() => render(input.value), 80);
  };
  render("");
  return input;
}

/** Pick two thoughts; highlights the shortest path between them. */
class PathPickerModal extends Modal {
  private kb: KnowledgeBase;
  private onHighlight: (source: string, target: string) => void;
  private source: string | null = null;
  private target: string | null = null;
  private applyBtn: HTMLButtonElement;

  constructor(
    app: App,
    kb: KnowledgeBase,
    onHighlight: (source: string, target: string) => void,
  ) {
    super(app);
    this.kb = kb;
    this.onHighlight = onHighlight;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("kb-search-modal");
    contentEl.createEl("h3", { text: "Highlight path" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Pick two thoughts — the shortest connecting path is highlighted.",
    });
    buildThoughtPicker(
      contentEl,
      this.kb,
      (id) => {
        this.source = id;
        this.updateApply();
      },
      "Source thought…",
    );
    buildThoughtPicker(
      contentEl,
      this.kb,
      (id) => {
        this.target = id;
        this.updateApply();
      },
      "Target thought…",
    );
    this.applyBtn = contentEl.createEl("button", {
      cls: "mod-cta",
      text: "Highlight",
    });
    this.applyBtn.disabled = true;
    this.applyBtn.onclick = () => {
      if (this.source && this.target) {
        this.close();
        this.onHighlight(this.source, this.target);
      }
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private updateApply(): void {
    this.applyBtn.disabled = !(this.source && this.target);
  }
}

/** Pick the thought the neighborhood view is centered on. */
class FocusPickerModal extends Modal {
  private kb: KnowledgeBase;
  private onPick: (id: string) => void;

  constructor(app: App, kb: KnowledgeBase, onPick: (id: string) => void) {
    super(app);
    this.kb = kb;
    this.onPick = onPick;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("kb-search-modal");
    contentEl.createEl("h3", { text: "Focus neighborhood on…" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Pick a thought; only its surrounding thoughts are shown.",
    });
    buildThoughtPicker(
      contentEl,
      this.kb,
      (id) => {
        this.close();
        this.onPick(id);
      },
      "Thought to focus…",
    );
  }

  onClose(): void {
    this.contentEl.empty();
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
