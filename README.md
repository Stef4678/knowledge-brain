# Knowledge Brain

An [Obsidian](https://obsidian.md) plugin that turns your markdown notes into a connected **knowledge graph** — a directed acyclic graph (DAG) of *thoughts* — with a built-in **streaming AI chat** (DeepSeek / OpenAI / Gemini / Claude) that can suggest tags, statuses, links, follow-up questions, and even turn chat answers into new notes.

> Any markdown note in your vault is already a thought. The plugin reads standard YAML frontmatter, so your knowledge base stays plain, portable markdown.

**Author:** [Kerekes Stefan](https://github.com/Stef4678) · **Version:** 0.4.0 · Desktop only

---

## Features

<br />
<img width="700" alt="Knowledge_brain" src="https://github.com/user-attachments/assets/97e9eaf4-0eb0-4aae-9bf8-b6ebe8a17652" />
<br />
<img width="700" alt="Screenshot 2026-08-10 181644" src="https://github.com/user-attachments/assets/b07c076f-6862-4f6c-b583-b4cc2947d846" />
<br />
<img width="700" alt="Screenshot 2026-08-10 180943" src="https://github.com/user-attachments/assets/0a3dddad-9e7a-437e-ab11-dca39c17e8ef" />
<br />
<img width="700" alt="Screenshot 2026-08-10 181001" src="https://github.com/user-attachments/assets/0f683764-186e-4bd8-8587-ae7570514f04" />
<br />
<img width="700" alt="Screenshot 2026-08-10 181026" src="https://github.com/user-attachments/assets/e1ce110a-e5f4-4873-8cee-15bd5964a159" />
<br />
<img width="700" alt="Screenshot 2026-08-10 181038" src="https://github.com/user-attachments/assets/ca1f4193-3c15-42c2-979b-42a89c8580d3" />
<br />
<img width="700" alt="Screenshot 2026-08-10 181049" src="https://github.com/user-attachments/assets/60262e31-c4a4-46ff-b979-ff41baffba3e" />
<br />
<img width="700" alt="Screenshot 2026-08-11 194810" src="https://github.com/user-attachments/assets/69fa11a8-d2c8-4af1-9c12-5abe9c5d9ba9" />
<br />
<img width="700" alt="Screenshot 2026-08-11 194821" src="https://github.com/user-attachments/assets/3695feda-e95c-4967-afe8-a6c09899b1b3" />
<br />
<img width="700" alt="Screenshot 2026-08-10 181137" src="https://github.com/user-attachments/assets/9f047390-0e56-4376-8cde-54e141380b1b" />
<br />
<img width="700" alt="Screenshot 2026-08-10 181157" src="https://github.com/user-attachments/assets/8d4dbbb4-dd4b-49ca-8ba3-ab12b1453a69" />

### 🧠 Thoughts as plain markdown
- Every markdown note is a *thought*, indexed live from your vault (create, edit, rename, delete — the index follows automatically).
- Thoughts link to each other through a `parents` list in frontmatter, forming a **directed acyclic graph** — the plugin validates links and refuses cycles, self-links, and duplicates.
- Optional frontmatter metadata: `tags`, `status` (idea / in progress / done), `questiontype` (scientific, practical, comparative, historical, causal, critical), `source`, edge `parentlabels`.
- Renaming a note automatically rewrites every parent reference that points at it.

### 🕸️ Interactive graph view
- Cytoscape.js-powered graph with **Breadth-first**, **Concentric**, or **CoSE** layouts, node size mapped to link degree, and arrows on edges.
- Color-coded by status (idea / in progress / done) with an auto-generated legend.
- Filter by **status** or **tag**, adjust **node spacing** with a slider (persisted in settings).
- **Neighborhood view**: show only the notes within 1–3 hops of a thought, centered on the active note (or a thought you pick).
- **Path highlighting**: pick two thoughts and the shortest connecting path is highlighted, with the rest dimmed.
- Hover a node for a preview tooltip (title, status, type, tags, content); click to open the note.
- Right-click a node for AI **tag suggestions**, AI **status suggestions**, or delete.
- **Statistics** modal: totals, links, breakdown by thought type and follow-up groups.
- **Check similarity**: finds near-duplicate thoughts locally (token-cosine over title + content — no API calls).

### 💬 Streaming AI chat
- Bring your own key for **DeepSeek, OpenAI (ChatGPT), Google Gemini, or Anthropic Claude** — pick a model from the list or type any custom model id.
- **Streaming responses** with visible reasoning/thinking output for models that support it (DeepSeek thinking, OpenAI reasoning effort, Gemini thinking, Claude extended thinking).
- **Context thought**: pin the active note (or a graph node) as chat context.
- After each answer, get **follow-up suggestions** and **save the answer as a new thought** — the AI suggests the best existing parent(s) to file it under, or lets you create a new root.
- Everything is copyable: individual messages, suggestions, the whole conversation.

### ❓ Automatic follow-up questions
- Opening a note in the sidebar generates **follow-up questions** grouped by type (scientific, practical, comparative, historical, causal, critical) to deepen your thinking.
- Choose which groups to generate and how many questions per group; pause/resume automatic generation; regenerate on demand.
- Questions already answered elsewhere in the graph are marked as *answered in …*.
- Click a follow-up to load it straight into the chat with the right context set.

### 🗂️ Sidebar panes
- **Backlinks** — thoughts that link to the active note (with edge labels).
- **Siblings** — thoughts that share a parent with the active note.
- **Follow-ups** — generated questions for the active note.
- Optionally **combine all three into a single sidebar tab** (setting), or keep them as separate panes.

### 🔍 Local search & retrieval
- **BM25 full-text search** over all thoughts (memoized index, rebuilt on change) with English **and Romanian** stopword handling.
- Used both for the search modal and to retrieve relevant thoughts as context for AI operations — cheap and private, no embeddings API needed.

### 🤖 AI-assisted organization
- **Suggest tags** and **suggest status** for a thought (toggleable in settings).
- **Suggest parents** when saving a new thought — ranked best-first with reasons.
- **Suggest titles** — 3–5 short, specific noun-phrase titles extracted from the content.

## Commands

| Command | What it does |
|---|---|
| Open knowledge brain graph | Opens the graph view |
| Open knowledge brain chat | Opens the chat view |
| Open knowledge brain follow-up questions / backlinks / siblings | Opens the sidebar panes |
| Set chat context to current note | Pins the active note as chat context |
| Create new thought | Modal to create a titled thought with parents, tags, status |
| Search knowledge brain thoughts | BM25 search modal |
| Knowledge Brain: set status / tags of active thought | Edit metadata of the active note |
| Knowledge Brain: generate tags / status for active thought (AI) | AI suggestions for the active note |
| Knowledge Brain: reload index | Full vault rescan |

There's also a **ribbon icon** and **status bar items** (`KB Graph`, `KB Chat`) for quick access.

## Frontmatter format

A thought is just a markdown file. The plugin manages these frontmatter keys (anything else is preserved untouched):

```markdown
---
parents:
  - Some Parent Thought
parent_labels:
  Some Parent Thought: contradicts
tags:
  - knowledge-management
  - ai
status: idea
question_type: causal
source: https://example.com/article
created_at: 2026-08-01T12:00:00.000Z
updated_at: 2026-08-09T18:30:00.000Z
---

The body of the note is the thought's content — free-form markdown.
```

## Installation

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Stef4678/knowledge-brain/releases).
2. Create a folder `<your-vault>/.obsidian/plugins/knowledge-brain/` and copy the three files into it.
3. Restart Obsidian, then enable **Knowledge Brain** in *Settings → Community plugins*.

### BRAT (beta testing)
1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Add this repository: `Stef4678/knowledge-brain`.

## Setup

1. Open *Settings → Knowledge Brain*.
2. Pick a **provider** (DeepSeek, OpenAI, Gemini, or Claude) and paste your **API key**.
3. Choose a **model** (sensible defaults per provider, custom ids allowed) and tune **temperature** / **thinking mode**.
4. Click **Test connection** to verify the key.
5. (Optional) Set a **default folder** for new thoughts — the graph, similarity check, and sidebar panes focus on this folder.

> The graph, search, similarity, and all note management work **without an API key**. Only chat and AI-assisted suggestions need one.

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| Provider | DeepSeek | DeepSeek / OpenAI / Gemini / Claude |
| API key | — | Required for chat & AI ops |
| Model | provider default | Dropdown of known models or custom id |
| Temperature | 1.0 | 0–2 (0–1 for Claude) |
| Thinking mode | on | Only for models that support reasoning |
| Default folder | vault root | Where new thoughts are created |
| Graph node spacing | 3.0 | 0.6 (dense) – 6 (spread out) |
| Tag word separator | `-` | `machine-learning` vs `machine_learning` |
| AI tag / status suggestions | on | Hides the corresponding menu items when off |
| Combined sidebar pane | off | One tab vs. three separate tabs |
| Follow-up groups | all on | Per-type toggles + 1–5 questions per group |

## Development

```bash
npm install
npm run dev      # esbuild watch mode
npm run build    # production bundle
```

Written in TypeScript, bundled with esbuild, graph rendering via [Cytoscape.js](https://js.cytoscape.org/). The plugin talks to AI providers directly (OpenAI-compatible chat completions, Gemini `generateContent`, Claude Messages API) with SSE streaming and non-streaming fallbacks.

## Roadmap ideas

Potential future improvements include:

- **OpenAI-compatible endpoint support** — custom base URL + key, unlocking local models (LM Studio, Ollama) and alternative providers (Mistral, Groq, OpenRouter) with one code path
- **Canvas / Excalidraw export** — render the thought graph as an Obsidian Canvas file for presentations and sharing
- **Chat with multiple thoughts as context** — pin several notes, not just one; auto-retrieve top-k relevant thoughts via BM25 as chat context (RAG-lite)
- **Graph import/export** — JSON dump/restore of nodes, edges, and metadata for backups and migration (the logic already exists internally)

## Privacy

- Notes never leave your vault except as explicit context in requests to **your chosen AI provider, using your own API key**.
- Search, similarity, statistics, and the graph are computed entirely locally.

## License

[MIT](LICENSE) © 2026 Kerekes Stefan
