import type { AIProvider } from "../ai/provider";
import { AIProviderError } from "../ai/errors";
import { computeConfidence } from "../confidence/score";
import { log } from "../log";
import type { BotAnswer, Notice, Source } from "../types/knowledge";
import { parseGeneratedAnswer, parseStreamedAnswer, type ParsedAnswer } from "./answer-parser";
import { detectConflicts } from "./conflicts";
import { buildContext, type BuiltContext, type GenerationMode } from "./context-builder";
import { rankCorrections, rankKnowledge } from "./ranking";
import type { Conflict, ContextSource } from "./types";
import type { VectorStore } from "./vector-store";

/**
 * RAG-Ablauf:
 *   Frage → Query-Embedding → Correction Retrieval + Knowledge Retrieval → Ranking
 *   → Konflikterkennung → Context Builder → AIProvider.chat → strukturierte Antwort
 *   → Confidence Engine → BotAnswer
 *
 * Quellenauswahl, Korrekturvorrang, Konflikte und Confidence entscheidet dieser Code – nicht das LLM.
 * Der Ablauf ist in prepare/finalize geteilt, damit Streaming dieselbe Logik nutzt.
 */

export type RagConfig = {
  topK: number;
  minSimilarity: number;
  maxChunksPerSource: number;
  maxContextChars: number;
  correctionTopK: number;
  correctionMinSimilarity: number;
};

export type PipelineDeps = {
  provider: AIProvider;
  store: VectorStore;
  config: RagConfig;
  now?: () => Date;
};

export type PreparedAnswer = {
  kind: "prepared";
  question: string;
  context: BuiltContext;
  conflicts: Conflict[];
  overriddenCount: number;
};

export type EarlyAnswer = { kind: "early"; answer: BotAnswer };

export const NO_RESULTS_ANSWER =
  "Dazu habe ich in der Wissensbasis keine ausreichend passenden Informationen gefunden. Bitte formuliere die Frage anders oder wende dich an die zuständige Fachabteilung.";

export async function prepareAnswer(question: string, mode: GenerationMode, deps: PipelineDeps, signal?: AbortSignal): Promise<PreparedAnswer | EarlyAnswer> {
  const { provider, store, config } = deps;
  const now = deps.now?.() ?? new Date();
  const started = Date.now();

  const { model } = provider.embeddingInfo();
  let queryEmbedding: number[];
  try {
    [queryEmbedding] = await provider.embed([question], { inputType: "query", signal });
  } catch (e) {
    if (e instanceof AIProviderError && ["invalid_response", "bad_request", "server_error"].includes(e.code)) {
      throw new AIProviderError("embedding_error", e.message, { cause: e, status: e.status });
    }
    throw e;
  }

  const [correctionHits, knowledgeHits] = await Promise.all([
    config.correctionTopK > 0
      ? store.searchCorrections(queryEmbedding, { model, topK: config.correctionTopK, minSimilarity: config.correctionMinSimilarity })
      : Promise.resolve([]),
    store.searchKnowledge(queryEmbedding, { model, topK: config.topK, minSimilarity: config.minSimilarity }),
  ]);

  const corrections = rankCorrections(correctionHits);
  const ranked = rankKnowledge(knowledgeHits, { maxPerSource: config.maxChunksPerSource, now });
  const { conflicts, overriddenChunkIds } = detectConflicts(corrections, ranked);
  const knowledge = ranked.filter((k) => !overriddenChunkIds.has(k.chunkId));

  log.info("rag.retrieval", {
    corrections: corrections.length,
    knowledge_hits: knowledgeHits.length,
    knowledge_used: knowledge.length,
    overridden: overriddenChunkIds.size,
    conflicts: conflicts.length,
    duration_ms: Date.now() - started,
  });

  if (corrections.length === 0 && knowledge.length === 0) {
    return {
      kind: "early",
      answer: {
        answer: NO_RESULTS_ANSWER,
        confidence: { score: 0, label: "low", reasons: ["Keine passenden Quellen in der Wissensbasis gefunden."] },
        sources: [],
        notices: [{ type: "no_results", severity: "warning", message: "Keine passenden Quellen gefunden – es wurde keine KI-Antwort erzeugt." }],
      },
    };
  }

  const context = buildContext({ question, corrections, knowledge, conflicts, mode, maxChars: config.maxContextChars });
  return { kind: "prepared", question, context, conflicts, overriddenCount: overriddenChunkIds.size };
}

/** Kombiniert Modellantwort und Backend-Evidenz zur finalen Antwort inkl. Quellen, Hinweisen und Confidence. */
export function finalizeAnswer(prepared: PreparedAnswer, parsed: ParsedAnswer, deps: Pick<PipelineDeps, "provider" | "config" | "now">): BotAnswer {
  const now = deps.now?.() ?? new Date();
  const { context, conflicts } = prepared;
  const citedIds = new Set(parsed.citedSourceIds);

  const confidence = computeConfidence({
    sources: context.sources,
    citedIds,
    conflicts,
    idByRef: context.idByRef,
    modelReportedConflict: parsed.unresolvedConflict,
    usedFallback: parsed.usedFallback,
    minSimilarity: deps.config.minSimilarity,
    now,
  });

  const sources = context.sources.map((s) => toSource(s, citedIds.has(s.id))).sort((a, b) => Number(b.cited) - Number(a.cited));
  const notices = buildNotices(prepared, citedIds, parsed, confidence.label, deps.provider.name);

  if (parsed.unknownCitations.length > 0) {
    log.warn("rag.unknown_citations", { count: parsed.unknownCitations.length });
  }
  return { answer: parsed.answer, confidence, sources, notices };
}

/** Nicht-streamender Standardablauf (erster Vertical Slice). */
export async function answerQuestion(question: string, deps: PipelineDeps, signal?: AbortSignal): Promise<BotAnswer> {
  const prepared = await prepareAnswer(question, "json", deps, signal);
  if (prepared.kind === "early") return prepared.answer;

  const res = await deps.provider.chat({ messages: prepared.context.messages, responseFormat: "json_object", signal });
  const validIds = new Set(prepared.context.sources.map((s) => s.id));
  const parsed = parseGeneratedAnswer(res.content, validIds);
  if (parsed.usedFallback) log.warn("rag.answer_fallback_parse", { finish_reason: res.finishReason });
  return finalizeAnswer(prepared, parsed, deps);
}

export function finalizeStreamedAnswer(prepared: PreparedAnswer, fullText: string, deps: Pick<PipelineDeps, "provider" | "config" | "now">): BotAnswer {
  const validIds = new Set(prepared.context.sources.map((s) => s.id));
  return finalizeAnswer(prepared, parseStreamedAnswer(fullText, validIds), deps);
}

/** Quellen und Hinweise, die schon vor der Generierung feststehen (für Streaming-UI). */
export function previewSources(prepared: PreparedAnswer): Source[] {
  return prepared.context.sources.map((s) => toSource(s, false));
}

// ---------------------------------------------------------------------------

function toSource(s: ContextSource, cited: boolean): Source {
  if (s.kind === "correction") {
    return {
      id: s.id,
      title: s.title,
      url: s.sourceUrl,
      sourceType: "correction",
      correctionStatus: s.status,
      asOf: s.updatedAt,
      similarity: round(s.similarity),
      cited,
      excerpt: excerpt(s.correctedContent),
    };
  }
  return {
    id: s.id,
    title: s.title,
    url: s.url,
    sourceType: s.sourceType,
    asOf: s.fetchedAt,
    similarity: round(s.similarity),
    cited,
    excerpt: excerpt(s.content),
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const excerpt = (t: string) => (t.length > 300 ? `${t.slice(0, 297).trimEnd()}…` : t);

function buildNotices(prepared: PreparedAnswer, citedIds: Set<string>, parsed: ParsedAnswer, label: string, providerName: string): Notice[] {
  const notices: Notice[] = [];
  const { sources, idByRef } = prepared.context;
  const corrections = sources.filter((s): s is ContextSource & { kind: "correction" } => s.kind === "correction");

  const byStatus = (status: "approved" | "review" | "draft") =>
    corrections.filter((c) => c.status === status && citedIds.has(c.id)).map((c) => c.id);
  const approved = byStatus("approved");
  const review = byStatus("review");
  const draft = byStatus("draft");

  if (approved.length) {
    notices.push({ type: "correction_approved", severity: "info", message: "Redaktionell freigegebene Korrektur berücksichtigt.", sourceIds: approved });
  }
  if (review.length) {
    notices.push({ type: "correction_review", severity: "warning", message: "Information in Prüfung – noch nicht redaktionell freigegeben.", sourceIds: review });
  }
  if (draft.length) {
    notices.push({ type: "correction_draft", severity: "warning", message: "Entwurf / möglicherweise im Wandel – nicht als bestätigte Information weitergeben.", sourceIds: draft });
  }
  if (prepared.overriddenCount > 0) {
    notices.push({
      type: "overridden_source",
      severity: "info",
      message: `${prepared.overriddenCount} Textstelle(n) aus Web-/Dokumentquellen wurden durch eine freigegebene Korrektur ersetzt und nicht verwendet.`,
    });
  }

  for (const c of prepared.conflicts) {
    const ids = c.refs.map((r) => idByRef.get(r)).filter((x): x is string => Boolean(x));
    if (ids.length < 2) continue;
    if (c.resolution === "unresolved") {
      notices.push({ type: "conflict", severity: "warning", message: "Die Quellen enthalten widersprüchliche Angaben. Bitte vor Weitergabe prüfen.", sourceIds: ids });
    } else if (c.resolution === "official_source_preferred") {
      notices.push({ type: "conflict", severity: "warning", message: "Eine noch nicht freigegebene Korrektur weicht von der offiziellen Quelle ab. Maßgeblich ist vorerst die offizielle Quelle.", sourceIds: ids });
    }
  }
  if (parsed.unresolvedConflict && !notices.some((n) => n.type === "conflict")) {
    notices.push({ type: "conflict", severity: "warning", message: "Bei der Antworterstellung wurden widersprüchliche Angaben in den Quellen festgestellt." });
  }

  if (citedIds.size === 0) {
    notices.push({ type: "uncited_answer", severity: "warning", message: "Die Antwort verweist auf keine konkrete Quelle." });
  }
  if (label === "low") {
    notices.push({ type: "low_confidence", severity: "warning", message: "Geringe Evidenz – Angaben bitte vor Weitergabe an Kundinnen und Kunden prüfen." });
  }
  if (providerName === "mock") {
    notices.push({ type: "mock_provider", severity: "info", message: "Technischer Testmodus (Mock-Provider): Die Antwort ist keine fachliche Aussage." });
  }
  return mergeNotices(notices);
}

/** Fasst gleichlautende Hinweise zusammen (z. B. mehrere Konfliktpaare) und vereinigt ihre Quellen-IDs. */
function mergeNotices(notices: Notice[]): Notice[] {
  const byKey = new Map<string, Notice>();
  for (const n of notices) {
    const key = `${n.type}|${n.message}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { ...n, sourceIds: n.sourceIds && [...n.sourceIds] });
    else if (n.sourceIds) existing.sourceIds = [...new Set([...(existing.sourceIds ?? []), ...n.sourceIds])];
  }
  return [...byKey.values()];
}
