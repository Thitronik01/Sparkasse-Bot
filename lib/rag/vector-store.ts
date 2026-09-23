import type { SupabaseClient } from "@supabase/supabase-js";
import { RetrievalError } from "./errors";
import type { CorrectionHit, KnowledgeHit, RetrievalOptions } from "./types";
import { getSupabaseAdmin } from "../db/supabase-server";

/** Abstraktion über die Vektorsuche, damit die Pipeline ohne Datenbank testbar bleibt. */
export interface VectorStore {
  searchKnowledge(embedding: number[], opts: RetrievalOptions): Promise<KnowledgeHit[]>;
  searchCorrections(embedding: number[], opts: RetrievalOptions): Promise<CorrectionHit[]>;
}

type KnowledgeRow = {
  chunk_id: string;
  source_id: string;
  content: string;
  chunk_index: number;
  similarity: number;
  source_type: "web" | "upload";
  source_title: string;
  source_url: string | null;
  fetched_at: string | null;
};

type CorrectionRow = {
  correction_id: string;
  title: string;
  trigger_text: string;
  corrected_content: string;
  rationale: string | null;
  source_url: string | null;
  status: "approved" | "review" | "draft";
  valid_from: string | null;
  valid_until: string | null;
  updated_at: string | null;
  similarity: number;
};

/** pgvector-Suche über die RPC-Funktionen aus supabase/migrations/002_vector_search.sql. */
export class SupabaseVectorStore implements VectorStore {
  constructor(private readonly db: SupabaseClient = getSupabaseAdmin()) {}

  async searchKnowledge(embedding: number[], opts: RetrievalOptions): Promise<KnowledgeHit[]> {
    const { data, error } = await this.db.rpc("match_knowledge_chunks", {
      query_embedding: embedding,
      p_embedding_model: opts.model,
      match_count: opts.topK,
      min_similarity: opts.minSimilarity,
    });
    if (error) throw new RetrievalError("store_error", `match_knowledge_chunks: ${error.code ?? ""} ${error.message}`);
    return ((data ?? []) as KnowledgeRow[]).map((r) => ({
      kind: "knowledge",
      chunkId: r.chunk_id,
      sourceId: r.source_id,
      content: r.content,
      chunkIndex: r.chunk_index,
      similarity: r.similarity,
      sourceType: r.source_type,
      title: r.source_title,
      url: r.source_url ?? undefined,
      fetchedAt: r.fetched_at ?? undefined,
    }));
  }

  async searchCorrections(embedding: number[], opts: RetrievalOptions): Promise<CorrectionHit[]> {
    const { data, error } = await this.db.rpc("match_corrections", {
      query_embedding: embedding,
      p_embedding_model: opts.model,
      match_count: opts.topK,
      min_similarity: opts.minSimilarity,
    });
    if (error) throw new RetrievalError("store_error", `match_corrections: ${error.code ?? ""} ${error.message}`);
    return ((data ?? []) as CorrectionRow[]).map((r) => ({
      kind: "correction",
      correctionId: r.correction_id,
      title: r.title,
      triggerText: r.trigger_text,
      correctedContent: r.corrected_content,
      rationale: r.rationale ?? undefined,
      sourceUrl: r.source_url ?? undefined,
      status: r.status,
      validFrom: r.valid_from ?? undefined,
      validUntil: r.valid_until ?? undefined,
      updatedAt: r.updated_at ?? undefined,
      similarity: r.similarity,
    }));
  }
}
