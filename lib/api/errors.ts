import { AIProviderError } from "../ai/errors";
import { log } from "../log";
import { RetrievalError } from "../rag/errors";

export type ApiError = { error: { code: string; message: string } };

/**
 * Übersetzt interne Fehler in eine sichere Antwort für Endanwender:
 * kein Stacktrace, keine Rohfehler des Providers, keine Prompt-Inhalte.
 */
export function toApiError(e: unknown, op: string): { status: number; body: ApiError } {
  if (e instanceof AIProviderError) {
    log.error("api.error", { op, code: e.code, upstream_status: e.status, detail: e.message });
    const status = e.code === "rate_limited" ? 429 : e.code === "bad_request" ? 400 : e.code === "timeout" ? 504 : 502;
    return { status, body: { error: { code: e.code, message: e.userMessage } } };
  }
  if (e instanceof RetrievalError) {
    log.error("api.error", { op, code: e.code, detail: e.message });
    return { status: 503, body: { error: { code: e.code, message: e.userMessage } } };
  }
  log.error("api.error", { op, code: "internal_error", error_name: e instanceof Error ? e.name : typeof e });
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es erneut." } },
  };
}
