import { KbError, errorFromResponse, PROVIDER_BASE_URLS } from "./settings";
import { requestUrl, type RequestUrlParam } from "obsidian";
import type { ClientRequest, IncomingMessage } from "http";
import type { PluginSettings, Provider } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatEvent =
  | { type: "delta"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ClientOptions {
  apiKey: string;
  model: string;
  temperature: number;
  thinking: boolean;
  maxTokens?: number;
  /** Which provider API to call. */
  provider: Provider;
}

function requireKey(apiKey: string): void {
  if (!apiKey.trim()) {
    throw new KbError(
      "No API key configured. Add it in Knowledge Brain settings.",
    );
  }
}

/** Thrown when the Node networking modules are unavailable (e.g. not desktop). */
class NodeStreamUnavailable extends Error {}

/** True when the provider/model supports a thinking (reasoning) parameter. */
export function modelSupportsThinking(provider: Provider, model: string): boolean {
  if (provider === "deepseek") {
    return true;
  }
  if (provider === "claude") {
    return /^claude-(fable|opus|sonnet)/.test(model);
  }
  if (provider === "openai") {
    return /^(gpt-5|o3|o4)/.test(model);
  }
  if (provider === "gemini") {
    // All Gemini models in the settings list support thinking (the API sends
    // a thinkingConfig). Enable the toggle for any gemini-* model.
    return /^gemini-/.test(model);
  }
  return false;
}

/** Built-in endpoint for a provider. */
function baseUrlFor(provider: Provider): string {
  return PROVIDER_BASE_URLS[provider];
}

/** Append /v1 + path unless the base already ends with /v1. */
function chatUrl(baseUrl: string, path: string): string {
  const base = (baseUrl || "").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base + path : base + "/v1" + path;
}

// ------------------------------------------------------------ message maps

/** Split system messages out for Claude (top-level `system` field). */
function claudeMessages(msgs: ChatMessage[]): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const system = msgs
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const messages = msgs
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  return { system, messages };
}

/** Map to Gemini's contents/systemInstruction shape (assistant → model). */
function geminiContents(msgs: ChatMessage[]): {
  contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  systemInstruction?: { parts: Array<{ text: string }> };
} {
  const systemParts = msgs
    .filter((m) => m.role === "system")
    .map((m) => ({ text: m.content }));
  const contents = msgs
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" as const : "user" as const,
      parts: [{ text: m.content }],
    }));
  return {
    contents,
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
  };
}

// ------------------------------------------------------------ request build

/** Build the URL, headers, and body for a provider request (stream or not). */
function buildRequest(
  opts: ClientOptions,
  messages: ChatMessage[],
  stream: boolean,
  jsonMode = false,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = baseUrlFor(opts.provider);
  const maxTokens = opts.maxTokens ?? (jsonMode ? 1024 : 2048);

  if (opts.provider === "claude") {
    const { system, messages: msgs } = claudeMessages(messages);
    // Anthropic requires max_tokens > budget_tokens, and temperature must be 1
    // when extended thinking is enabled. Only send for models that support it.
    const thinking =
      opts.thinking && modelSupportsThinking(opts.provider, opts.model)
        ? { type: "enabled" as const, budget_tokens: Math.max(1, maxTokens - 1) }
        : undefined;
    return {
      url: `${base.replace(/\/+$/, "")}/v1/messages`,
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: opts.model,
        max_tokens: maxTokens,
        temperature: thinking ? 1 : opts.temperature,
        system: system || undefined,
        messages: msgs,
        stream,
        ...(thinking ? { thinking } : {}),
      },
    };
  }

  if (opts.provider === "gemini") {
    const g = geminiContents(messages);
    const url =
      `${base.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent` +
      `?key=${encodeURIComponent(opts.apiKey)}` +
      (stream ? "&alt=sse" : "");
    const generationConfig: Record<string, unknown> = {
      temperature: opts.temperature,
      maxOutputTokens: maxTokens,
      // Gemini only returns clean JSON when the API is told to; otherwise it
      // may wrap the answer in markdown fences or prose, which breaks the
      // JSON parse in chatJson.
      ...(jsonMode ? { responseMimeType: "application/json" } : {}),
    };
    // Gemini 3.x uses thinkingLevel; 2.5 and older use thinkingBudget. Only
    // send when thinking is on and the model supports it.
    if (opts.thinking && modelSupportsThinking(opts.provider, opts.model)) {
      if (/^gemini-3/.test(opts.model)) {
        generationConfig.thinkingConfig = {
          thinkingLevel: "high",
          ...(stream ? { includeThoughts: true } : {}),
        };
      } else {
        generationConfig.thinkingConfig = { thinkingBudget: -1 };
      }
    }
    return {
      url,
      headers: {},
      body: { ...g, generationConfig },
    };
  }

  // deepseek / openai — OpenAI-compatible chat completions.
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: opts.temperature,
    stream,
    max_tokens: maxTokens,
  };
  if (opts.provider === "deepseek") {
    body.thinking = { type: opts.thinking ? "enabled" : "disabled" };
  } else if (
    opts.provider === "openai" &&
    opts.thinking &&
    modelSupportsThinking(opts.provider, opts.model)
  ) {
    body.reasoning_effort = "high";
  }
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }
  return {
    url: chatUrl(base, "/chat/completions"),
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body,
  };
}

// ------------------------------------------------------------- low-level IO

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new KbError(`Request timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * POST `body` to `url` via Obsidian's requestUrl (main process — no CORS) and
 * return { status, text }. Generalizes requestDeepSeek to arbitrary providers.
 */
async function postText(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const params: RequestUrlParam = {
    url,
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
  let resp;
  try {
    resp = await withTimeout(requestUrl(params), timeoutMs);
  } catch (e) {
    throw e instanceof KbError
      ? e
      : new KbError(
          `Could not reach the AI provider (${url}): ${e instanceof Error ? e.message : String(e)}`,
        );
  }
  return { status: resp.status, text: resp.text };
}

// ---------------------------------------------------------------- SSE parse

/** One SSE `data:` payload may carry text, reasoning, or both. */
interface ExtractedDelta {
  delta?: string;
  reasoning?: string;
}

function emitExtracted(extracted: ExtractedDelta, onEvent: (e: ChatEvent) => void): void {
  if (extracted.reasoning) {
    onEvent({ type: "reasoning", content: extracted.reasoning });
  }
  if (extracted.delta) {
    onEvent({ type: "delta", content: extracted.delta });
  }
}

/** Extract text + reasoning from one SSE `data:` payload for Claude. */
function extractClaudeDelta(data: string): ExtractedDelta | null {
  try {
    const obj = JSON.parse(data) as {
      type?: string;
      delta?: { type?: string; text?: string; thinking?: string };
    };
    if (obj.type === "content_block_delta" && obj.delta) {
      if (obj.delta.type === "text_delta" && typeof obj.delta.text === "string" && obj.delta.text) {
        return { delta: obj.delta.text };
      }
      if (
        obj.delta.type === "thinking_delta" &&
        typeof obj.delta.thinking === "string" &&
        obj.delta.thinking
      ) {
        return { reasoning: obj.delta.thinking };
      }
    }
  } catch {
    /* non-JSON chunk */
  }
  return null;
}

/** Extract text + reasoning from one SSE `data:` payload for Gemini. */
function extractGeminiDelta(data: string): ExtractedDelta | null {
  try {
    const obj = JSON.parse(data) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      }>;
    };
    const parts = obj.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      let delta = "";
      let reasoning = "";
      for (const p of parts) {
        if (typeof p?.text === "string") {
          if (p.thought) {
            reasoning += p.text;
          } else {
            delta += p.text;
          }
        }
      }
      return delta || reasoning
        ? { delta: delta || undefined, reasoning: reasoning || undefined }
        : null;
    }
  } catch {
    /* non-JSON chunk */
  }
  return null;
}

/** Extract text + reasoning from one OpenAI-compatible SSE `data:` payload. */
function extractOpenAiDelta(data: string): ExtractedDelta | null {
  try {
    const obj = JSON.parse(data) as {
      choices?: Array<{ delta?: Record<string, unknown> }>;
    };
    const delta = obj.choices?.[0]?.delta ?? {};
    let text = "";
    let reasoning = "";
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      reasoning = delta.reasoning_content;
    }
    if (typeof delta.content === "string" && delta.content) {
      text = delta.content;
    }
    return text || reasoning
      ? { delta: text || undefined, reasoning: reasoning || undefined }
      : null;
  } catch {
    return null;
  }
}

/**
 * Incremental SSE pump: feed raw chunks, emit deltas per complete line. Returns
 * true once a `[DONE]` marker is seen (callers stop feeding and emit done).
 */
function pumpSseChunk(
  buffer: { data: string },
  chunk: string,
  extract: (data: string) => ExtractedDelta | null,
  emit: (d: ExtractedDelta) => void,
): boolean {
  buffer.data += chunk;
  let nl: number;
  while ((nl = buffer.data.indexOf("\n")) >= 0) {
    const line = buffer.data.slice(0, nl).replace(/\r$/, "");
    buffer.data = buffer.data.slice(nl + 1);
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      return true;
    }
    const extracted = extract(data);
    if (extracted) {
      emit(extracted);
    }
  }
  return false;
}

let nodeModules:
  | { http: typeof import("http"); https: typeof import("https") }
  | null
  | undefined;

/** Lazy-load the Node networking modules (available on desktop Obsidian). */
function getNodeModules():
  | { http: typeof import("http"); https: typeof import("https") }
  | null {
  if (nodeModules === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      nodeModules = {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        http: require("http") as typeof import("http"),
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        https: require("https") as typeof import("https"),
      };
    } catch {
      nodeModules = null;
    }
  }
  return nodeModules;
}

/**
 * Stream an SSE response through the Node `https`/`http` modules. They run on
 * the desktop side of Obsidian, outside the renderer's CSP/CORS, so provider
 * tokens arrive progressively instead of after the full response buffers.
 */
export async function nodeStreamChat(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  extract: (data: string) => ExtractedDelta | null,
  onEvent: (e: ChatEvent) => void,
  timeoutMs: number,
): Promise<void> {
  const mods = getNodeModules();
  if (!mods) {
    throw new NodeStreamUnavailable();
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new NodeStreamUnavailable();
  }
  const isHttps = target.protocol === "https:";
  const request = (
    isHttps ? mods.https.request : mods.http.request
  ) as (
    options: import("http").RequestOptions,
    callback?: (res: IncomingMessage) => void,
  ) => ClientRequest;
  const payload = JSON.stringify(body);
  const buffer: { data: string } = { data: "" };
  await new Promise<void>((resolve, reject) => {
    let req: ClientRequest;
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        req.destroy();
        reject(
          new KbError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`),
        );
      }
    }, timeoutMs);
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      fn();
    };
    req = request(
      {
        hostname: target.hostname,
        port: target.port ? Number(target.port) : isHttps ? 443 : 80,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
          "Content-Length": String(Buffer.byteLength(payload)),
        },
      },
      (res: IncomingMessage) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          let errBody = "";
          res.on("data", (d: Buffer) => {
            errBody += d.toString("utf8");
          });
          res.on("end", () => {
            finish(() =>
              reject(errorFromResponse(res.statusCode ?? 0, errBody)),
            );
          });
          return;
        }
        res.setEncoding("utf8");
        let stopped = false;
        res.on("data", (chunk: string) => {
          if (stopped) {
            return;
          }
          stopped = pumpSseChunk(buffer, chunk, extract, (d) =>
            emitExtracted(d, onEvent),
          );
        });
        res.on("end", () => finish(resolve));
        res.on("error", (e) => finish(() => reject(e)));
      },
    );
    req.on("error", (e) => finish(() => reject(e)));
    req.write(payload);
    req.end();
  });
}

/**
 * Stream an SSE response via the renderer's fetch (progressive tokens when the
 * environment's CSP/CORS allow it).
 */
async function fetchStreamChat(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  extract: (data: string) => ExtractedDelta | null,
  onEvent: (e: ChatEvent) => void,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      throw errorFromResponse(resp.status, text);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const buffer: { data: string } = { data: "" };
    let stopped = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        stopped = pumpSseChunk(
          buffer,
          decoder.decode(value, { stream: true }),
          extract,
          (d) => emitExtracted(d, onEvent),
        );
        if (stopped) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
    if (!stopped) {
      const tail = decoder.decode();
      if (tail) {
        pumpSseChunk(buffer, tail, extract, (d) => emitExtracted(d, onEvent));
      }
    }
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * Stream chat with the selected provider. OpenAI-compatible providers stream
 * reasoning + content deltas; Claude and Gemini stream content deltas.
 */
export async function streamChat(
  messages: ChatMessage[],
  opts: ClientOptions,
  onEvent: (e: ChatEvent) => void,
): Promise<void> {
  requireKey(opts.apiKey);
  const { url, headers, body } = buildRequest(opts, messages, true);
  const extract =
    opts.provider === "claude"
      ? extractClaudeDelta
      : opts.provider === "gemini"
        ? extractGeminiDelta
        : extractOpenAiDelta;
  const timeoutMs = 120_000;

  // Transport ladder. Node https/http (desktop) bypass the renderer CSP/CORS
  // and deliver tokens progressively — the primary path. Renderer fetch is a
  // fallback where Node networking is unavailable, and the buffered requestUrl
  // call is the last resort.
  let emitted = false;
  const track: (e: ChatEvent) => void = (e) => {
    if (e.type !== "done") {
      emitted = true;
    }
    onEvent(e);
  };

  try {
    await nodeStreamChat(url, headers, body, extract, track, timeoutMs);
    onEvent({ type: "done" });
    return;
  } catch (e) {
    if (emitted || e instanceof KbError) {
      throw e;
    }
    // Node unavailable or failed before any content — try the renderer fetch.
  }

  try {
    await fetchStreamChat(url, headers, body, extract, track, timeoutMs);
    onEvent({ type: "done" });
    return;
  } catch (e) {
    if (emitted || e instanceof KbError) {
      throw e;
    }
    // fetch blocked (CSP/CORS) or failed before content — buffered fallback.
  }

  const { status, text } = await postText(url, headers, body, timeoutMs);
  if (status < 200 || status >= 300) {
    throw errorFromResponse(status, text);
  }
  pumpSseChunk({ data: "" }, text, extract, (d) => emitExtracted(d, onEvent));
  onEvent({ type: "done" });
}

/** Extract the plain text of a non-streaming response for the provider. */
function extractResponseText(provider: Provider, text: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new KbError("The AI provider returned a non-JSON response");
  }
  if (provider === "claude") {
    const blocks = Array.isArray(parsed.content) ? (parsed.content as Array<Record<string, unknown>>) : [];
    return blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("");
  }
  if (provider === "gemini") {
    const candidates = Array.isArray(parsed.candidates)
      ? (parsed.candidates as Array<Record<string, unknown>>)
      : [];
    const parts = (candidates[0]?.content as Record<string, unknown> | undefined)?.parts;
    return Array.isArray(parts)
      ? parts.map((p) => String((p as Record<string, unknown>).text ?? "")).join("")
      : "";
  }
  const content = (parsed.choices as Array<{ message?: { content?: unknown } }> | undefined)
    ?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

/**
 * Non-streaming JSON-object completion (used by all AI-assisted ops).
 * Thinking is forced off here: reasoning mode conflicts with structured JSON
 * output on some providers (e.g. DeepSeek returns reasoning content but an
 * empty JSON content), and this keeps the whole token budget on the JSON answer.
 */
export async function chatJson(
  messages: ChatMessage[],
  opts: ClientOptions,
): Promise<Record<string, unknown>> {
  requireKey(opts.apiKey);
  const jsonOpts: ClientOptions = { ...opts, thinking: false };
  const { url, headers, body } = buildRequest(jsonOpts, messages, false, true);
  const { status, text } = await postText(url, headers, body, 30_000);
  if (status < 200 || status >= 300) {
    throw errorFromResponse(status, text);
  }
  const content = extractResponseText(opts.provider, text);
  const parsed = parseJsonContent(content);
  if (parsed === null) {
    throw new KbError("The AI provider did not return valid JSON");
  }
  return parsed;
}

/**
 * Parse a model's text as JSON, tolerating markdown code fences and leading/
 * trailing prose that some providers (notably Claude, which has no JSON-mode
 * API field) may wrap the answer in. Returns null when no JSON is found.
 */
export function parseJsonContent(content: string): Record<string, unknown> | null {
  const text = content.trim();
  if (!text) {
    return null;
  }
  const candidates: string[] = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    candidates.push(fence[1].trim());
  }
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Verify connectivity with the configured provider/model. */
export async function testProvider(settings: PluginSettings): Promise<string> {
  const opts: ClientOptions = {
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    thinking: false,
    provider: settings.provider,
    maxTokens: 8,
  };
  const { url, headers, body } = buildRequest(
    opts,
    [{ role: "user", content: "ping" }],
    false,
  );
  const { status, text } = await postText(url, headers, body, 30_000);
  if (status < 200 || status >= 300) {
    throw errorFromResponse(status, text);
  }
  return `Connected (${settings.provider}: ${settings.model}).`;
}
