import { AnymizeClient, type WireChatRequest } from "./anymize-client";
import { AIProviderError } from "./errors";
import type { AIProvider } from "./provider";
import type { ChatRequest, ChatResponse, ChatStreamEvent, EmbedOptions, EmbeddingInfo, TokenUsage } from "./types";
import { getServerEnv, type ServerEnv } from "../config/server-env";

/**
 * AIProvider-Implementierung für anymize.
 *
 * - Chat läuft je nach ANYMIZE_USE_ANONYMIZATION über /llm-anonymous oder /llm.
 *   Nur der Endpunkt ändert sich – Request-Format und RAG-Logik bleiben identisch.
 * - Embeddings laufen über /llm/embeddings (laut anymize-Doku gibt es dafür keinen anonymen Endpunkt;
 *   die Texte werden von Voyage AI verarbeitet). Siehe docs/EMBEDDINGS.md.
 */
export class AnyMizeProvider implements AIProvider {
  readonly name = "anymize";
  private readonly env: ServerEnv;
  private readonly client: AnymizeClient;

  constructor(opts: { env?: ServerEnv; client?: AnymizeClient } = {}) {
    this.env = opts.env ?? getServerEnv();
    this.client =
      opts.client ??
      new AnymizeClient({
        apiKey: this.env.ANYMIZE_API_KEY,
        llmBaseUrl: this.env.ANYMIZE_API_BASE_URL,
        anonymousBaseUrl: this.env.ANYMIZE_ANONYMOUS_API_BASE_URL,
        timeoutMs: this.env.ANYMIZE_TIMEOUT_MS,
        maxRetries: this.env.ANYMIZE_MAX_RETRIES,
      });
  }

  get anonymized(): boolean {
    return this.env.ANYMIZE_USE_ANONYMIZATION;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.chatBody(request);
    const res = await this.client.chatCompletion(body, { anonymous: this.anonymized, signal: request.signal });
    const choice = res.choices[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      throw new AIProviderError("invalid_response", "Chat-Antwort ohne message.content");
    }
    return {
      content,
      model: res.model ?? body.model,
      finishReason: choice.finish_reason ?? undefined,
      anonymized: this.anonymized,
      usage: res.usage && {
        promptTokens: res.usage.prompt_tokens,
        completionTokens: res.usage.completion_tokens,
        totalTokens: res.usage.total_tokens,
      },
    };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const body = this.chatBody(request);
    let finishReason: string | undefined;
    let usage: TokenUsage | undefined;
    for await (const chunk of this.client.chatCompletionStream(body, { anonymous: this.anonymized, signal: request.signal })) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) yield { type: "delta", content: delta };
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
    }
    yield { type: "done", finishReason, usage };
  }

  async embed(input: string[], options: EmbedOptions): Promise<number[][]> {
    if (input.length === 0) return [];
    const { model, dimension } = this.embeddingInfo();
    const out: number[][] = [];
    const batchSize = this.env.ANYMIZE_EMBEDDING_BATCH_SIZE;

    for (let i = 0; i < input.length; i += batchSize) {
      const batch = input.slice(i, i + batchSize);
      const res = await this.client.embeddings(
        {
          model,
          input: batch,
          // anymize/Voyage unterstützt getrennte Typen für Inhalte und Suchanfragen (bessere Treffer).
          input_type: options.inputType,
          // Dimension explizit anfordern, damit die Vektoren garantiert zur pgvector-Spalte passen.
          output_dimension: dimension,
        },
        { signal: options.signal },
      );
      const ordered = [...res.data].sort((a, b) => a.index - b.index);
      for (const item of ordered) {
        if (!Array.isArray(item.embedding) || item.embedding.length !== dimension) {
          throw new AIProviderError(
            "dimension_mismatch",
            `Embedding hat ${item.embedding?.length ?? "keine"} Dimensionen, erwartet ${dimension} (ANYMIZE_EMBEDDING_DIMENSION)`,
          );
        }
        out.push(item.embedding);
      }
    }
    return out;
  }

  embeddingInfo(): EmbeddingInfo {
    const model = this.env.ANYMIZE_EMBEDDING_MODEL;
    const dimension = this.env.ANYMIZE_EMBEDDING_DIMENSION;
    if (!model) throw new AIProviderError("missing_model", "ANYMIZE_EMBEDDING_MODEL ist nicht gesetzt");
    if (!dimension) throw new AIProviderError("not_configured", "ANYMIZE_EMBEDDING_DIMENSION ist nicht gesetzt");
    return { model, dimension };
  }

  private chatBody(request: ChatRequest): WireChatRequest {
    const model = this.env.ANYMIZE_CHAT_MODEL;
    if (!model) throw new AIProviderError("missing_model", "ANYMIZE_CHAT_MODEL ist nicht gesetzt");
    const wantsJson = request.responseFormat === "json_object" && this.env.ANYMIZE_JSON_MODE;
    return {
      model,
      messages: request.messages,
      temperature: request.temperature ?? this.env.ANYMIZE_CHAT_TEMPERATURE,
      max_tokens: request.maxTokens ?? this.env.ANYMIZE_CHAT_MAX_TOKENS,
      ...(wantsJson ? { response_format: { type: "json_object" as const } } : {}),
    };
  }
}
