export type CorrectionStatus = "draft" | "review" | "approved" | "rejected" | "archived";
/** Status, mit denen eine Korrektur im Chat berücksichtigt werden darf. */
export type ActiveCorrectionStatus = "approved" | "review" | "draft";

export type ConfidenceLabel = "low" | "medium" | "high";

/** Was das Modell liefern soll. Confidence erzeugt ausdrücklich NICHT das Modell. */
export type GeneratedAnswer = {
  answer: string;
  citedSourceIds: string[];
  unresolvedConflict: boolean;
};

export type Source = {
  /** Kontext-ID, auf die sich die Antwort bezieht: S1… für Wissen, K1… für Korrekturen. */
  id: string;
  title: string;
  url?: string;
  sourceType: "web" | "upload" | "correction";
  correctionStatus?: ActiveCorrectionStatus;
  /** Abrufzeitpunkt (Web/Upload) bzw. letzte Änderung (Korrektur), ISO-8601. */
  asOf?: string;
  similarity: number;
  /** true, wenn die Antwort diese Quelle tatsächlich zitiert. */
  cited: boolean;
  excerpt: string;
};

export type NoticeType =
  | "correction_approved"
  | "correction_review"
  | "correction_draft"
  | "conflict"
  | "overridden_source"
  | "no_results"
  | "uncited_answer"
  | "low_confidence"
  | "mock_provider";

export type Notice = {
  type: NoticeType;
  severity: "info" | "warning";
  message: string;
  sourceIds?: string[];
};

export type BotAnswer = {
  answer: string;
  confidence: {
    /** 0–100. Erklärbarer Evidenz-Score des Backends, keine Modell-Wahrscheinlichkeit. */
    score: number;
    label: ConfidenceLabel;
    reasons: string[];
  };
  sources: Source[];
  notices: Notice[];
};
