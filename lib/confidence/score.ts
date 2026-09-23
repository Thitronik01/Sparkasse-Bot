import { freshness } from "../rag/ranking";
import type { Conflict, ContextSource } from "../rag/types";
import type { BotAnswer, ConfidenceLabel } from "../types/knowledge";

/**
 * Erklärbarer Evidenz-Score (0–100) – ausdrücklich KEINE vom Modell behauptete Wahrscheinlichkeit.
 *
 * Basis (gewichtet):
 *   55 %  Retrieval-Similarity der zitierten Quellen (beste Quelle)
 *   25 %  Anzahl unabhängiger zitierter Quellen (3+ = voll)
 *   20 %  Aktualität der zitierten Quellen
 * Zu- und Abschläge:
 *   +8  freigegebene Korrektur zitiert       −12 Korrektur „in Prüfung“ zitiert   −22 Entwurf zitiert
 *   −25 ungelöster Widerspruch (Backend)      −8  abweichende Korrektur in Prüfung/Entwurf
 *   −15 Modell meldet Widerspruch, den das Backend nicht erkannt hat
 *   −20 Antwort zitiert keine Quelle          −5  Modellantwort nicht im erwarteten Format
 */

export type ConfidenceInput = {
  sources: ContextSource[];
  citedIds: Set<string>;
  conflicts: Conflict[];
  idByRef: Map<string, string>;
  modelReportedConflict: boolean;
  usedFallback: boolean;
  minSimilarity: number;
  now: Date;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function labelFor(score: number): ConfidenceLabel {
  if (score >= 75) return "high";
  if (score >= 45) return "medium";
  return "low";
}

export function computeConfidence(x: ConfidenceInput): BotAnswer["confidence"] {
  const reasons: string[] = [];
  if (x.sources.length === 0) {
    return { score: 0, label: "low", reasons: ["Keine passenden Quellen in der Wissensbasis gefunden."] };
  }

  const cited = x.sources.filter((s) => x.citedIds.has(s.id));
  const basis = cited.length > 0 ? cited : x.sources;
  let s = 0;

  // Similarity: RAG_MIN_SIMILARITY → 0, 0.9 → 1
  const best = Math.max(...basis.map((b) => b.similarity));
  const simNorm = clamp01((best - x.minSimilarity) / Math.max(0.05, 0.9 - x.minSimilarity));
  s += simNorm * 0.55;
  reasons.push(
    simNorm >= 0.66
      ? "Die Quellen passen sehr gut zur Frage."
      : simNorm >= 0.33
        ? "Die Quellen passen teilweise zur Frage."
        : "Die Quellen passen nur schwach zur Frage.",
  );

  // Unabhängige Quellen (Chunks derselben Seite zählen einmal)
  const independent = new Set(basis.map((b) => (b.kind === "knowledge" ? `src:${b.sourceId}` : `cor:${b.correctionId}`))).size;
  s += Math.min(1, independent / 3) * 0.25;
  reasons.push(independent === 1 ? "Die Antwort stützt sich auf eine Quelle." : `Die Antwort stützt sich auf ${independent} unabhängige Quellen.`);

  // Aktualität
  const fresh = basis.reduce((sum, b) => sum + freshness(b.kind === "knowledge" ? b.fetchedAt : b.updatedAt, x.now), 0) / basis.length;
  s += fresh * 0.2;
  if (fresh < 0.6) reasons.push("Ein Teil der Quellen ist älter oder ohne Datumsangabe.");

  // Korrekturstatus
  const citedCorrections = cited.filter((c) => c.kind === "correction");
  if (citedCorrections.some((c) => c.kind === "correction" && c.status === "approved")) {
    s += 0.08;
    reasons.push("Eine redaktionell freigegebene Korrektur wurde berücksichtigt.");
  }
  if (citedCorrections.some((c) => c.kind === "correction" && c.status === "review")) {
    s -= 0.12;
    reasons.push("Die Antwort enthält Informationen, die noch in Prüfung sind.");
  }
  if (citedCorrections.some((c) => c.kind === "correction" && c.status === "draft")) {
    s -= 0.22;
    reasons.push("Die Antwort enthält Informationen aus einem Korrektur-Entwurf.");
  }

  // Konflikte: nur solche, deren beide Seiten im Kontext sind, zählen voll
  const visible = x.conflicts.filter((c) => x.idByRef.has(c.refs[0]) && x.idByRef.has(c.refs[1]));
  if (visible.some((c) => c.resolution === "unresolved")) {
    s -= 0.25;
    reasons.push("Die Quellen widersprechen sich in mindestens einem Punkt.");
  } else if (visible.some((c) => c.resolution === "official_source_preferred")) {
    s -= 0.08;
    reasons.push("Eine noch nicht freigegebene Korrektur weicht von der offiziellen Quelle ab.");
  }
  if (x.modelReportedConflict && !visible.some((c) => c.resolution === "unresolved")) {
    s -= 0.15;
    reasons.push("Bei der Antworterstellung wurde ein Widerspruch in den Quellen festgestellt.");
  }

  if (cited.length === 0) {
    s -= 0.2;
    reasons.push("Die Antwort verweist auf keine konkrete Quelle.");
  }
  if (x.usedFallback) {
    s -= 0.05;
    reasons.push("Die Modellantwort hatte nicht das erwartete Format.");
  }

  const score = Math.round(clamp01(s) * 100);
  return { score, label: labelFor(score), reasons };
}
