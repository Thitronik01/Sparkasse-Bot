export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = { role: ChatRole; content: string };

export type ChatRequest = {
  messages: ChatMessage[];
  /** Überschreibt ANYMIZE_CHAT_TEMPERATURE (Standard 0.1 für RAG). */
  temperature?: number;
  maxTokens?: number;
  /** "json_object" fordert strukturiertes JSON an (OpenAI-kompatibles response_format). */
  responseFormat?: "text" | "json_object";
  signal?: AbortSignal;
};

export type TokenUsage = { promptTokens?: number; completionTokens?: number; totalTokens?: number };

export type ChatResponse = {
  content: string;
  model: string;
  finishReason?: string;
  usage?: TokenUsage;
  /** true, wenn der Request über den anonymisierenden Endpunkt lief. */
  anonymized: boolean;
};

export type ChatStreamEvent =
  | { type: "delta"; content: string }
  | { type: "done"; finishReason?: string; usage?: TokenUsage };

/** "document" für Inhalte, die durchsuchbar gemacht werden; "query" für Suchanfragen. */
export type EmbeddingInputType = "document" | "query";

export type EmbedOptions = { inputType: EmbeddingInputType; signal?: AbortSignal };

export type EmbeddingInfo = {
  /** Wird zusammen mit jedem Vektor gespeichert, damit keine Vektoren verschiedener Modelle gemischt werden. */
  model: string;
  dimension: number;
};
