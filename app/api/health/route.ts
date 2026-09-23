import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/config/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Konfigurationsstatus ohne Secrets: zeigt nur, OB etwas gesetzt ist – nie Werte. */
export async function GET() {
  try {
    const env = getServerEnv();
    return NextResponse.json({
      ok: true,
      aiProvider: env.AI_PROVIDER ?? null,
      anymize: {
        apiKeySet: Boolean(env.ANYMIZE_API_KEY),
        chatModelSet: Boolean(env.ANYMIZE_CHAT_MODEL),
        embeddingModelSet: Boolean(env.ANYMIZE_EMBEDDING_MODEL),
        embeddingDimension: env.ANYMIZE_EMBEDDING_DIMENSION ?? null,
        anonymization: env.ANYMIZE_USE_ANONYMIZATION,
      },
      supabaseConfigured: Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Ungültige Server-Konfiguration" }, { status: 500 });
  }
}
