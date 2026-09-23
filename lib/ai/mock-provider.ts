import type { AIProvider } from "./provider";
import type { ChatRequest, ChatResponse, ChatStreamEvent, EmbedOptions, EmbeddingInfo } from "./types";
import { getServerEnv } from "../config/server-env";

/**
 * Technischer Test-Provider (AI_PROVIDER=mock).
 *
 * - Erfindet KEINE fachlichen Sparkasseninformationen: Chat-Antworten sind ausdrücklich als
 *   technische Testantwort markiert und nennen nur, welche Quellen-IDs übergeben wurden.
 * - Embeddings sind deterministische Hash-Vektoren (Feature Hashing über Wörter und Trigramme).
 *   Dadurch funktioniert Similarity Search grob wortbasiert – ausreichend, um Crawler, Upload,
 *   Retrieval, Corrections, Quellen, Confidence und UI ohne API-Key zu testen.
 *   Mock-Vektoren werden mit embedding_model="mock-hash-v1" gespeichert und nie mit echten gemischt.
 */
export const MOCK_EMBEDDING_MODEL = "mock-hash-v1";

export class MockAIProvider implements AIProvider {
  readonly name = "mock";
  private readonly dimension: number;

  constructor(opts: { dimension?: number } = {}) {
    if (opts.dimension) {
      this.dimension = opts.dimension;
    } else {
      const env = getServerEnv();
      // Gleiche Dimension wie die DB-Spalte, damit Mock-Vektoren gespeichert werden können.
      this.dimension = env.ANYMIZE_EMBEDDING_DIMENSION ?? env.MOCK_EMBEDDING_DIMENSION;
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const content = this.buildContent(request);
    return { content, model: "mock", finishReason: "stop", anonymized: false };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const content = this.buildContent({ ...request, responseFormat: "text" });
    for (const part of content.match(/.{1,24}/gs) ?? []) {
      yield { type: "delta", content: part };
    }
    yield { type: "done", finishReason: "stop" };
  }

  async embed(input: string[], _options: EmbedOptions): Promise<number[][]> {
    return input.map((text) => hashEmbedding(text, this.dimension));
  }

  embeddingInfo(): EmbeddingInfo {
    return { model: MOCK_EMBEDDING_MODEL, dimension: this.dimension };
  }

  private buildContent(request: ChatRequest): string {
    const allText = request.messages.map((m) => m.content).join("\n");
    const ids = [...new Set([...allText.matchAll(/<quelle id="([A-Z]\d+)"/g)].map((m) => m[1]))];
    const answer =
      ids.length > 0
        ? `[MOCK] Technische Testantwort – keine fachliche Aussage. Dem Modell wurden ${ids.length} Kontextquelle(n) übergeben: ${ids
            .map((id) => `[${id}]`)
            .join(", ")}.`
        : "[MOCK] Technische Testantwort – keine fachliche Aussage. Es wurde kein Kontext übergeben.";

    if (request.responseFormat === "json_object") {
      return JSON.stringify({ answer, citedSourceIds: ids, unresolvedConflict: false });
    }
    return answer;
  }
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9 ]+/g, " ");
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashEmbedding(text: string, dimension: number): number[] {
  const v = new Array<number>(dimension).fill(0);
  const words = normalize(text).split(/\s+/).filter((w) => w.length >= 3);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    v[h % dimension] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  for (const w of words) {
    add(`w:${w}`, 1);
    for (let i = 0; i + 3 <= w.length; i++) add(`t:${w.slice(i, i + 3)}`, 0.3);
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}
