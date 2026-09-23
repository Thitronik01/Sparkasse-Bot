import "./_env";
import { AnymizeClient } from "../lib/ai/anymize-client";
import { isAIProviderError } from "../lib/ai/errors";
import { getAIProvider } from "../lib/ai/provider-factory";
import { getServerEnv } from "../lib/config/server-env";

/**
 * Prüft die KI-Konfiguration gegen die echte API (npm run ai:check):
 *  - listet Chat- und Embedding-Modelle (inkl. Dimensionen, falls die API sie liefert)
 *  - erzeugt ein Test-Embedding (document + query) und vergleicht die Länge mit ANYMIZE_EMBEDDING_DIMENSION
 *  - schickt eine kurze technische Chat-Anfrage über den konfigurierten (ggf. anonymen) Endpunkt
 * Gibt keine Secrets aus.
 */
async function main() {
  const env = getServerEnv();
  console.log(`AI_PROVIDER=${env.AI_PROVIDER ?? "(nicht gesetzt)"}`);
  console.log(`Anonymisierung: ${env.ANYMIZE_USE_ANONYMIZATION ? "an (llm-anonymous)" : "aus (llm)"}`);
  console.log(`API-Key gesetzt: ${env.ANYMIZE_API_KEY ? "ja" : "nein"}`);
  console.log(`Chat-Modell: ${env.ANYMIZE_CHAT_MODEL ?? "(nicht gesetzt)"}`);
  console.log(`Embedding-Modell: ${env.ANYMIZE_EMBEDDING_MODEL ?? "(nicht gesetzt)"}, Dimension: ${env.ANYMIZE_EMBEDDING_DIMENSION ?? "(nicht gesetzt)"}`);

  if (env.AI_PROVIDER === "anymize") {
    const client = new AnymizeClient({
      apiKey: env.ANYMIZE_API_KEY,
      llmBaseUrl: env.ANYMIZE_API_BASE_URL,
      anonymousBaseUrl: env.ANYMIZE_ANONYMOUS_API_BASE_URL,
      timeoutMs: env.ANYMIZE_TIMEOUT_MS,
      maxRetries: 0,
    });
    await step("Chat-Modelle (GET /models)", async () => {
      const res = (await client.listModels()) as { data?: { id: string }[] };
      const ids = (res.data ?? []).map((m) => m.id);
      console.log(`  ${ids.length} Modelle${ids.length ? `: ${ids.slice(0, 40).join(", ")}${ids.length > 40 ? ", …" : ""}` : ""}`);
      if (env.ANYMIZE_CHAT_MODEL && ids.length && !ids.includes(env.ANYMIZE_CHAT_MODEL)) {
        console.log(`  WARNUNG: ANYMIZE_CHAT_MODEL "${env.ANYMIZE_CHAT_MODEL}" nicht in der Liste.`);
      }
    });
    await step("Embedding-Modelle (GET /embeddings)", async () => {
      console.log(`  ${JSON.stringify(await client.listEmbeddingModels(), null, 2).split("\n").join("\n  ")}`);
    });
  }

  const provider = getAIProvider();
  await step(`Embedding über Provider "${provider.name}"`, async () => {
    const [doc] = await provider.embed(["Testtext für die Dimensionsprüfung."], { inputType: "document" });
    const [query] = await provider.embed(["Testfrage"], { inputType: "query" });
    console.log(`  document: ${doc.length} Dimensionen, query: ${query.length} Dimensionen`);
    console.log(`  → supabase/migrations/002_vector_search.sql muss vector(${doc.length}) verwenden.`);
  });
  await step(`Chat über Provider "${provider.name}"`, async () => {
    const res = await provider.chat({
      messages: [{ role: "user", content: 'Antworte nur mit dem JSON {"ok": true}.' }],
      responseFormat: "json_object",
      maxTokens: 20,
    });
    console.log(`  Modell: ${res.model}, anonymisiert: ${res.anonymized}, finish_reason: ${res.finishReason ?? "-"}, Tokens: ${res.usage?.totalTokens ?? "-"}`);
    console.log(`  Antwort: ${res.content.slice(0, 200)}`);
  });
}

async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    await fn();
    console.log("  ✔ ok");
  } catch (e) {
    process.exitCode = 1;
    if (isAIProviderError(e)) console.log(`  ✖ ${e.code}: ${e.message}`);
    else console.log(`  ✖ ${e instanceof Error ? e.message : String(e)}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
