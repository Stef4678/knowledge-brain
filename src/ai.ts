import { KnowledgeBase, kbLine, displayTitle, sanitizeTitle } from "./knowledgeBase";
import { buildBm25Index, type Bm25Index } from "./bm25";
import { chatJson, type ChatMessage } from "./deepseek";
import { QUESTION_TYPES, THOUGHT_STATUSES, type QuestionType } from "./types";
import type { PluginSettings, Thought } from "./types";

/**
 * AI-assisted operations, ported from the app's endpoints (app.py). Every
 * prompt is the same as the Python version (minus the bilingual language
 * instruction — this port is English-only). All calls go through chatJson.
 */

export interface Suggestion {
  parent_id: string | null;
  parent_title: string | null;
  reason: string;
}

export interface TitleSuggestion {
  title: string;
  reason: string;
}

export interface FollowupQuestion {
  q: string;
  covered_id: string | null;
  covered_title: string;
}

export type FollowupGroup = QuestionType;

export const FOLLOWUP_GROUPS: FollowupGroup[] = [...QUESTION_TYPES];

/** Coerce an unknown JSON value to a string, defaulting to "" for non-strings. */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export class AiService {
  private kb: KnowledgeBase;
  private index: Bm25Index | null = null;
  private builtFor = -1;

  constructor(kb: KnowledgeBase) {
    this.kb = kb;
  }

  // ------------------------------------------------------------- retrieval

  /** Top thoughts relevant to `query` via local BM25 (port of db.fts_search). */
  retrieve(query: string, limit: number): Thought[] {
    if (this.kb.revision !== this.builtFor || !this.index) {
      this.index = buildBm25Index(this.kb.listRecords());
      this.builtFor = this.kb.revision;
    }
    return this.index
      .search(query, limit)
      .map((r) => this.kb.getThought(r.id))
      .filter((t): t is Thought => !!t);
  }

  // ------------------------------------------------------------ helpers

  private opts(settings: PluginSettings, temperature: number, maxTokens?: number) {
    return {
      apiKey: settings.apiKey,
      model: settings.model,
      temperature,
      thinking: settings.thinking,
      maxTokens,
      provider: settings.provider,
    };
  }

  private async json(
    messages: ChatMessage[],
    settings: PluginSettings,
    temperature: number,
    maxTokens?: number,
  ): Promise<Record<string, unknown>> {
    return chatJson(messages, this.opts(settings, temperature, maxTokens));
  }

  // ------------------------------------------------------------- ops

  /**
   * Choose up to 3 existing thoughts a new thought could be linked under as
   * parents. Port of POST /api/chat/suggest-link.
   */
  async suggestParents(
    title: string,
    content: string,
    settings: PluginSettings,
    opts: { prompt?: string; childId?: string } = {},
  ): Promise<Suggestion[]> {
    let thoughts = this.retrieve(`${title} ${content}`, 25);
    if (opts.childId) {
      thoughts = thoughts.filter((t) => t.id !== opts.childId);
    }
    const kb_lines = thoughts.map((t) => kbLine(t));

    const user_parts = [
      `The new thought is:\nTitle: ${title}\nContent:\n${content || "(none)"}`,
    ];
    if (opts.prompt) {
      user_parts.push(`It came from this chat prompt: ${opts.prompt}`);
    }
    user_parts.push(
      "Choose up to 3 existing thoughts this new thought could be linked under " +
        "as parents, ranked best first. Use null for a new root thought if nothing " +
        "fits or the best fit is not listed.",
    );
    user_parts.push(
      "Most relevant existing thoughts (subset):\n" +
        (kb_lines.length ? kb_lines.join("\n") : "(none)"),
    );

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are organizing a personal knowledge base where thoughts form a " +
          "tree: each thought has a parent (or is a root). Given a new thought " +
          "and a list of the most relevant existing thoughts, return up to 3 " +
          "existing thoughts it could be linked under as parents, ranked best " +
          "first. Return JSON exactly of the form: " +
          '{"suggestions": [{"parent_id": <an existing thought id or null>, "reason": "..."}]} ' +
          "Each reason is one or two sentences. If no existing thought is a good " +
          "fit, return a single suggestion with parent_id null to make it a new " +
          "root thought.",
      },
      { role: "user", content: user_parts.join("\n\n") },
    ];

    const result = await this.json(messages, settings, 0.4);
    const raw: unknown[] = Array.isArray(result.suggestions)
      ? result.suggestions
      : [];
    const existingIds = new Set(thoughts.map((t) => t.id));
    const titles = new Map(thoughts.map((t) => [t.id, t.title]));

    const items: Array<{ parent_id: string; reason: string }> = [];
    for (const it of raw) {
      if (!it || typeof it !== "object") {
        continue;
      }
      const pid = (it as Record<string, unknown>).parent_id;
      const reason = asString((it as Record<string, unknown>).reason).trim();
      if (typeof pid === "string" && existingIds.has(pid)) {
        items.push({ parent_id: pid, reason });
      }
    }
    const seen = new Set<string>();
    const deduped = items.filter((it) => {
      if (seen.has(it.parent_id)) {
        return false;
      }
      seen.add(it.parent_id);
      return true;
    });

    const first = raw[0];
    if (first && typeof first === "object" && (first as Record<string, unknown>).parent_id === null) {
      return [
        {
          parent_id: null,
          parent_title: null,
          reason: asString((first as Record<string, unknown>).reason).trim(),
        },
      ];
    }
    return deduped.slice(0, 3).map((it) => ({
      parent_id: it.parent_id,
      parent_title: titles.get(it.parent_id) ?? null,
      reason: it.reason,
    }));
  }

  /** Ask the model for 3-5 cleaner titles. Port of _suggest_titles. */
  async suggestTitles(title: string, content: string, settings: PluginSettings): Promise<TitleSuggestion[]> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You help title a thought in a personal knowledge base. " +
          "Suggest 3 to 5 SHORT, specific titles that capture the actual " +
          "subject of the CONTENT. Each title must be a noun phrase of " +
          "3 to 8 words, under 60 characters — never a full sentence. " +
          "Extract the subject from the CONTENT, not from the current " +
          "title, and never repeat the current title verbatim. Do not " +
          "start with conversational filler such as 'Great question', " +
          "'Sure', 'Absolutely', or 'How to'. " +
          "Return JSON exactly of the form: " +
          '{"suggestions": [{"title": "...", "reason": "..."}]} The ' +
          "reason is a short one-line explanation of the change.",
      },
      { role: "user", content: `Current title: ${title || "(none)"}\n\nContent:\n${content}` },
    ];
    const result = await this.json(messages, settings, 0.4);
    const raw: unknown[] = Array.isArray(result.suggestions)
      ? result.suggestions
      : [];
    const clean: TitleSuggestion[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const t = sanitizeTitle(
        asString((item as Record<string, unknown>).title).trim(),
      );
      const reason = asString((item as Record<string, unknown>).reason).trim();
      if (t && !clean.some((c) => c.title === t)) {
        clean.push({ title: t, reason });
      }
    }
    return clean;
  }

  /** Follow-up question suggestions. Port of POST /api/thoughts/{id}/followups. */
  async followups(
    thought: Thought,
    settings: PluginSettings,
    avoid: string[] = [],
  ): Promise<Record<FollowupGroup, FollowupQuestion[]>> {
    const count = Math.max(1, Math.min(5, settings.followupCount || 2));
    const groups = FOLLOWUP_GROUPS.filter((g) => settings.followupGroups?.[g] ?? true);
    if (groups.length === 0) {
      const none = {} as Record<FollowupGroup, FollowupQuestion[]>;
      for (const key of FOLLOWUP_GROUPS) {
        none[key] = [];
      }
      return none;
    }
    const groupNames = groups.join(", ");
    const total = count * groups.length;
    // The JSON answer grows with the number of questions. Without a budget the
    // JSON-mode default (1024 tokens) truncates large requests (e.g. 5 per
    // group) mid-JSON, which then fails to parse. Budget ~80 tokens per
    // question entry, clamped to a safe range.
    const maxTokens = Math.min(4096, Math.max(2048, total * 80 + 256));

    const existing = this.retrieve(thought.content, 12).filter((t) => t.id !== thought.id);
    const existingIds = new Set(existing.map((t) => t.id));
    const existingTitles = new Map(existing.map((t) => [t.id, t.title]));
    const existing_lines = existing.length ? existing.map((t) => kbLine(t)).join("\n") : "(none)";

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "Given a thought in a personal knowledge base, suggest follow-up " +
          "questions the user could ask in a chat about this thought. Return " +
          `EXACTLY ${count} short question${count === 1 ? "" : "s"} for each of ` +
          `these group${groups.length === 1 ? "" : "s"}: ${groupNames} ` +
          `(${total} question${total === 1 ? "" : "s"} total) — never fewer, never ` +
          "empty, even if you must work harder to find a different angle. JSON " +
          'form: {"group_name": [{"q": "...", "covered_id": <id or null>}, ...], ...} ' +
          "with a key for each group listed above. " +
          "Group styles: scientific explores the topic deeper and conceptually; " +
          "practical is simple, everyday and actionable (concrete real-life " +
          "application); comparative compares this thought with related or " +
          "opposite concepts; historical asks how this idea evolved and what " +
          "influenced it over time; causal asks what causes this and what its " +
          "consequences are; critical raises the strongest objections, " +
          "counterarguments, or weaknesses. For EACH question, look at the " +
          "EXISTING thoughts listed. If an existing thought already answers " +
          "that question — saving the answer would be redundant — set " +
          "covered_id to that existing thought's id; otherwise null. Only mark " +
          "genuinely same-topic questions; do NOT mark related, adjacent, or " +
          "broader/narrower topics. If the avoid list is given, you MUST NOT " +
          "repeat those questions in any form; replace each with a different " +
          "one and keep every group full.",
      },
      {
        role: "user",
        content:
          (avoid.length
            ? `Do NOT re-suggest these questions (the user has seen them):\n${avoid.join(", ")}\n\n`
            : "") +
          `Thought the user is reading:\nTitle: ${displayTitle(thought)}\n\nContent:\n${thought.content}\n\n` +
          `Existing thoughts in this knowledge base (subset, by id):\n${existing_lines}`,
      },
    ];
    const result = await this.json(messages, settings, 0.5, maxTokens);

    const out = {} as Record<FollowupGroup, FollowupQuestion[]>;
    for (const key of FOLLOWUP_GROUPS) {
      out[key] = [];
    }
    for (const key of groups) {
      const raw: unknown[] = Array.isArray(result[key]) ? result[key] : [];
      const items: FollowupQuestion[] = [];
      const seenQ = new Set<string>();
      for (const item of raw) {
        let q = "";
        let cid: unknown = null;
        if (item && typeof item === "object") {
          q = asString((item as Record<string, unknown>).q).trim();
          cid = (item as Record<string, unknown>).covered_id;
        } else {
          q = asString(item).trim();
        }
        if (!q || seenQ.has(q.toLowerCase())) {
          continue;
        }
        if (avoid.some((a) => a.toLowerCase() === q.toLowerCase())) {
          continue;
        }
        seenQ.add(q.toLowerCase());
        if (typeof cid === "string" && existingIds.has(cid)) {
          items.push({ q, covered_id: cid, covered_title: existingTitles.get(cid) ?? "" });
        } else {
          items.push({ q, covered_id: null, covered_title: "" });
        }
        if (items.length >= count) {
          break;
        }
      }
      out[key] = items;
    }
    return out;
  }

  /**
   * Propose 3-8 tags for a thought, biased toward tags already used in the
   * knowledge base so the taxonomy stays stable.
   */
  async suggestTags(
    thought: Thought,
    settings: PluginSettings,
    maxTags = 8,
  ): Promise<string[]> {
    const existing = this.kb.allTags();
    const existingLine = existing.length ? existing.join(", ") : "(none)";
    const sep = settings.tagSeparator ?? "-";
    const sepWord = sep === "_" ? "underscores" : "hyphens";
    const example = sep === "_" ? "machine_learning" : "machine-learning";
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You tag a thought in a personal knowledge base. Return 3 to 8 " +
          "short, lowercase tags (no # prefix) that describe the CONTENT, not " +
          "the title alone. Prefer reusing tags already used in the knowledge " +
          "base when they fit, so the taxonomy stays stable. Multi-word tags " +
          `must be joined with ${sepWord}, e.g. "${example}", never a ` +
          "space. Use only plain tag names — no markdown, no strikethrough. " +
          "Return JSON exactly of the form: {\"tags\": [\"...\", \"...\"]}",
      },
      {
        role: "user",
        content:
          `Title: ${displayTitle(thought)}\n\nContent:\n${thought.content}` +
          `\n\nExisting tags in the knowledge base:\n${existingLine}`,
      },
    ];
    const result = await this.json(messages, settings, 0.4);
    const raw: unknown[] = Array.isArray(result.tags) ? result.tags : [];
    const clean: string[] = [];
    for (const item of raw) {
      const tag = asString(item)
        .trim()
        .toLowerCase()
        .replace(/^#+/, "")
        // Collapse whitespace (and hyphens/underscores used as word separators)
        // to the configured separator. Obsidian only treats single-word tags as
        // valid — a tag with a space renders struck-out.
        .replace(/[\s-_]+/g, sep)
        .replace(new RegExp(`^[${sep}]+|[${sep}]+$`, "g"), "")
        .slice(0, 40);
      if (tag && !clean.includes(tag)) {
        clean.push(tag);
      }
      if (clean.length >= maxTags) {
        break;
      }
    }
    return clean;
  }

  /** Classify a thought into one of the three workflow statuses. */
  async suggestStatus(
    thought: Thought,
    settings: PluginSettings,
  ): Promise<{ status: string; reason: string }> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You classify the workflow stage of a thought in a personal " +
          "knowledge base. Pick exactly one of: idea (a raw, not-yet-developed " +
          "thought), in progress (actively being developed), or done (complete " +
          "and stable). Base the choice on the thought's CONTENT. Return JSON " +
          'exactly of the form: {"status": "idea" | "in progress" | "done", ' +
          '"reason": "..."} The reason is one sentence explaining the choice.',
      },
      {
        role: "user",
        content: `Title: ${displayTitle(thought)}\n\nContent:\n${thought.content}`,
      },
    ];
    const result = await this.json(messages, settings, 0.3);
    const status = asString(result.status).trim().toLowerCase();
    const valid = new Set<string>(THOUGHT_STATUSES);
    return {
      status: valid.has(status) ? status : "",
      reason: asString(result.reason).trim(),
    };
  }
}
