import { NextResponse } from "next/server";
import { toApiError } from "@/lib/api/errors";
import { readQuestion } from "@/lib/api/question";
import { getPipelineDeps } from "@/lib/rag/deps";
import { answerQuestion } from "@/lib/rag/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/chat  { question } → BotAnswer (nicht streamend). */
export async function POST(req: Request) {
  const input = await readQuestion(req);
  if (!input.ok) {
    return NextResponse.json({ error: { code: "invalid_question", message: input.message } }, { status: 400 });
  }
  try {
    const answer = await answerQuestion(input.question, getPipelineDeps(), req.signal);
    return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const { status, body } = toApiError(e, "chat");
    return NextResponse.json(body, { status });
  }
}
