import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import {
  AiService,
  type Suggestion,
  type TitleSuggestion,
} from "./ai";
import { addCopyableSuggestion, copyToClipboard } from "./copyRow";
import { streamChat, type ChatMessage } from "./deepseek";
import { KnowledgeBase, sanitizeTitle } from "./knowledgeBase";
import type { PluginSettings, Thought } from "./types";

export const CHAT_VIEW_TYPE = "knowledge-brain-chat";

/** Lines that open a chat answer conversationally and are useless as titles. */
const CONVERSATIONAL_OPENERS = [
  /^great question/i,
  /^good question/i,
  /^excellent question/i,
  /^interesting question/i,
  /^that['’]s a (great|good|excellent|perfect|fun|fascinating) question/i,
  /^(sure|absolutely|of course|definitely|indeed)[,!]?/i,
  /^no problem/i,
  /^happy to/i,
  /^thanks/i,
  /^thank you/i,
  /^(here['’]s|here is|here are)/i,
  /^(let me|let['’]s|i['’]d (love|be happy|like) to)/i,
  /^(yes|no|yep|nope)[,.!]?/i,
  /^(the short|in short|in brief)/i,
];

function isConversationalFiller(line: string): boolean {
  return CONVERSATIONAL_OPENERS.some((re) => re.test(line));
}

interface Exchange {
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  status: "streaming" | "done" | "error";
  error?: string;
  /** Question type carried from a clicked follow-up, applied when saving. */
  type?: string;
}

export class ChatView extends ItemView {
  private kb: KnowledgeBase;
  private ai: AiService;
  private getSettings: () => PluginSettings;
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private contextEl: HTMLElement;
  private exchanges: Exchange[] = [];
  private streaming = false;
  private contextThought: Thought | null = null;
  private suggestionsEl: HTMLElement;
  /** Live refs for the in-progress assistant message, updated without a full re-render. */
  private liveWrap: HTMLElement | null = null;
  private liveBubble: HTMLElement | null = null;
  private liveReasoning: HTMLElement | null = null;
  /** Question type of the follow-up that loaded the current input. */
  private pendingType = "";
  /** Titles currently being created from a suggestion; guards duplicate clicks. */
  private savingTitles = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    kb: KnowledgeBase,
    ai: AiService,
    getSettings: () => PluginSettings,
  ) {
    super(leaf);
    this.kb = kb;
    this.ai = ai;
    this.getSettings = getSettings;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Knowledge Brain Chat";
  }

  getIcon(): string {
    return "message-square";
  }

  setContextThought(thought: Thought | null): void {
    this.contextThought = thought;
    this.updateContextBar();
    if (thought) {
      new Notice(`Chat context set to "${thought.title}"`);
    }
  }

  getContextThought(): Thought | null {
    return this.contextThought;
  }

  /** Load a follow-up question into the input so the user can ask it. */
  loadQuestion(question: string, type = ""): void {
    this.inputEl.value = question;
    this.inputEl.focus();
    this.pendingType = type;
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("kb-chat-view");

    const toolbar = this.contentEl.createDiv({ cls: "kb-chat-toolbar" });
    const newChat = toolbar.createEl("button", { text: "New chat", cls: "mod-muted" });
    newChat.onclick = () => {
      this.exchanges = [];
      this.suggestionsEl?.empty();
      this.pendingType = "";
      this.render();
    };
    const copyChat = toolbar.createEl("button", { text: "Copy chat", cls: "mod-muted" });
    copyChat.onclick = () => void this.copyConversation();

    this.contextEl = this.contentEl.createDiv({ cls: "kb-chat-context" });

    this.messagesEl = this.contentEl.createDiv({ cls: "kb-chat-messages" });
    this.suggestionsEl = this.contentEl.createDiv({ cls: "kb-suggestions" });

    const inputRow = this.contentEl.createDiv({ cls: "kb-chat-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      attr: { placeholder: "Ask anything... (Enter to send, Shift+Enter for newline)" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    const sendBtn = inputRow.createEl("button", { text: "Send" });
    sendBtn.onclick = () => void this.send();

    this.updateContextBar();
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private updateContextBar(): void {
    if (!this.contextEl) {
      return;
    }
    this.contextEl.empty();
    if (this.contextThought) {
      this.contextEl.createSpan({
        text: `Context: ${this.contextThought.title}`,
      });
      const clear = this.contextEl.createEl("button", {
        text: "Clear",
        cls: "mod-muted",
      });
      clear.onclick = () => this.setContextThought(null);
    } else {
      this.contextEl.createSpan({
        text: "No context thought. Use 'Set chat context' (or click a graph node, then chat).",
      });
    }
  }

  private render(): void {
    if (!this.messagesEl) {
      return;
    }
    this.liveWrap = null;
    this.liveBubble = null;
    this.liveReasoning = null;
    this.messagesEl.empty();
    if (this.exchanges.length === 0) {
      this.messagesEl.createDiv({ cls: "kb-chat-empty" }).createEl("p", {
        text: "Ask anything about your knowledge base. The assistant responds in Markdown.",
      });
    }
    for (const ex of this.exchanges) {
      const wrap = this.messagesEl.createDiv({
        cls: `kb-chat-msg kb-${ex.role === "user" ? "user" : "assistant"}`,
      });
      if (ex.role === "user") {
        wrap.createDiv({ cls: "kb-chat-bubble", text: ex.content });
      } else {
        if (ex.reasoning) {
          const r = wrap.createDiv({ cls: "kb-chat-reasoning" });
          r.createSpan({ text: "Thinking:" });
          r.createDiv({ text: ex.reasoning });
        }
        const bubble = wrap.createDiv({ cls: "kb-chat-bubble" });
        if (ex.status === "streaming") {
          bubble.createSpan({ text: ex.content || "▋" });
          this.liveWrap = wrap;
          this.liveBubble = bubble;
        } else if (ex.status === "error") {
          wrap.createDiv({ cls: "kb-chat-error", text: ex.error ?? "Error" });
        } else {
          void MarkdownRenderer.render(
            this.app,
            ex.content || "_no response_",
            bubble,
            "",
            this,
          );
        }
      }
      if (ex.status !== "streaming" && ex.content.trim()) {
        const copy = wrap.createEl("button", {
          cls: "mod-muted kb-chat-copy",
          text: "Copy",
          attr: { title: "Copy this message" },
        });
        copy.onclick = () => void copyToClipboard(ex.content);
      }
    }
    this.followTail(!this.streaming);
  }

  /** Scroll the messages container so the newest content is visible. */
  private followTail(force = false): void {
    const el = this.messagesEl;
    if (!el) {
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (force || nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }

  /** Update only the in-progress assistant bubble (cheap, no full re-render). */
  private updateLive(ex: Exchange): void {
    if (!this.liveWrap || !this.liveBubble) {
      this.render();
      return;
    }
    if (ex.reasoning) {
      if (!this.liveReasoning) {
        const r = this.liveWrap.createDiv({ cls: "kb-chat-reasoning" });
        r.createSpan({ text: "Thinking:" });
        this.liveReasoning = r.createDiv();
        this.liveWrap.insertBefore(r, this.liveBubble);
      }
      this.liveReasoning.textContent = ex.reasoning;
    }
    this.liveBubble.textContent = ex.content || "▋";
    this.followTail();
  }

  /** Copy the whole conversation as plain text (You / Assistant blocks). */
  private async copyConversation(): Promise<void> {
    if (this.exchanges.length === 0) {
      return;
    }
    const lines = this.exchanges.map((ex) => {
      const who = ex.role === "user" ? "You" : "Assistant";
      return `${who}:\n${ex.content}`;
    });
    await copyToClipboard(lines.join("\n\n"));
  }

  private renderAssistantActions(ex: Exchange): void {
    if (ex.status !== "done" || !ex.content.trim()) {
      return;
    }
    this.suggestionsEl.empty();
    const row = this.suggestionsEl.createDiv({ cls: "kb-suggestions" });
    row.createDiv({ cls: "setting-item-description", text: "With this response:" });
    const save = row.createEl("button", { text: "Save as thought", cls: "mod-cta" });
    save.onclick = () => void this.saveAsThought(ex);
    // When the answer came from a follow-up question, the title is that
    // question; only a parent suggestion makes sense.
    if (!this.lastUser()?.type) {
      const suggest = row.createEl("button", { text: "Suggest a title", cls: "mod-muted" });
      suggest.onclick = () => void this.suggestTitleFor(ex);
    }
  }

  private buildSystemMessages(prompt: string): ChatMessage[] {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a thoughtful assistant helping the user build a personal " +
          "knowledge base where ideas are connected as thoughts (parents, children, " +
          "siblings). Answer clearly and conversationally. Use Markdown when helpful.",
      },
    ];
    if (this.contextThought) {
      const thought = this.contextThought;
      let context = `The user is currently working on the thought:\n\nTitle: ${thought.title}`;
      if (thought.content) {
        context += `\n\nContent:\n${thought.content}`;
      }
      context += "\n\nUse this thought as context for your answer when relevant.";
      messages.push({ role: "system", content: context });
    }
    messages.push({ role: "user", content: prompt });
    return messages;
  }

  private async send(): Promise<void> {
    const prompt = this.inputEl.value.trim();
    if (!prompt || this.streaming) {
      return;
    }
    this.inputEl.value = "";
    const settings = this.getSettings();

    const ex: Exchange = {
      role: "assistant",
      content: "",
      reasoning: "",
      status: "streaming",
    };
    this.exchanges.push({
      role: "user",
      content: prompt,
      reasoning: "",
      status: "done",
      type: this.pendingType,
    });
    this.pendingType = "";
    this.exchanges.push(ex);
    this.streaming = true;
    this.suggestionsEl.empty();
    this.render();

    try {
      await streamChat(
        this.buildSystemMessages(prompt),
        {
          apiKey: settings.apiKey,
          model: settings.model,
          temperature: settings.temperature,
          thinking: settings.thinking,
          provider: settings.provider,
        },
        (event) => {
          if (event.type === "delta") {
            ex.content += event.content;
            this.updateLive(ex);
          } else if (event.type === "reasoning") {
            ex.reasoning += event.content;
            this.updateLive(ex);
          } else if (event.type === "done") {
            ex.status = "done";
            this.streaming = false;
            this.liveWrap = null;
            this.liveBubble = null;
            this.liveReasoning = null;
            this.render();
            this.renderAssistantActions(ex);
          }
        },
      );
    } catch (e) {
      ex.status = "error";
      ex.error = e instanceof Error ? e.message : String(e);
      this.streaming = false;
      this.liveWrap = null;
      this.liveBubble = null;
      this.liveReasoning = null;
      this.render();
    }
  }

  // ------------------------------------------------------- save to KB

  private responseTitle(content: string): string {
    const line = content
      .split("\n")
      .map((l) => l.trim())
      .find(
        (l) =>
          l.length > 0 &&
          l.length <= 120 &&
          !l.startsWith("#") &&
          !l.startsWith("-") &&
          !l.startsWith("*") &&
          !isConversationalFiller(l),
      ) ?? "";
    const clean = line.replace(/[*_`>#]/g, "").trim();
    return sanitizeTitle(clean || "New thought").slice(0, 80);
  }

  private lastUser(): Exchange | undefined {
    return [...this.exchanges].reverse().find((x) => x.role === "user");
  }

  private lastUserType(): string {
    return this.lastUser()?.type ?? "";
  }

  /**
   * Title for a thought saved from a follow-up answer: the follow-up question
   * itself. Falls back to the answer's first line for normal chat saves.
   */
  private thoughtTitle(content: string): string {
    const user = this.lastUser();
    if (user?.type && user.content.trim()) {
      return sanitizeTitle(user.content.trim()).slice(0, 80);
    }
    return this.responseTitle(content);
  }

  private async saveAsThought(ex: Exchange): Promise<void> {
    const title = this.thoughtTitle(ex.content);
    const type = this.lastUserType();
    // Answer to a follow-up question: the parent is the thought the follow-up
    // was generated from (the chat context), not an AI guess.
    if (type && this.contextThought) {
      this.renderSaveChoice(title, ex.content, type, this.contextThought);
      return;
    }
    const lastUser = this.lastUser();
    this.suggestionsEl.empty();
    this.suggestionsEl.createDiv({ cls: "setting-item-description", text: "Choosing a parent..." });

    let suggestions: Suggestion[];
    try {
      suggestions = await this.ai.suggestParents(
        title,
        ex.content,
        this.getSettings(),
        { prompt: lastUser?.content ?? "" },
      );
    } catch (e) {
      this.suggestionsEl.empty();
      new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.suggestionsEl.empty();
    const box = this.suggestionsEl.createDiv({ cls: "kb-suggestions" });
    this.renderSavePrompt(box, title);
    const best = suggestions[0];
    if (best && best.parent_id) {
      const pick = box.createEl("button", {
        cls: "mod-cta",
        text: `Under "${best.parent_title ?? best.parent_id}" — ${best.reason}`,
      });
      pick.onclick = () => void this.createThought(title, ex.content, [best.parent_id as string], type);
      const root = box.createEl("button", { cls: "mod-muted", text: "New root thought" });
      root.onclick = () => void this.createThought(title, ex.content, [], type);
    } else {
      const root = box.createEl("button", { cls: "mod-cta", text: "New root thought" });
      root.onclick = () => void this.createThought(title, ex.content, [], type);
    }
  }

  /** "Save \"<title>\" as:" line with a button to copy the title. */
  private renderSavePrompt(box: HTMLElement, title: string): void {
    const row = box.createDiv({ cls: "kb-title-row" });
    row.createSpan({ cls: "setting-item-description", text: `Save "${title}" as:` });
    const copy = row.createEl("button", {
      cls: "mod-muted kb-title-copy",
      text: "Copy title",
      attr: { title: "Copy title" },
    });
    copy.onclick = (evt) => {
      evt.stopPropagation();
      void copyToClipboard(title);
    };
  }

  /** Confirmation for a known parent (the follow-up's source thought). */
  private renderSaveChoice(
    title: string,
    content: string,
    type: string,
    parent: Thought,
  ): void {
    this.suggestionsEl.empty();
    const box = this.suggestionsEl.createDiv({ cls: "kb-suggestions" });
    this.renderSavePrompt(box, title);
    const pick = box.createEl("button", {
      cls: "mod-cta",
      text: `Under "${parent.title}" — the thought this follow-up came from`,
    });
    pick.onclick = () => void this.createThought(title, content, [parent.id], type);
    const root = box.createEl("button", { cls: "mod-muted", text: "New root thought" });
    root.onclick = () => void this.createThought(title, content, [], type);
  }

  private async createThought(
    title: string,
    content: string,
    parents: string[],
    type = "",
  ): Promise<void> {
    const key = title.trim().toLowerCase();
    if (!key || this.savingTitles.has(key)) {
      // Duplicate click while an identical create is already in flight.
      return;
    }
    this.savingTitles.add(key);
    // Drop the suggestion row immediately so it cannot be clicked again.
    this.suggestionsEl.empty();
    try {
      const thought = await this.kb.createThought(title, content, parents, type);
      const parentLabel = thought.parents[0]?.title;
      new Notice(
        `Created "${thought.title}"${parentLabel ? ` under "${parentLabel}"` : ""}` +
          `${thought.question_type ? ` (${thought.question_type})` : ""}`,
      );
      this.openThoughtFile(thought.id);
    } catch (e) {
      const rec = this.kb.getRecord(sanitizeTitle(title));
      if (rec) {
        // Duplicate save: the thought already exists, so there is no error to
        // show — surface the existing note instead of leaving a dead button.
        new Notice(`"${rec.title}" already exists — opening the existing note.`);
        this.openThoughtFile(rec.id);
      } else {
        new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      this.savingTitles.delete(key);
    }
  }

  /** Open the note for a thought id in a new leaf (best-effort, non-blocking). */
  private openThoughtFile(id: string): void {
    const rec = this.kb.getRecord(id);
    if (!rec) {
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(rec.path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  private async suggestTitleFor(ex: Exchange): Promise<void> {
    const settings = this.getSettings();
    this.suggestionsEl.empty();
    this.suggestionsEl.createDiv({ cls: "setting-item-description", text: "Suggesting titles..." });
    let titles: TitleSuggestion[];
    try {
      titles = await this.ai.suggestTitles(this.responseTitle(ex.content), ex.content, settings);
    } catch (e) {
      this.suggestionsEl.empty();
      new Notice(`Knowledge Brain: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.suggestionsEl.empty();
    const box = this.suggestionsEl.createDiv({ cls: "kb-suggestions" });
    box.createDiv({ cls: "setting-item-description", text: "Suggested titles:" });
    for (const t of titles) {
      const label = `${t.title} — ${t.reason}`;
      addCopyableSuggestion(
        box,
        label,
        label,
        () => void this.createThoughtFromTitle(t.title, ex.content),
      );
    }
  }

  /** Create the thought immediately when a suggested title is picked. */
  private async createThoughtFromTitle(title: string, content: string): Promise<void> {
    const parents = this.contextThought ? [this.contextThought.id] : [];
    await this.createThought(title, content, parents, this.lastUserType());
  }
}
