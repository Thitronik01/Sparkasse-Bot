import { AIProviderError, type AIErrorCode } from "./errors";
import { log } from "../log";

/**
 * Serverseitiger HTTP-Client für die anymize API (OpenAI-kompatibel).
 *
 * Verantwortlich für: Authentifizierung, Base-URLs, Timeouts, Retries (429/5xx mit Retry-After),
 * Fehlerabbildung, JSON-/SSE-Parsing und Logging ohne Prompt-Inhalte.
 * Fachlogik (RAG, Corrections, Confidence) gehört NICHT hierher.
 *
 * Doku: https://app.anymize.ai/api-docs
 *   Chat:        POST {llm | llm-anonymous}/chat/completions
 *   Embeddings:  POST {llm}/embeddings   (GET liefert Modellliste inkl. Dimensionen)
 *   Modelle:     GET  {llm}/models
 */

if (typeof window !== "undefined") {
  throw new Error("anymize-client darf nur serverseitig verwendet werden.");
}

export type AnymizeClientConfig = {
  apiKey: string | undefined;
  llmBaseUrl: string;
  anonymousBaseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

// ---- OpenAI-kompatible Wire-Formate (nur die Felder, die wir nutzen) ----

export type WireChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type WireChatRequest = {
  model: string;
  messages: WireChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  stream?: boolean;
};

export type WireUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

export type WireChatCompletion = {
  id?: string;
  model?: string;
  choices: { index?: number; message?: { role?: string; content?: string | null }; finish_reason?: string | null }[];
  usage?: WireUsage;
};

export type WireChatChunk = {
  id?: string;
  model?: string;
  choices?: { index?: number; delta?: { role?: string; content?: string | null }; finish_reason?: string | null }[];
  usage?: WireUsage;
};

export type WireEmbeddingRequest = {
  model?: string;
  input: string[];
  input_type?: "document" | "query";
  output_dimension?: number;
};

export type WireEmbeddingResponse = {
  model?: string;
  data: { index: number; embedding: number[] }[];
  usage?: WireUsage;
};

type Operation = "chat" | "chat_stream" | "embeddings" | "list_models" | "list_embedding_models";

const MAX_RETRY_AFTER_MS = 20_000;

export class AnymizeClient {
  private readonly cfg: Required<Omit<AnymizeClientConfig, "apiKey">> & { apiKey: string | undefined };

  constructor(config: AnymizeClientConfig) {
    this.cfg = {
      ...config,
      llmBaseUrl: config.llmBaseUrl.replace(/\/+$/, ""),
      anonymousBaseUrl: config.anonymousBaseUrl.replace(/\/+$/, ""),
      fetchImpl: config.fetchImpl ?? fetch,
      sleep: config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  /** Entscheidung anonym/normal fällt ausschließlich serverseitig über die Konfiguration. */
  chatUrl(anonymous: boolean): string {
    return `${anonymous ? this.cfg.anonymousBaseUrl : this.cfg.llmBaseUrl}/chat/completions`;
  }

  async chatCompletion(body: WireChatRequest, opts: { anonymous: boolean; signal?: AbortSignal }): Promise<WireChatCompletion> {
    const { json } = await this.requestJson<WireChatCompletion>("chat", this.chatUrl(opts.anonymous), {
      method: "POST",
      body: { ...body, stream: false },
      signal: opts.signal,
      meta: { model: body.model, anonymous: opts.anonymous },
    });
    if (!json || !Array.isArray(json.choices) || json.choices.length === 0) {
      throw new AIProviderError("invalid_response", "Chat-Antwort ohne choices");
    }
    return json;
  }

  /** Streamt Chat-Chunks (SSE, `data:`-Zeilen, Abschluss mit `[DONE]`). */
  async *chatCompletionStream(
    body: WireChatRequest,
    opts: { anonymous: boolean; signal?: AbortSignal },
  ): AsyncGenerator<WireChatChunk> {
    const { response, timer } = await this.request("chat_stream", this.chatUrl(opts.anonymous), {
      method: "POST",
      body: { ...body, stream: true },
      signal: opts.signal,
      meta: { model: body.model, anonymous: opts.anonymous },
      keepTimer: true,
    });
    if (!response.body) {
      timer.clear();
      throw new AIProviderError("invalid_response", "Stream-Antwort ohne Body");
    }
    try {
      for await (const data of readSse(response.body, () => timer.reset())) {
        if (data === "[DONE]") return;
        let chunk: WireChatChunk & { error?: unknown };
        try {
          chunk = JSON.parse(data);
        } catch (e) {
          throw new AIProviderError("invalid_response", "Ungültiger SSE-Chunk", { cause: e });
        }
        if (chunk.error) throw mapHttpError(200, { error: chunk.error }, undefined);
        yield chunk;
      }
    } catch (e) {
      throw this.normalizeThrown(e, timer, opts.signal);
    } finally {
      timer.clear();
    }
  }

  async embeddings(body: WireEmbeddingRequest, opts: { signal?: AbortSignal } = {}): Promise<WireEmbeddingResponse> {
    try {
      const { json } = await this.requestJson<WireEmbeddingResponse>("embeddings", `${this.cfg.llmBaseUrl}/embeddings`, {
        method: "POST",
        body,
        signal: opts.signal,
        meta: { model: body.model, inputs: body.input.length, input_type: body.input_type },
      });
      if (!json || !Array.isArray(json.data) || json.data.length !== body.input.length) {
        throw new AIProviderError("invalid_response", "Embedding-Antwort unvollständig");
      }
      return json;
    } catch (e) {
      // Konfigurations- und Authentifizierungsfehler bleiben erkennbar, alles andere wird zum Embedding-Fehler.
      if (e instanceof AIProviderError && ["invalid_response", "bad_request", "server_error"].includes(e.code)) {
        throw new AIProviderError("embedding_error", e.message, { status: e.status, cause: e });
      }
      throw e;
    }
  }

  async listModels(): Promise<unknown> {
    return (await this.requestJson("list_models", `${this.cfg.llmBaseUrl}/models`, { method: "GET" })).json;
  }

  /** Laut Doku liefert GET auf den Embedding-Pfad die Modellliste samt Dimensionen. */
  async listEmbeddingModels(): Promise<unknown> {
    return (await this.requestJson("list_embedding_models", `${this.cfg.llmBaseUrl}/embeddings`, { method: "GET" })).json;
  }

  // ---------------------------------------------------------------------------

  private async requestJson<T>(op: Operation, url: string, init: RequestInit2): Promise<{ json: T }> {
    const { response, timer } = await this.request(op, url, { ...init, keepTimer: true });
    try {
      const text = await response.text();
      try {
        return { json: JSON.parse(text) as T };
      } catch (e) {
        throw new AIProviderError("invalid_response", `Antwort ist kein gültiges JSON (${op})`, { status: response.status, cause: e });
      }
    } catch (e) {
      throw this.normalizeThrown(e, timer, init.signal);
    } finally {
      timer.clear();
    }
  }

  /**
   * Führt den HTTP-Request inkl. Retries aus und liefert eine erfolgreiche Response.
   * Der Timeout-Timer läuft weiter, solange `keepTimer` gesetzt ist (Body-Lesen zählt mit).
   */
  private async request(op: Operation, url: string, init: RequestInit2): Promise<{ response: Response; timer: Timer }> {
    if (!this.cfg.apiKey) {
      throw new AIProviderError("missing_api_key", "ANYMIZE_API_KEY ist nicht gesetzt");
    }

    let attempt = 0;
    for (;;) {
      attempt++;
      const started = Date.now();
      const timer = createTimer(this.cfg.timeoutMs, init.signal);
      try {
        const response = await this.cfg.fetchImpl(url, {
          method: init.method,
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            Accept: op === "chat_stream" ? "text/event-stream" : "application/json",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: timer.signal,
          cache: "no-store",
        });

        const logFields = {
          op,
          status: response.status,
          attempt,
          duration_ms: Date.now() - started,
          request_id: response.headers.get("x-request-id") ?? undefined,
          credits_used: response.headers.get("x-anymize-credits-used") ?? undefined,
          ratelimit_remaining: response.headers.get("x-ratelimit-remaining") ?? undefined,
          ...init.meta,
        };

        if (response.ok) {
          log.info("anymize.request", logFields);
          if (!init.keepTimer) timer.clear();
          return { response, timer };
        }

        const errorBody = await safeJson(response);
        const err = mapHttpError(response.status, errorBody, response.headers.get("retry-after"));
        timer.clear();
        log.warn("anymize.request_failed", {
          ...logFields,
          code: err.code,
          upstream_code: upstreamField(errorBody, "code"),
          upstream_type: upstreamField(errorBody, "type"),
        });
        if (!err.retryable || attempt > this.cfg.maxRetries) throw err;
        await this.cfg.sleep(backoffMs(attempt, err.retryAfterMs));
      } catch (e) {
        if (e instanceof AIProviderError) throw e;
        const err = this.normalizeThrown(e, timer, init.signal);
        timer.clear();
        if (!(err instanceof AIProviderError)) {
          log.info("anymize.request_aborted", { op, attempt, duration_ms: Date.now() - started });
          throw err;
        }
        log.warn("anymize.request_failed", { op, attempt, duration_ms: Date.now() - started, code: err.code, ...init.meta });
        if (!err.retryable || attempt > this.cfg.maxRetries) throw err;
        await this.cfg.sleep(backoffMs(attempt));
      }
    }
  }

  /** Unterscheidet Timeout, Abbruch durch den Aufrufer und Netzwerkfehler. */
  private normalizeThrown(e: unknown, timer: Timer, external?: AbortSignal): unknown {
    if (e instanceof AIProviderError) return e;
    if (external?.aborted) return e; // Aufrufer hat abgebrochen (z. B. Browser getrennt) – unverändert weiterreichen.
    if (timer.timedOut) return new AIProviderError("timeout", `Timeout nach ${this.cfg.timeoutMs} ms`, { cause: e });
    return new AIProviderError("network_error", "Netzwerkfehler beim Aufruf von anymize", { cause: e });
  }
}

type RequestInit2 = {
  method: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  meta?: Record<string, string | number | boolean | undefined>;
  keepTimer?: boolean;
};

type Timer = { signal: AbortSignal; readonly timedOut: boolean; reset(): void; clear(): void };

/** Inaktivitäts-Timeout: wird beim Streaming mit jedem empfangenen Chunk zurückgesetzt. */
function createTimer(ms: number, external?: AbortSignal): Timer {
  const controller = new AbortController();
  let timedOut = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, ms);
  };
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  arm();
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    reset: arm,
    clear: () => {
      if (handle) clearTimeout(handle);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  const base = 500 * 2 ** (attempt - 1);
  return Math.min(base + Math.floor(Math.random() * 250), MAX_RETRY_AFTER_MS);
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function upstreamField(body: unknown, field: "code" | "type" | "message"): string | undefined {
  const err = (body as { error?: Record<string, unknown> } | undefined)?.error;
  const v = err && typeof err === "object" ? err[field] : undefined;
  return typeof v === "string" ? v : undefined;
}

/** Bildet HTTP-Status und anymize-Fehlercodes (error.code) auf unsere Fehlercodes ab. */
export function mapHttpError(status: number, body: unknown, retryAfterHeader: string | null | undefined): AIProviderError {
  const upstreamCode = upstreamField(body, "code") ?? "";
  const upstreamType = upstreamField(body, "type") ?? "";
  const retryAfterMs = parseRetryAfter(retryAfterHeader);

  let code: AIErrorCode;
  if (upstreamCode === "invalid_api_key" || status === 401) code = "invalid_api_key";
  else if (upstreamCode === "model_not_found") code = "model_not_found";
  else if (upstreamCode === "missing_model") code = "missing_model";
  else if (/credit/i.test(upstreamCode) || status === 402) code = "insufficient_credits";
  else if (upstreamCode === "rate_limit_exceeded" || upstreamType === "rate_limit_error" || status === 429) code = "rate_limited";
  else if (upstreamCode === "service_unavailable" || status === 503) code = "service_unavailable";
  else if (status === 403) code = "forbidden";
  else if (status === 404) code = "not_configured"; // Endpunkt existiert nicht → Base-URL prüfen
  else if (status === 408 || status === 504) code = "timeout";
  else if (status >= 500) code = "server_error";
  else if (status >= 400) code = "bad_request";
  else code = "invalid_response";

  const detail = upstreamCode || upstreamType ? ` (${[upstreamType, upstreamCode].filter(Boolean).join("/")})` : "";
  return new AIProviderError(code, `anymize HTTP ${status}${detail}`, { status, retryAfterMs });
}

/** Minimaler SSE-Parser: liefert den (ggf. mehrzeiligen) data-Inhalt je Event. */
export async function* readSse(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk?.();
      buffer += decoder.decode(value, { stream: true });
      let sep: RegExpExecArray | null;
      while ((sep = /\r?\n\r?\n/.exec(buffer))) {
        const rawEvent = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep[0].length);
        const data = extractData(rawEvent);
        if (data !== undefined) yield data;
      }
    }
    buffer += decoder.decode();
    const data = extractData(buffer);
    if (data !== undefined) yield data;
  } finally {
    reader.releaseLock();
  }
}

function extractData(rawEvent: string): string | undefined {
  const lines = rawEvent
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  return lines.length ? lines.join("\n") : undefined;
}
