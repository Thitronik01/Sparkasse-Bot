import type { ChatRequest, ChatResponse, ChatStreamEvent, EmbedOptions, EmbeddingInfo } from "./types";

/**
 * Einzige Schnittstelle, über die RAG-Pipeline, Correction Layer und UI mit einem LLM sprechen.
 * Kein Code außerhalb von lib/ai darf die anymize API direkt aufrufen.
 */
export interface AIProvider {
  readonly name: string;

  chat(request: ChatRequest): Promise<ChatResponse>;

  /** Streaming-Variante (SSE beim Provider). Liefert Text-Deltas und abschließend ein done-Event. */
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;

  /** Liefert einen Vektor je Eingabetext, in derselben Reihenfolge. */
  embed(input: string[], options: EmbedOptions): Promise<number[][]>;

  /** Modell + Dimension, die mit den Vektoren gespeichert werden. */
  embeddingInfo(): EmbeddingInfo;
}

export type { ChatMessage, ChatRequest, ChatResponse, ChatStreamEvent, EmbedOptions, EmbeddingInfo } from "./types";
