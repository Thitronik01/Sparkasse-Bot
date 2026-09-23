import type { ActiveCorrectionStatus } from "../types/knowledge";

export type KnowledgeHit = {
  kind: "knowledge";
  chunkId: string;
  sourceId: string;
  content: string;
  chunkIndex: number;
  similarity: number;
  sourceType: "web" | "upload";
  title: string;
  url?: string;
  fetchedAt?: string;
};

export type CorrectionHit = {
  kind: "correction";
  correctionId: string;
  title: string;
  triggerText: string;
  correctedContent: string;
  rationale?: string;
  sourceUrl?: string;
  status: ActiveCorrectionStatus;
  validFrom?: string;
  validUntil?: string;
  updatedAt?: string;
  similarity: number;
};

/** Ein Treffer mit stabiler Kontext-ID (S1… / K1…), wie er dem Modell übergeben wird. */
export type ContextSource = (KnowledgeHit | CorrectionHit) & { id: string };

export type ConflictResolution =
  /** Eine freigegebene Korrektur hat Vorrang; die widersprechende Quelle wird nicht mehr als aktuell verwendet. */
  | "correction_overrides"
  /** Korrektur in Prüfung/Entwurf weicht ab: offizielle Quelle führt, Korrektur wird als Hinweis gezeigt. */
  | "official_source_preferred"
  /** Nicht automatisch auflösbar – muss offen genannt werden. */
  | "unresolved";

export type Conflict = {
  kind: "correction_vs_knowledge" | "correction_vs_correction" | "knowledge_vs_knowledge";
  /** Referenzen auf interne Treffer (chunkId / correctionId), die IDs werden erst im Context Builder vergeben. */
  refs: [string, string];
  factType: FactType;
  resolution: ConflictResolution;
  /** ID der Quelle, die sich durchsetzt (bei correction_overrides / official_source_preferred). */
  winnerRef?: string;
};

export type FactType = "percent" | "money" | "time" | "date";

export type RetrievalOptions = { model: string; topK: number; minSimilarity: number };
