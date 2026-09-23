import type { CorrectionHit, KnowledgeHit } from "./types";

const DAY_MS = 86_400_000;

/** 1.0 bis 30 Tage alt, danach linear fallend bis 0.3 nach einem Jahr; unbekannt = 0.5. */
export function freshness(iso: string | undefined, now: Date): number {
  if (!iso) return 0.5;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0.5;
  const ageDays = Math.max(0, (now.getTime() - t) / DAY_MS);
  if (ageDays <= 30) return 1;
  if (ageDays >= 365) return 0.3;
  return 1 - ((ageDays - 30) / 335) * 0.7;
}

/**
 * Sortiert Wissens-Treffer nach Similarity (bei Gleichstand: aktueller zuerst)
 * und begrenzt die Anzahl Chunks je Quelle, damit eine einzelne Seite nicht den Kontext dominiert.
 */
export function rankKnowledge(hits: KnowledgeHit[], opts: { maxPerSource: number; now: Date }): KnowledgeHit[] {
  const sorted = [...hits].sort(
    (a, b) => b.similarity - a.similarity || freshness(b.fetchedAt, opts.now) - freshness(a.fetchedAt, opts.now),
  );
  const perSource = new Map<string, number>();
  const seenContent = new Set<string>();
  const out: KnowledgeHit[] = [];
  for (const h of sorted) {
    const n = perSource.get(h.sourceId) ?? 0;
    const key = h.content.trim().toLowerCase();
    if (n >= opts.maxPerSource || seenContent.has(key)) continue;
    perSource.set(h.sourceId, n + 1);
    seenContent.add(key);
    out.push(h);
  }
  return out;
}

const statusRank = { approved: 0, review: 1, draft: 2 } as const;

/** Freigegebene Korrekturen zuerst, dann in Prüfung, dann Entwurf – jeweils nach Similarity. */
export function rankCorrections(hits: CorrectionHit[]): CorrectionHit[] {
  return [...hits].sort((a, b) => statusRank[a.status] - statusRank[b.status] || b.similarity - a.similarity);
}
