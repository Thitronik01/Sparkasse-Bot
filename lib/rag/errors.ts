export type RetrievalErrorCode = "store_not_configured" | "store_error";

const userMessages: Record<RetrievalErrorCode, string> = {
  store_not_configured: "Die Wissensbasis ist noch nicht angebunden. Bitte wende dich an das POC-Team.",
  store_error: "Die Wissensbasis ist gerade nicht erreichbar. Bitte versuche es erneut.",
};

export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  constructor(code: RetrievalErrorCode, message: string, opts: { cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "RetrievalError";
    this.code = code;
  }
  get userMessage(): string {
    return userMessages[this.code];
  }
}
