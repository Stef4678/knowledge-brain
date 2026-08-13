/**
 * Node smoke tests for the core KnowledgeBase + BM25 logic, running against
 * the Obsidian stub. Not part of the plugin bundle.
 */
import { KnowledgeBase, sanitizeTitle } from "../src/knowledgeBase";
import { QUESTION_TYPES } from "../src/types";
import { buildBm25Index, findSimilarPairs, tokenCosine } from "../src/bm25";
import { buildContinuousPath, findShortestPath, neighborhoodIds } from "../src/graphAlgos";
import { parseCitations } from "../src/citations";
import { FakeVault, fakeApp } from "./obsidian-stub";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

async function main(): Promise<void> {
  // ------------------------------------------------------- rebuild + DAG
  {
    const vault = new FakeVault();
    vault.set(
      "Alpha.md",
      "---\nparents:\n  - 'Beta'\n---\n\nBody of Alpha.",
    );
    vault.set("Beta.md", "---\n---\n\nBody of Beta.");
    vault.set("Gamma.md", "---\nparents:\n  - 'Beta'\n---\n\nBody of Gamma.");
    vault.set("Delta.md", "---\nparents:\n  - 'Alpha'\n---\n\nBody of Delta.");
    vault.set("tags-note.md", "---\ntags:\n  - work\ncreated_at: '2026-01-01T00:00:00Z'\n---\n\nBody.");
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    await kb.load();

    check("load: 5 active thoughts", kb.listThoughts().length === 5, kb.listThoughts().length);

    const beta = kb.getThought("Beta")!;
    check("Beta children = Alpha, Gamma", beta.children.length === 2);
    const alpha = kb.getThought("Alpha")!;
    check("Alpha parent = Beta", alpha.parents.length === 1 && alpha.parents[0].id === "Beta");
    check("Alpha children = Delta", alpha.children.map((c) => c.id).join() === "Delta");
    const betaSiblings = beta.children.filter((c) => c.id !== "Beta");
    void betaSiblings;
    check(
      "Alpha siblings = Gamma",
      alpha.siblings.map((s) => s.id).sort().join() === "Gamma",
    );

    const graph = kb.getGraph();
    check("graph: 5 nodes", graph.nodes.length === 5);
    check("graph: 3 edges", graph.edges.length === 3, graph.edges.length);
    check("edge has direction", graph.edges.some((e) => e.parent_id === "Beta" && e.child_id === "Alpha"));

    // first-class tags parsed; unrelated frontmatter still preserved
    const tagsNote = kb.getRecord("tags-note")!;
    check("tags parsed as first-class field", tagsNote.tags.join() === "work");

    // ---------------------------------------------- create / cycle checks
    const x = await kb.createThought("X", "content of X", ["Alpha"]);
    check("create X under Alpha", x.parents.length === 1 && x.parents[0].id === "Alpha");

    let selfRejected = false;
    try {
      await kb.createThought("Y", "body of Y", ["Y"]);
    } catch {
      selfRejected = true;
    }
    check("self-link rejected", selfRejected);

    let dupRejected = false;
    try {
      await kb.createThought("X", "dup");
    } catch {
      dupRejected = true;
    }
    check("duplicate title rejected", dupRejected);

    // rename propagates to children refs (active thought)
    await kb.renameThought("Gamma", "GammaRenamed");
    const betaChildren = kb.getThought("Beta")!.children.map((c) => c.id);
    check("rename updates children refs", betaChildren.includes("GammaRenamed"), betaChildren);

    // descendants / cascade delete
    const desc = kb.descendantsOf("Alpha");
    check("descendants of Alpha = Delta,X", desc.sort().join() === "Delta,X", desc);

    await kb.deleteThought("Beta", true);
    const active = kb.listThoughts().map((t) => t.id).sort();
    check(
      "cascade delete removes Beta, Alpha, GammaRenamed, Delta, X",
      active.join() === "tags-note",
      active,
    );
    check(
      "cascade delete removes the files",
      !vault.files.has("Beta.md") &&
        !vault.files.has("Alpha.md") &&
        !vault.files.has("GammaRenamed.md") &&
        !vault.files.has("Delta.md") &&
        !vault.files.has("X.md") &&
        vault.files.has("tags-note.md"),
      [...vault.files.keys()],
    );
  }

  // ------------------------------------------------------------- BM25
  {
    const vault = new FakeVault();
    vault.set("Scoala.md", "---\n---\n\nȘcoala din sat are 300 de copii.");
    vault.set("React.md", "---\n---\n\nReact is a JavaScript library for building UIs.");
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    await kb.load();
    const index = buildBm25Index(kb.listRecords());
    const hits = index.search("scoala copii", 5);
    check("BM25: diacritics-insensitive hit", hits.length === 1 && hits[0].id === "Scoala", hits.map((h) => h.id));
    const enHits = index.search("javascript library", 5);
    check("BM25: English hit", enHits.length === 1 && enHits[0].id === "React");
    check("BM25: stopwords-only query → []", index.search("the a an", 5).length === 0);
  }

  // ------------------------------------------------------ restart persistence
  {
    const vault = new FakeVault();
    vault.set("A.md", "---\n---\n\nA body");
    vault.set("B.md", "---\nparents:\n  - 'A'\n---\n\nB body");
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    await kb.load();
    await kb.deleteThought("B", false);
    check(
      "delete removes the file entirely",
      !vault.files.has("B.md") && !vault.files.has(".trash/B.md"),
      [...vault.files.keys()],
    );
    const kb2 = new KnowledgeBase(fakeApp(vault) as never);
    await kb2.load();
    check(
      "deleted thought stays gone after restart",
      kb2.listThoughts().map((t) => t.id).join() === "A",
      kb2.listThoughts().map((t) => t.id),
    );
  }

  // ------------------------------------------------------- default folder
  {
    const vault = new FakeVault();
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    kb.setDefaultFolder("Thoughts");
    await kb.load();
    // Simulate typing the folder in settings: the string changes repeatedly,
    // but no folder/file must be created until a thought is actually written.
    kb.setDefaultFolder("T");
    kb.setDefaultFolder("Th");
    kb.setDefaultFolder("Tho");
    kb.setDefaultFolder("Thoughts");
    const hasThoughtsPrefix = [...vault.files.keys()].some((p) => p.startsWith("Thoughts"));
    check(
      "typing folder does not create folders",
      !hasThoughtsPrefix,
      [...vault.files.keys()],
    );
    await kb.createThought("NewIdea", "some content");
    check(
      "new thought lands in default folder",
      vault.files.has("Thoughts/NewIdea.md"),
      [...vault.files.keys()],
    );
    check(
      "index sees thought by basename",
      kb.getThought("NewIdea") !== null,
    );
    await kb.deleteThought("NewIdea", false);
    check(
      "delete removes the thought file",
      !vault.files.has("Thoughts/NewIdea.md"),
      [...vault.files.keys()],
    );
  }

  // ------------------------------------------------------------- siblingsOf
  {
    const vault = new FakeVault();
    vault.set("A.md", "---\n---\n\nA");
    vault.set("B.md", "---\nparents:\n  - 'A'\n---\n\nB");
    vault.set("C.md", "---\nparents:\n  - 'A'\n---\n\nC");
    vault.set("D.md", "---\nparents:\n  - 'C'\n---\n\nD");
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    await kb.load();
    const sibOfB = kb.siblingsOf("B").map((r) => r.id).sort();
    check("siblingsOf: B shares parent A with C", sibOfB.join() === "C", sibOfB);
    check("siblingsOf: A has no parents, none", kb.siblingsOf("A").length === 0);
    check(
      "siblingsOf: D (only parent C, no other child of C) has none",
      kb.siblingsOf("D").length === 0,
    );
    check("siblingsOf: unknown id returns empty", kb.siblingsOf("nope").length === 0);
  }

  // ------------------------------------------------- graph default-folder filter
  {
    const vault = new FakeVault();
    vault.set("Thoughts/Root.md", "---\n---\n\nRoot body");
    vault.set("Thoughts/Child.md", "---\nparents:\n  - 'Root'\n---\n\nChild body");
    vault.set("Elsewhere/Outside.md", "---\nparents:\n  - 'Root'\n---\n\nOutside body");
    vault.set("Elsewhere/Solo.md", "---\n---\n\nSolo body");
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    kb.setDefaultFolder("Thoughts");
    await kb.load();
    const full = kb.getGraph(false);
    check("graph: all notes when unfiltered", full.nodes.length === 4, full.nodes.length);
    const filtered = kb.getGraph(true);
    check(
      "graph: only default-folder notes when filtered",
      filtered.nodes.length === 2 &&
        filtered.nodes.every((n) => ["Root", "Child"].includes(n.id)),
      filtered.nodes.map((n) => n.id),
    );
    check(
      "graph: filtered edges stay within default folder",
      filtered.edges.length === 1 &&
        filtered.edges.every((e) => ["Root", "Child"].includes(e.parent_id) && ["Root", "Child"].includes(e.child_id)),
      filtered.edges,
    );
  }

  // -------------------------------------------------------- question types
  {
    const vault = new FakeVault();
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    await kb.load();
    const typed = await kb.createThought("TypedThought", "body", [], "causal");
    check("createThought sets question_type", typed.question_type === "causal");
    const typedFile = vault.files.get("TypedThought.md") ?? "";
    check(
      "question_type appears in generated file",
      /question_type: causal/.test(typedFile),
      typedFile,
    );
    const untyped = await kb.createThought("PlainThought", "body");
    check("createThought defaults question_type empty", untyped.question_type === "");
    const invalid = await kb.createThought("BadTypeThought", "body", [], "nonsense");
    check("createThought rejects unknown type", invalid.question_type === "");
    check(
      "QUESTION_TYPES has 6 values",
      QUESTION_TYPES.length === 6 && QUESTION_TYPES.includes("critical"),
      QUESTION_TYPES,
    );
  }

  // --------------------------------------------------------- tags & status
  {
    const vault = new FakeVault();
    vault.set(
      "Tagged.md",
      "---\ntags:\n  - work\n  - personal\nstatus: done\nquestion_type: causal\nx-custom: hi\n---\n\nTagged body.",
    );
    vault.set("CommaTags.md", "---\ntags: 'a, b, a'\n---\n\nComma body.");
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    await kb.load();

    const tagged = kb.getRecord("Tagged")!;
    check("tags parsed from frontmatter", tagged.tags.join() === "work,personal", tagged.tags);
    check("status parsed from frontmatter", tagged.status === "done");
    check("tags removed from extra", tagged.extra.tags === undefined, tagged.extra);
    check("status removed from extra", tagged.extra.status === undefined);
    check("custom extra field preserved", tagged.extra["x-custom"] === "hi", tagged.extra);

    const comma = kb.getRecord("CommaTags")!;
    check("comma-string tags split + deduped", comma.tags.join() === "a,b", comma.tags);

    const t1 = await kb.createThought("T1", "body", [], "", ["x", "y"], "in progress");
    check("createThought sets tags", t1.tags.join() === "x,y", t1.tags);
    check("createThought sets status", t1.status === "in progress");
    const file1 = vault.files.get("T1.md") ?? "";
    check("tags written to file", /tags:\n\s*- x\n\s*- ['"]?y/.test(file1), file1);
    check("status written to file", /status: ["']?in progress/.test(file1), file1);

    const g = kb.getGraph();
    const node1 = g.nodes.find((n) => n.id === "T1")!;
    check("graph node carries tags", node1.tags.join() === "x,y");
    check("graph node carries status", node1.status === "in progress");
    const taggedNode = g.nodes.find((n) => n.id === "Tagged")!;
    check("graph node carries status from frontmatter", taggedNode.status === "done");

    check(
      "allTags sorted unique across records",
      kb.allTags().join() === "a,b,personal,work,x,y",
      kb.allTags(),
    );

    await kb.updateThought("T1", { tags: ["z"], status: "done" });
    check("updateThought sets tags", kb.getRecord("T1")!.tags.join() === "z");
    check("updateThought sets status", kb.getRecord("T1")!.status === "done");
    await kb.updateThought("T1", { status: "" });
    check("updateThought clears status", kb.getRecord("T1")!.status === "");

    // Multi-word tags are normalized to a valid Obsidian tag (hyphens, no
    // spaces), so Obsidian never renders them struck-out as invalid.
    await kb.updateThought("T1", { tags: ["machine learning", "ai", " two  word ", "#prefixed"] });
    check(
      "tags normalize spaces to hyphens",
      kb.getRecord("T1")!.tags.join() === "machine-learning,ai,two-word,prefixed",
      kb.getRecord("T1")!.tags,
    );

    // The configured tag separator is honored (_ instead of -).
    kb.setTagSeparator("_");
    await kb.updateThought("T1", { tags: ["machine learning", "two word"] });
    check(
      "tags use underscore separator when configured",
      kb.getRecord("T1")!.tags.join() === "machine_learning,two_word",
      kb.getRecord("T1")!.tags,
    );
    kb.setTagSeparator("-");
    await kb.updateThought("T1", { tags: ["machine learning", "two word"] });
    check(
      "tags fall back to hyphen separator",
      kb.getRecord("T1")!.tags.join() === "machine-learning,two-word",
      kb.getRecord("T1")!.tags,
    );
  }

  // ------------------------------------------------------------- stats
  {
    const vault = new FakeVault();
    vault.set("S1.md", "---\nquestion_type: scientific\n---\n\nbody");
    vault.set("S2.md", "---\nquestion_type: scientific\n---\n\nbody");
    vault.set("P1.md", "---\nquestion_type: practical\n---\n\nbody");
    vault.set("Plain.md", "---\n---\n\nbody");
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    await kb.load();
    const stats = kb.stats();
    check("stats: total", stats.total === 4, stats.total);
    check(
      "stats: by_question_type buckets",
      stats.by_question_type.scientific === 2 &&
        stats.by_question_type.practical === 1 &&
        stats.by_question_type.untyped === 1,
      stats.by_question_type,
    );

    // stats(true) excludes thoughts outside the default folder (the graph's
    // "knowledge base" scope).
    const vault2 = new FakeVault();
    vault2.set("In.md", "---\nquestion_type: causal\n---\n\nbody");
    vault2.set("Elsewhere/Out.md", "---\nquestion_type: scientific\n---\n\nbody");
    const kb3 = new KnowledgeBase(fakeApp(vault2) as never);
    kb3.setDefaultFolder("Elsewhere");
    await kb3.load();
    const scoped = kb3.stats(true);
    check("stats(true) excludes outside-default-folder thoughts", scoped.total === 1, scoped);
    check(
      "stats(true) buckets only default-folder types",
      scoped.by_question_type.scientific === 1,
      scoped.by_question_type,
    );
  }

  // ---------------------------------------------------------- global search
  {
    const vault = new FakeVault();
    vault.set("React.md", "---\n---\n\nReact is a JavaScript library for building UIs.");
    vault.set("Scoala.md", "---\n---\n\nȘcoala din sat are 300 de copii.");
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    await kb.load();
    const hits = kb.search("javascript library", 5);
    check("search: BM25 hit", hits.length === 1 && hits[0].id === "React", hits.map((h) => h.id));
    check("search: irrelevant term → []", kb.search("quantum mechanics", 5).length === 0);
    check("search: stopwords-only → []", kb.search("the a an", 5).length === 0);
    const diacritic = kb.search("scoala", 5);
    check(
      "search: diacritics-insensitive",
      diacritic.length === 1 && diacritic[0].id === "Scoala",
      diacritic.map((h) => h.id),
    );
  }

  // ------------------------------------------------------ similarity check
  {
    check("cosine: identical high", tokenCosine("the quick brown fox", "the quick brown fox") > 0.99);
    check("cosine: shared words above zero", tokenCosine("red apples fall", "apples are red") > 0.2);
    check("cosine: disjoint is zero", tokenCosine("abcdef", "ghijkl") === 0);
    const recs = [
      { id: "Life", title: "Life", content: "the origin of life from non life abiogenesis theories", parents: [] as string[] } as never,
      { id: "Abiogenesis", title: "Abiogenesis", content: "the origin of life on earth abiogenesis chemistry", parents: [] as string[] } as never,
      { id: "Bread", title: "Bread", content: "baking sourdough bread at home", parents: [] as string[] } as never,
    ];
    const pairs = findSimilarPairs(recs, 0.2, 10);
    check(
      "findSimilarPairs ranks related pair first",
      pairs.length > 0 && pairs[0].a === "Life" && pairs[0].b === "Abiogenesis",
      pairs,
    );
    check("findSimilarPairs excludes unrelated", !pairs.some((p) => p.a === "Bread" && p.b === "Life"));
  }

  // ---------------------------------------------------- graph algorithms
  {
    const edges = [
      { id: "A→B", parent_id: "A", child_id: "B", label: "" },
      { id: "B→C", parent_id: "B", child_id: "C", label: "" },
      { id: "C→D", parent_id: "C", child_id: "D", label: "" },
      { id: "E→C", parent_id: "E", child_id: "C", label: "" },
    ];
    check(
      "neighborhood: depth 0 = center only",
      [...neighborhoodIds("B", 0, edges)].sort().join() === "B",
    );
    check(
      "neighborhood: depth 1 = immediate neighbors",
      [...neighborhoodIds("B", 1, edges)].sort().join() === "A,B,C",
      [...neighborhoodIds("B", 1, edges)].sort(),
    );
    check(
      "neighborhood: depth 2 reaches further",
      [...neighborhoodIds("B", 2, edges)].sort().join() === "A,B,C,D,E",
      [...neighborhoodIds("B", 2, edges)].sort(),
    );
    check(
      "neighborhood: walks edges child→parent too",
      neighborhoodIds("A", 1, edges).has("B"),
    );
    check(
      "neighborhood: isolated center is just itself",
      [...neighborhoodIds("Z", 2, edges)].sort().join() === "Z",
    );
    check(
      "shortest path A→D",
      findShortestPath("A", "D", edges)?.join() === "A,B,C,D",
      findShortestPath("A", "D", edges),
    );
    check(
      "shortest path D→A is undirected",
      findShortestPath("D", "A", edges)?.join() === "D,C,B,A",
    );
    check(
      "shortest path same node",
      findShortestPath("B", "B", edges)?.join() === "B",
    );
    check(
      "shortest path disconnected → null",
      findShortestPath("A", "Z", edges) === null,
    );
    check(
      "continuous path chains segments",
      buildContinuousPath(["A", "D"], edges).join() === "A,B,C,D",
      buildContinuousPath(["A", "D"], edges),
    );
    check(
      "continuous path keeps every cited node even when disconnected",
      buildContinuousPath(["A", "Z"], edges).join() === "A,Z",
      buildContinuousPath(["A", "Z"], edges),
    );
    check(
      "continuous path across three cited nodes",
      buildContinuousPath(["A", "D", "C"], edges).join() === "A,B,C,D,C",
      buildContinuousPath(["A", "D", "C"], edges),
    );
    check(
      "continuous path single id",
      buildContinuousPath(["C"], edges).join() === "C",
    );
    check("continuous path empty", buildContinuousPath([], edges).join() === "");
  }

  // ------------------------------------------------------------ citations
  {
    const retrieved = [
      { id: "React", title: "React" },
      { id: "Vue", title: "Vue" },
      { id: "Svelte", title: "Svelte" },
    ];
    check(
      "citations: resolves valid numbers, deduped in first-appearance order",
      parseCitations("React uses a virtual DOM [1]. Vue too [2]. Again [1].", retrieved)
        .map((c) => c.id)
        .join() === "React,Vue",
      parseCitations("React uses a virtual DOM [1]. Vue too [2]. Again [1].", retrieved),
    );
    check(
      "citations: out-of-range numbers dropped",
      parseCitations("Something [9].", retrieved).length === 0,
    );
    check(
      "citations: ignores markdown link text",
      parseCitations("See [1](https://example.com).", retrieved).length === 0,
    );
    check("citations: empty content → []", parseCitations("", retrieved).length === 0);
    check("citations: no retrieved → []", parseCitations("[1]", []).length === 0);
  }

  // -------------------------------------------------- updateThought parents
  {
    // Orphan.md carries a stale parent label for "Root" (plus an unused
    // "Stale" label) but no parents — the label cache the prune cleans up.
    const vault = new FakeVault();
    vault.set("Root.md", "---\n---\n\nRoot body");
    vault.set(
      "Orphan.md",
      "---\nparent_labels:\n  Root: 'Root'\n  Stale: 'Stale'\n---\n\nOrphan body",
    );
    const kb = new KnowledgeBase(fakeApp(vault) as never);
    await kb.load();

    check("orphan has no parents", kb.getRecord("Orphan")!.parents.length === 0);

    await kb.updateThought("Orphan", { parents: ["Root"] });
    const orphan = kb.getRecord("Orphan")!;
    check("updateThought sets parents", orphan.parents.join() === "Root", orphan.parents);
    check(
      "childrenOf(Root) sees Orphan",
      kb.childrenOf("Root").map((r) => r.id).join() === "Orphan",
    );
    check(
      "parentLabels pruned to current parents",
      Object.keys(orphan.parentLabels).sort().join() === "Root",
      orphan.parentLabels,
    );

    let cycleRejected = false;
    try {
      await kb.updateThought("Root", { parents: ["Orphan"] });
    } catch {
      cycleRejected = true;
    }
    check("updateThought rejects cycle", cycleRejected);
    check(
      "Root unchanged after rejected cycle",
      kb.getRecord("Root")!.parents.length === 0,
    );

    await kb.updateThought("Orphan", { parents: [] });
    check(
      "updateThought clears parents back to root",
      kb.getRecord("Orphan")!.parents.length === 0 && kb.childrenOf("Root").length === 0,
    );
  }

  // -------------------------------------------------------- sanitizeTitle
  {
    check('sanitize strips ":"', sanitizeTitle("What: A Thought") === "What A Thought");
    check(
      'sanitize strips illegal set',
      sanitizeTitle('Q?"Why?": <the> |plan| \\x* y/ z') === "Q Why the plan x y z",
    );
    check("sanitize trims", sanitizeTitle("  spaced  out  ") === "spaced out");
    check("sanitize strips trailing .md", sanitizeTitle("My Note.md") === "My Note");
    check("sanitize strips trailing dot/space", sanitizeTitle("Note. ") === "Note");
    check("sanitize falls back on empty", sanitizeTitle("***") === "Untitled");
  }

  console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
