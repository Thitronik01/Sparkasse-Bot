import type { Conflict, CorrectionHit, FactType, KnowledgeHit } from "./types";

/**
 * Deterministische Konflikterkennung – bewusst NICHT dem LLM überlassen.
 *
 * Heuristik: Aus jedem Treffer werden prüfbare Fakten extrahiert (Prozentsätze, Geldbeträge,
 * Uhrzeiten, Datumsangaben). Nennen zwei Treffer zum selben Fakttyp Werte, die sich nicht
 * überschneiden, gilt das als (möglicher) Widerspruch. Das erkennt nicht jeden inhaltlichen Konflikt,
 * erzeugt aber nachvollziehbare, erklärbare Befunde. Ergänzend meldet das Modell über
 * `unresolvedConflict`, wenn es selbst einen Widerspruch sieht – das fließt nur in Hinweise und
 * Confidence ein, entscheidet aber nichts.
 *
 * Auflösungsregeln (README „Korrektur-Priorität“):
 *   approved-Korrektur  vs. Quelle          → Korrektur gewinnt, Quelle wird aus dem Kontext genommen
 *   review/draft        vs. Quelle          → offizielle Quelle führt, Korrektur nur als Hinweis
 *   approved            vs. review/draft    → approved gewinnt
 *   sonst                                   → ungelöst, offen benennen
 */

export type Facts = Record<FactType, Set<string>>;

const pad = (n: string | number) => String(n).padStart(2, "0");

export function extractFacts(text: string): Facts {
  const facts: Facts = { percent: new Set(), money: new Set(), time: new Set(), date: new Set() };
  const t = text.toLowerCase();

  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s?(?:%|prozent\b)/g)) {
    facts.percent.add(String(Number(m[1].replace(",", "."))));
  }

  const addMoney = (intPart: string, dec?: string) => {
    const cents = dec && /^\d+$/.test(dec) ? dec.padEnd(2, "0") : "00";
    facts.money.add(`${Number(intPart.replace(/\./g, ""))}.${cents}`);
  };
  for (const m of t.matchAll(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}|-{1,2}))?\s?(?:€|eur\b|euro\b)/g)) addMoney(m[1], m[2]);
  for (const m of t.matchAll(/(?:€|eur\b)\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}|-{1,2}))?/g)) addMoney(m[1], m[2]);

  // Lookbehind verhindert Teiltreffer wie „00 Uhr“ aus „10:00 Uhr“.
  for (const m of t.matchAll(/(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)\b/g)) facts.time.add(`${pad(m[1])}:${m[2]}`);
  for (const m of t.matchAll(/(?<![\d:.])([01]?\d|2[0-3])\.([0-5]\d)\s?uhr\b/g)) facts.time.add(`${pad(m[1])}:${m[2]}`);
  for (const m of t.matchAll(/(?<![\d:.])([01]?\d|2[0-3])\s?uhr\b/g)) facts.time.add(`${pad(m[1])}:00`);

  for (const m of t.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/g)) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    facts.date.add(`${year}-${pad(m[2])}-${pad(m[1])}`);
  }
  return facts;
}

const FACT_TYPES: FactType[] = ["percent", "money", "time", "date"];

/** Erster Fakttyp, zu dem beide Texte Werte nennen, die sich nicht überschneiden. */
export function contradictingFact(a: Facts, b: Facts): FactType | undefined {
  for (const type of FACT_TYPES) {
    if (a[type].size === 0 || b[type].size === 0) continue;
    const overlap = [...a[type]].some((v) => b[type].has(v));
    if (!overlap) return type;
  }
  return undefined;
}

export type ConflictAnalysis = {
  conflicts: Conflict[];
  /** Wissens-Chunks, die durch eine freigegebene Korrektur überholt sind und nicht in den Kontext gehen. */
  overriddenChunkIds: Set<string>;
};

export function detectConflicts(
  corrections: CorrectionHit[],
  knowledge: KnowledgeHit[],
  opts: { knowledgePairsTopN?: number } = {},
): ConflictAnalysis {
  const conflicts: Conflict[] = [];
  const overriddenChunkIds = new Set<string>();
  const cFacts = new Map(corrections.map((c) => [c.correctionId, extractFacts(c.correctedContent)]));
  const kFacts = new Map(knowledge.map((k) => [k.chunkId, extractFacts(k.content)]));

  // Korrektur vs. Wissen
  for (const c of corrections) {
    for (const k of knowledge) {
      const factType = contradictingFact(cFacts.get(c.correctionId)!, kFacts.get(k.chunkId)!);
      if (!factType) continue;
      if (c.status === "approved") {
        overriddenChunkIds.add(k.chunkId);
        conflicts.push({ kind: "correction_vs_knowledge", refs: [c.correctionId, k.chunkId], factType, resolution: "correction_overrides", winnerRef: c.correctionId });
      } else {
        conflicts.push({ kind: "correction_vs_knowledge", refs: [c.correctionId, k.chunkId], factType, resolution: "official_source_preferred", winnerRef: k.chunkId });
      }
    }
  }

  // Korrektur vs. Korrektur
  for (let i = 0; i < corrections.length; i++) {
    for (let j = i + 1; j < corrections.length; j++) {
      const a = corrections[i];
      const b = corrections[j];
      const factType = contradictingFact(cFacts.get(a.correctionId)!, cFacts.get(b.correctionId)!);
      if (!factType) continue;
      const approved = [a, b].filter((x) => x.status === "approved");
      if (approved.length === 1) {
        conflicts.push({ kind: "correction_vs_correction", refs: [a.correctionId, b.correctionId], factType, resolution: "correction_overrides", winnerRef: approved[0].correctionId });
      } else {
        conflicts.push({ kind: "correction_vs_correction", refs: [a.correctionId, b.correctionId], factType, resolution: "unresolved" });
      }
    }
  }

  // Wissen vs. Wissen: nur die stärksten Treffer aus verschiedenen Quellen, um Rauschen zu begrenzen
  // (verschiedene Produktseiten nennen legitimerweise verschiedene Preise).
  const topN = opts.knowledgePairsTopN ?? 3;
  const candidates: KnowledgeHit[] = [];
  for (const k of knowledge) {
    if (overriddenChunkIds.has(k.chunkId) || candidates.some((c) => c.sourceId === k.sourceId)) continue;
    candidates.push(k);
    if (candidates.length >= topN) break;
  }
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const factType = contradictingFact(kFacts.get(candidates[i].chunkId)!, kFacts.get(candidates[j].chunkId)!);
      if (factType) {
        conflicts.push({ kind: "knowledge_vs_knowledge", refs: [candidates[i].chunkId, candidates[j].chunkId], factType, resolution: "unresolved" });
      }
    }
  }

  return { conflicts, overriddenChunkIds };
}
