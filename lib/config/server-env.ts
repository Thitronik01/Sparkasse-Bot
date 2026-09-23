import { z } from "zod";

/**
 * Zentrale, ausschließlich serverseitige Konfiguration.
 *
 * Secrets (ANYMIZE_API_KEY, SUPABASE_SERVICE_ROLE_KEY) werden nur hier gelesen.
 * Niemals in NEXT_PUBLIC_* ablegen und dieses Modul nie aus Client-Komponenten importieren.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/config/server-env darf nur serverseitig importiert werden.");
}

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());
const bool = (def: boolean) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" ? v.trim().toLowerCase() : undefined),
    z.enum(["true", "false", "1", "0"]).optional().transform((v) => (v === undefined ? def : v === "true" || v === "1")),
  );
const num = (def: number, min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(min).max(max).default(def));
const int = (def: number, min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));

const schema = z.object({
  AI_PROVIDER: optionalString,

  ANYMIZE_API_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default("https://app.anymize.ai/api/v1/llm")),
  ANYMIZE_ANONYMOUS_API_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default("https://app.anymize.ai/api/v1/llm-anonymous"),
  ),
  ANYMIZE_API_KEY: optionalString,
  ANYMIZE_USE_ANONYMIZATION: bool(true),
  ANYMIZE_CHAT_MODEL: optionalString,
  ANYMIZE_CHAT_TEMPERATURE: num(0.1, 0, 1),
  ANYMIZE_CHAT_MAX_TOKENS: int(1200, 64, 16000),
  ANYMIZE_JSON_MODE: bool(true),
  ANYMIZE_EMBEDDING_MODEL: optionalString,
  // Muss exakt zur vector(N)-Spalte der Supabase-Migration passen (siehe docs/EMBEDDINGS.md).
  ANYMIZE_EMBEDDING_DIMENSION: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(4096).optional()),
  ANYMIZE_EMBEDDING_BATCH_SIZE: int(64, 1, 1000),
  ANYMIZE_TIMEOUT_MS: int(30000, 1000, 300000),
  ANYMIZE_MAX_RETRIES: int(2, 0, 6),

  MOCK_EMBEDDING_DIMENSION: int(1024, 8, 4096),

  NEXT_PUBLIC_SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,

  RAG_TOP_K: int(8, 1, 50),
  RAG_MIN_SIMILARITY: num(0.55, 0, 1),
  RAG_MAX_CHUNKS_PER_SOURCE: int(2, 1, 10),
  RAG_MAX_CONTEXT_CHARS: int(12000, 1000, 200000),
  CORRECTION_TOP_K: int(5, 0, 50),
  CORRECTION_MIN_SIMILARITY: num(0.6, 0, 1),

  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(["debug", "info", "warn", "error"]).default("info")),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Nur Variablennamen ausgeben, niemals Werte (könnten Secrets sein).
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Ungültige Server-Konfiguration in: ${fields}`);
  }
  cached = parsed.data;
  return cached;
}

/** Nur für Tests. */
export function resetServerEnvCache() {
  cached = undefined;
}
