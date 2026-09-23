import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProvider } from "../ai/provider";
import { log } from "../log";

/**
 * Webseite/Upload → Chunks → Embeddings (input_type "document") → pgvector.
 * Unveränderte Quellen (gleiche Checksumme, gleiches Embedding-Modell) werden übersprungen.
 */

export type IngestInput = {
  sourceType: "web" | "upload";
  title: string;
  url?: string;
  text: string;
  fetchedAt: Date;
};

export type IngestResult = { sourceId: string; chunks: number; skipped: boolean };

/** Absatzbasiertes Chunking mit Überlappung; Absätze über `maxChars` werden an Satzgrenzen geteilt. */
export function chunkText(text: string, opts: { maxChars?: number; overlapChars?: number } = {}): string[] {
  const maxChars = opts.maxChars ?? 1200;
  const overlap = opts.overlapChars ?? 150;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      pieces.push(p);
      continue;
    }
    let current = "";
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (current && current.length + sentence.length + 1 > maxChars) {
        pieces.push(current);
        current = "";
      }
      // Einzelne überlange „Sätze“ hart teilen
      for (let i = 0; i < sentence.length; i += maxChars) {
        const part = sentence.slice(i, i + maxChars);
        current = current ? `${current} ${part}` : part;
        if (current.length >= maxChars) {
          pieces.push(current);
          current = "";
        }
      }
    }
    if (current) pieces.push(current);
  }

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > maxChars) {
      chunks.push(current);
      const tail = current.slice(-overlap);
      current = overlap > 0 ? `${tail.slice(tail.indexOf(" ") + 1)}\n\n${piece}` : piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function ingestSource(db: SupabaseClient, provider: AIProvider, input: IngestInput): Promise<IngestResult> {
  const { model } = provider.embeddingInfo();
  const checksum = createHash("sha256").update(input.text).digest("hex");

  const existing = input.url
    ? await db.from("knowledge_sources").select("id, checksum").eq("source_type", input.sourceType).eq("url", input.url).maybeSingle()
    : { data: null, error: null };
  if (existing.error) throw new Error(`knowledge_sources lesen: ${existing.error.message}`);

  if (existing.data && existing.data.checksum === checksum) {
    const { count } = await db
      .from("knowledge_chunks")
      .select("id", { count: "exact", head: true })
      .eq("source_id", existing.data.id)
      .eq("embedding_model", model);
    if ((count ?? 0) > 0) {
      await db.from("knowledge_sources").update({ fetched_at: input.fetchedAt.toISOString() }).eq("id", existing.data.id);
      return { sourceId: existing.data.id, chunks: count ?? 0, skipped: true };
    }
  }

  const chunks = chunkText(input.text);
  // Embeddings zuerst berechnen – schlägt das fehl, bleibt der alte Stand in der DB unverändert.
  const embeddings = await provider.embed(chunks, { inputType: "document" });

  const row = {
    source_type: input.sourceType,
    title: input.title,
    url: input.url ?? null,
    checksum,
    fetched_at: input.fetchedAt.toISOString(),
    updated_at: new Date().toISOString(),
  };
  let sourceId: string;
  if (existing.data) {
    sourceId = existing.data.id;
    const upd = await db.from("knowledge_sources").update(row).eq("id", sourceId);
    if (upd.error) throw new Error(`knowledge_sources aktualisieren: ${upd.error.message}`);
    const del = await db.from("knowledge_chunks").delete().eq("source_id", sourceId);
    if (del.error) throw new Error(`alte Chunks löschen: ${del.error.message}`);
  } else {
    const ins = await db.from("knowledge_sources").insert(row).select("id").single();
    if (ins.error) throw new Error(`knowledge_sources anlegen: ${ins.error.message}`);
    sourceId = ins.data.id;
  }

  const rows = chunks.map((content, i) => ({
    source_id: sourceId,
    content,
    chunk_index: i,
    embedding: embeddings[i],
    embedding_model: model,
    metadata: { chars: content.length },
  }));
  for (let i = 0; i < rows.length; i += 100) {
    const res = await db.from("knowledge_chunks").insert(rows.slice(i, i + 100));
    if (res.error) throw new Error(`Chunks speichern: ${res.error.message}`);
  }

  log.info("ingest.source", { source_type: input.sourceType, chunks: chunks.length, embedding_model: model });
  return { sourceId, chunks: chunks.length, skipped: false };
}
