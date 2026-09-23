import { z } from "zod";

export const MAX_QUESTION_CHARS = 2000;

const bodySchema = z.object({
  question: z
    .string()
    .transform((q) => q.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    .pipe(z.string().min(3).max(MAX_QUESTION_CHARS)),
});

export type QuestionResult = { ok: true; question: string } | { ok: false; message: string };

export async function readQuestion(req: Request): Promise<QuestionResult> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, message: "Ungültige Anfrage." };
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: `Bitte gib eine Frage mit 3 bis ${MAX_QUESTION_CHARS} Zeichen ein.` };
  }
  return { ok: true, question: parsed.data.question };
}
