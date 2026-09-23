import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProvider } from "../ai/provider";
import { log } from "../log";

/**
 * Correction → Embedding → pgvector.
 *
 * Eingebettet wird „Betrifft“ (trigger_text) plus korrigierter Inhalt, damit eine Korrektur sowohl
 * über die ursprüngliche Fragestellung als auch über den neuen Inhalt gefunden wird.
 * Nach jeder inhaltlichen Änderung einer Korrektur muss das Embedding neu berechnet werden.
 */
export function correctionEmbeddingText(c: { title: string; trigger_text: string; corrected_content: string }): string {
  return `${c.title}\n${c.trigger_text}\n${c.corrected_content}`;
}

type CorrectionRow = { id: string; title: string; trigger_text: string; corrected_content: string };

/** Berechnet Embeddings für alle Korrekturen ohne Embedding oder mit Embedding eines anderen Modells. */
export async function embedPendingCorrections(db: SupabaseClient, provider: AIProvider, opts: { all?: boolean } = {}): Promise<number> {
  const { model } = provider.embeddingInfo();
  let query = db.from("corrections").select("id, title, trigger_text, corrected_content").in("status", ["draft", "review", "approved"]);
  if (!opts.all) query = query.or(`embedding.is.null,embedding_model.is.null,embedding_model.neq."${model}"`);
  const { data, error } = await query;
  if (error) throw new Error(`corrections lesen: ${error.message}`);

  const rows = (data ?? []) as CorrectionRow[];
  if (rows.length === 0) return 0;
  const embeddings = await provider.embed(rows.map(correctionEmbeddingText), { inputType: "document" });

  for (let i = 0; i < rows.length; i++) {
    const res = await db.from("corrections").update({ embedding: embeddings[i], embedding_model: model }).eq("id", rows[i].id);
    if (res.error) throw new Error(`Korrektur-Embedding speichern: ${res.error.message}`);
  }
  log.info("corrections.embedded", { count: rows.length, embedding_model: model });
  return rows.length;
}
