import { getAIProvider } from "../ai/provider-factory";
import { getServerEnv } from "../config/server-env";
import type { PipelineDeps, RagConfig } from "./pipeline";
import { SupabaseVectorStore, type VectorStore } from "./vector-store";

let store: VectorStore | undefined;

export function getRagConfig(): RagConfig {
  const env = getServerEnv();
  return {
    topK: env.RAG_TOP_K,
    minSimilarity: env.RAG_MIN_SIMILARITY,
    maxChunksPerSource: env.RAG_MAX_CHUNKS_PER_SOURCE,
    maxContextChars: env.RAG_MAX_CONTEXT_CHARS,
    correctionTopK: env.CORRECTION_TOP_K,
    correctionMinSimilarity: env.CORRECTION_MIN_SIMILARITY,
  };
}

/** Produktive Verdrahtung: konfigurierter AIProvider + Supabase/pgvector. */
export function getPipelineDeps(): PipelineDeps {
  store ??= new SupabaseVectorStore();
  return { provider: getAIProvider(), store, config: getRagConfig() };
}
