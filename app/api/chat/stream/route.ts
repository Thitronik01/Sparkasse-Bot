import { NextResponse } from "next/server";
import { toApiError } from "@/lib/api/errors";
import { readQuestion } from "@/lib/api/question";
import { getPipelineDeps } from "@/lib/rag/deps";
import { finalizeStreamedAnswer, prepareAnswer, previewSources } from "@/lib/rag/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/chat/stream  { question } → text/event-stream
 *
 * Events:
 *   sources  { sources }        – Kontextquellen, bevor die Generierung startet
 *   delta    { content }        – Text-Fragment der Antwort
 *   final    BotAnswer          – finale Antwort inkl. Confidence, zitierten Quellen und Hinweisen
 *   error    { code, message }  – nutzerfreundliche Fehlermeldung
 *
 * Retrieval, Korrekturvorrang, Konflikte und Confidence laufen identisch zu /api/chat.
 */
export async function POST(req: Request) {
  const input = await readQuestion(req);
  if (!input.ok) {
    return NextResponse.json({ error: { code: "invalid_question", message: input.message } }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const deps = getPipelineDeps();
        const prepared = await prepareAnswer(input.question, "stream", deps, req.signal);
        if (prepared.kind === "early") {
          send("final", prepared.answer);
          return;
        }
        send("sources", { sources: previewSources(prepared) });

        let full = "";
        for await (const ev of deps.provider.chatStream({ messages: prepared.context.messages, signal: req.signal })) {
          if (ev.type === "delta") {
            full += ev.content;
            send("delta", { content: ev.content });
          }
        }
        send("final", finalizeStreamedAnswer(prepared, full, deps));
      } catch (e) {
        if (req.signal.aborted) return; // Client hat die Verbindung beendet
        send("error", toApiError(e, "chat_stream").body.error);
      } finally {
        try {
          controller.close();
        } catch {
          // Stream bereits geschlossen
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
