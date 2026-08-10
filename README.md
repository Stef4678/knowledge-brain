# Knowledge Brain

An Obsidian desktop plugin that turns Markdown notes into a connected knowledge graph. Knowledge Brain organizes notes as **thoughts** in a directed acyclic graph (DAG), adds local full-text search, and provides AI-assisted chat and knowledge-management workflows.

> **Status:** Early release — version 0.2.0

## Features

https://github.com/user-attachments/assets/9b032531-b89f-4e8f-bcb3-f0cb6ed3d4fe

<img width="1916" height="1025" alt="Screenshot 2026-08-10 181644" src="https://github.com/user-attachments/assets/b07c076f-6862-4f6c-b583-b4cc2947d846" />
<img width="1918" height="1023" alt="Screenshot 2026-08-10 180943" src="https://github.com/user-attachments/assets/0a3dddad-9e7a-437e-ab11-dca39c17e8ef" />
<img width="1912" height="993" alt="Screenshot 2026-08-10 181001" src="https://github.com/user-attachments/assets/0f683764-186e-4bd8-8587-ae7570514f04" />
<img width="1917" height="1024" alt="Screenshot 2026-08-10 181026" src="https://github.com/user-attachments/assets/e1ce110a-e5f4-4873-8cee-15bd5964a159" />
<img width="1916" height="1022" alt="Screenshot 2026-08-10 181038" src="https://github.com/user-attachments/assets/ca1f4193-3c15-42c2-979b-42a89c8580d3" />
<img width="1917" height="1025" alt="Screenshot 2026-08-10 181049" src="https://github.com/user-attachments/assets/60262e31-c4a4-46ff-b979-ff41baffba3e" />
<img width="888" height="1022" alt="Screenshot 2026-08-10 181137" src="https://github.com/user-attachments/assets/9f047390-0e56-4376-8cde-54e141380b1b" />
<img width="887" height="1021" alt="Screenshot 2026-08-10 181157" src="https://github.com/user-attachments/assets/8d4dbbb4-dd4b-49ca-8ba3-ab12b1453a69" />


- Convert Markdown notes in an Obsidian vault into connected thoughts.
- Link thoughts through parent-child relationships while preventing cycles.
- Visualize the knowledge base as an interactive graph.
- Chat with your notes using streaming AI responses.
- Retrieve relevant notes with local BM25 search — no embeddings or vector database required.
- Suggest suitable parent thoughts for new notes.
- Generate cleaner, more specific note titles.
- Suggest tags while reusing existing knowledge-base tags where appropriate.
- Suggest workflow statuses: `idea`, `in progress`, or `done`.
- Generate follow-up questions across multiple groups:
  - Scientific
  - Practical
  - Comparative
  - Historical
  - Causal
  - Critical
- Browse backlinks, siblings, descendants, and related thoughts.
- Search thoughts from a global search modal.
- Store knowledge-graph metadata in Markdown frontmatter, keeping the data portable.

## Supported AI providers

Knowledge Brain can connect to the following providers through their compatible APIs:

- DeepSeek
- OpenAI
- Google Gemini
- Anthropic Claude

You provide the API key and model in the plugin settings. The plugin supports streaming chat responses, provider-specific request formats, optional reasoning/thinking modes, and structured JSON responses for AI-assisted operations.

## Requirements

- Obsidian 1.4.0 or newer.
- Obsidian Desktop. Mobile platforms are not supported.
- An API key from a supported AI provider for chat and AI-assisted features.

Local search, graph navigation, note management, backlinks, siblings, and other non-AI features do not require an API key.

## Installation

### Manual installation

1. Download or build the plugin files.
2. Create the following folder inside your vault:

   ```text
   <Vault>/.obsidian/plugins/knowledge-brain-obsidian/
   ```

3. Copy the plugin files into that folder:

   ```text
   main.js
   manifest.json
   styles.css
   ```

4. Restart Obsidian or reload installed plugins.
5. Open **Settings → Community plugins**.
6. Enable **Knowledge Brain**.

The manifest identifies the plugin as `knowledge-brain-obsidian` and currently reports version `0.1.1`.

### Development installation

The supplied JavaScript file is an esbuild-generated bundle. For development, work from the plugin's source repository rather than editing `main.js` directly. After building the project, copy the generated plugin files into the vault's plugin directory and reload the plugin in Obsidian.

## Configuration

Open **Settings → Knowledge Brain** to configure:

- AI provider.
- API key.
- Model identifier.
- Temperature.
- Thinking/reasoning mode where supported.
- Default folder for newly created thoughts.
- Graph node spacing.
- Multi-word tag separator: hyphen or underscore.
- AI tag suggestions.
- AI status suggestions.
- Number of follow-up questions per enabled group.
- Enabled follow-up-question groups.
- Separate or combined sidebar panes for follow-ups, siblings, and backlinks.

The default folder can be left empty to create new thoughts at the vault root. A folder such as `Thoughts` can be configured to keep generated notes together.

## How thoughts work

A thought is a Markdown note with optional Knowledge Brain frontmatter. The note title is used as its thought identifier, and relationships are stored using parent identifiers.

Example:

```markdown
---
parents:
  - Retrieval-Augmented Generation
tags:
  - knowledge-management
  - ai
status: in progress
questiontype: practical
source: Personal research
createdat: 2026-08-10T12:00:00.000Z
updatedat: 2026-08-10T12:00:00.000Z
---

A thought's content goes here.
```

Supported metadata includes:

- `parents`
- `parentlabels`
- `source`
- `questiontype`
- `tags`
- `status`
- `createdat`
- `updatedat`

Additional frontmatter is preserved when Knowledge Brain updates a note.

## Knowledge graph behavior

Knowledge Brain treats thoughts as nodes and parent relationships as directed edges. It prevents self-links, duplicate parents, missing parents, and links that would create a cycle, keeping the graph acyclic.

The graph can expose:

- Parents of the active thought.
- Children and descendants.
- Siblings sharing a parent.
- Backlinks and related notes.
- Labels attached to parent-child relationships.

By default, the graph can include active Markdown notes across the vault. A configured default folder can also be used as a focused knowledge-base scope.

## Search and retrieval

Search is performed locally using a BM25-style full-text index over thought titles and content. The index is memoized and rebuilt when the knowledge base changes, so ordinary retrieval does not require embeddings, a remote search service, or a vector database.

This makes Knowledge Brain suitable for private vaults and local-first workflows where predictable indexing and low operating cost are important.

## AI-assisted workflows

AI features use the currently configured provider and model to assist with knowledge organization:

- **Parent suggestions:** proposes up to three existing thoughts that could serve as parents for a new thought.
- **Title suggestions:** proposes short, specific titles based on note content.
- **Tag suggestions:** proposes lowercase tags and favors tags already used in the vault.
- **Status suggestions:** classifies a thought as an idea, in-progress work, or completed work.
- **Follow-up questions:** generates questions designed to deepen, apply, compare, contextualize, explain, or critically examine a thought.
- **Chat:** retrieves relevant thoughts locally and sends the selected context to the configured AI provider.

AI-generated suggestions should be reviewed before being applied to your notes.

## Privacy and data handling

- Knowledge Brain indexes Markdown files locally inside your Obsidian vault.
- Local BM25 search does not require embeddings or a cloud indexing service.
- AI requests are sent to the provider configured in the plugin settings when you use AI features.
- API keys should be treated as sensitive credentials and should not be committed to a repository or shared publicly.

Review each provider's terms and privacy policy before sending vault content to its API.

## Limitations

- Desktop-only at the moment.
- AI features require a compatible provider API key.
- The current graph model is intentionally acyclic; links that would create cycles are rejected.
- Thought identifiers are based on note titles, so duplicate titles are not allowed within the indexed knowledge base.
- `main.js` is a generated bundle and is not the preferred place for source-level changes.

## Roadmap ideas

Potential future improvements include:

- **OpenAI-compatible endpoint support** — custom base URL + key, unlocking local models (LM Studio, Ollama) and alternative providers (Mistral, Groq, OpenRouter) with one code path
- **Canvas / Excalidraw export** — render the thought graph as an Obsidian Canvas file for presentations and sharing
- **Graph view improvements** — additional layouts (concentric, cose), depth-limited neighborhood view around the active note, path highlighting between two thoughts
- **Chat with multiple thoughts as context** — pin several notes, not just one; auto-retrieve top-k relevant thoughts via BM25 as chat context (RAG-lite)
- **Graph import/export** — JSON dump/restore of nodes, edges, and metadata for backups and migration (the logic already exists internally)

## Author

Created by [Kerekes Stefan](https://github.com/Stef4678). If you find Knowledge Brain useful, consider [buying me a coffee](https://www.buymeacoffee.com/Stef4678). 

## License

[MIT](LICENSE) © 2026 Kerekes Stefan
