export type AIErrorCode =
  | "not_configured"
  | "missing_api_key"
  | "invalid_api_key"
  | "forbidden"
  | "model_not_found"
  | "missing_model"
  | "bad_request"
  | "rate_limited"
  | "insufficient_credits"
  | "timeout"
  | "network_error"
  | "server_error"
  | "service_unavailable"
  | "invalid_response"
  | "embedding_error"
  | "dimension_mismatch"
  | "unknown_provider";

const userMessages: Record<AIErrorCode, string> = {
  not_configured: "Der KI-Dienst ist noch nicht konfiguriert. Bitte wende dich an das POC-Team.",
  missing_api_key: "Der KI-Dienst ist noch nicht konfiguriert. Bitte wende dich an das POC-Team.",
  invalid_api_key: "Der KI-Dienst hat die Anmeldung abgelehnt. Bitte wende dich an das POC-Team.",
  forbidden: "Der KI-Dienst verweigert den Zugriff. Bitte wende dich an das POC-Team.",
  model_not_found: "Das konfigurierte KI-Modell ist nicht verfügbar. Bitte wende dich an das POC-Team.",
  missing_model: "Das KI-Modell ist nicht konfiguriert. Bitte wende dich an das POC-Team.",
  bad_request: "Die Anfrage konnte nicht verarbeitet werden. Bitte formuliere die Frage kürzer oder anders.",
  rate_limited: "Gerade gehen zu viele Anfragen ein. Bitte versuche es in einer Minute erneut.",
  insufficient_credits: "Das Kontingent des KI-Dienstes ist aufgebraucht. Bitte wende dich an das POC-Team.",
  timeout: "Der KI-Dienst hat zu lange gebraucht. Bitte versuche es erneut.",
  network_error: "Der KI-Dienst ist gerade nicht erreichbar. Bitte versuche es erneut.",
  server_error: "Beim KI-Dienst ist ein Fehler aufgetreten. Bitte versuche es später erneut.",
  service_unavailable: "Der KI-Dienst ist vorübergehend nicht verfügbar. Bitte versuche es später erneut.",
  invalid_response: "Der KI-Dienst hat eine unerwartete Antwort geliefert. Bitte versuche es erneut.",
  embedding_error: "Die Suche in der Wissensbasis ist fehlgeschlagen. Bitte versuche es erneut.",
  dimension_mismatch: "Die Wissensbasis ist falsch konfiguriert (Vektordimension). Bitte wende dich an das POC-Team.",
  unknown_provider: "Der KI-Dienst ist falsch konfiguriert. Bitte wende dich an das POC-Team.",
};

const retryable = new Set<AIErrorCode>(["rate_limited", "timeout", "network_error", "server_error", "service_unavailable"]);

/**
 * Einheitlicher Fehler der AI-Schicht. `message` ist technisch (für Logs, ohne Prompt-Inhalte),
 * `userMessage` ist für Endanwender gedacht und enthält nie Stacktraces oder Rohfehler.
 */
export class AIProviderError extends Error {
  readonly code: AIErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: AIErrorCode, message: string, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "AIProviderError";
    this.code = code;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  get retryable(): boolean {
    return retryable.has(this.code);
  }

  get userMessage(): string {
    return userMessages[this.code];
  }
}

export function isAIProviderError(e: unknown): e is AIProviderError {
  return e instanceof AIProviderError;
}
