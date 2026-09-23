import assert from "node:assert/strict";
import { test } from "node:test";
import { AnymizeClient } from "../lib/ai/anymize-client";
import { AnyMizeProvider } from "../lib/ai/anymize-provider";
import { AIProviderError } from "../lib/ai/errors";
import { MockAIProvider } from "../lib/ai/mock-provider";
import { getAIProvider, resetAIProvider } from "../lib/ai/provider-factory";
import { getServerEnv, resetServerEnvCache, type ServerEnv } from "../lib/config/server-env";

function envWith(vars: Record<string, string | undefined>): ServerEnv {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("ANYMIZE_") || k === "AI_PROVIDER") delete process.env[k];
  Object.assign(process.env, vars);
  resetServerEnvCache();
  try {
    return getServerEnv();
  } finally {
    process.env = saved;
    resetServerEnvCache();
  }
}

function recordingClient() {
  const bodies: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push({ url: String(url), body });
    if (String(url).endsWith("/embeddings")) {
      const dim = body.output_dimension ?? 3;
      return Response.json({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: new Array(dim).fill(0.1) })) });
    }
    return Response.json({ model: body.model, choices: [{ message: { content: '{"answer":"x"}' }, finish_reason: "stop" }] });
  }) as typeof fetch;
  const client = new AnymizeClient({
    apiKey: "k",
    llmBaseUrl: "https://a.test/llm",
    anonymousBaseUrl: "https://a.test/llm-anonymous",
    timeoutMs: 1000,
    maxRetries: 0,
    fetchImpl,
  });
  return { client, bodies };
}

const base = { ANYMIZE_API_KEY: "k", ANYMIZE_CHAT_MODEL: "chat-x", ANYMIZE_EMBEDDING_MODEL: "embed-x", ANYMIZE_EMBEDDING_DIMENSION: "4" };

test("Anonymisierung steuert ausschließlich den Endpunkt", async () => {
  for (const [flag, suffix] of [["true", "/llm-anonymous/chat/completions"], ["false", "/llm/chat/completions"]] as const) {
    const { client, bodies } = recordingClient();
    const p = new AnyMizeProvider({ env: envWith({ ...base, ANYMIZE_USE_ANONYMIZATION: flag }), client });
    const res = await p.chat({ messages: [{ role: "user", content: "q" }], responseFormat: "json_object" });
    assert.ok(bodies[0].url.endsWith(suffix));
    assert.equal(res.anonymized, flag === "true");
    assert.equal(bodies[0].body.model, "chat-x");
    assert.equal(bodies[0].body.temperature, 0.1);
    assert.deepEqual(bodies[0].body.response_format, { type: "json_object" });
  }
});

test("Anonymisierung ist standardmäßig aktiv", () => {
  assert.equal(envWith(base).ANYMIZE_USE_ANONYMIZATION, true);
});

test("Embeddings: input_type, output_dimension, Batching, Reihenfolge", async () => {
  const { client, bodies } = recordingClient();
  const p = new AnyMizeProvider({ env: envWith({ ...base, ANYMIZE_EMBEDDING_BATCH_SIZE: "2" }), client });
  const vecs = await p.embed(["a", "b", "c"], { inputType: "query" });
  assert.equal(vecs.length, 3);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].body.input_type, "query");
  assert.equal(bodies[0].body.output_dimension, 4);
  assert.equal(bodies[0].body.model, "embed-x");
});

test("falsche Vektordimension wird erkannt", async () => {
  const fetchImpl = (async () => Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] })) as typeof fetch;
  const client = new AnymizeClient({ apiKey: "k", llmBaseUrl: "https://a.test/llm", anonymousBaseUrl: "https://a.test/x", timeoutMs: 1000, maxRetries: 0, fetchImpl });
  const p = new AnyMizeProvider({ env: envWith(base), client });
  await assert.rejects(p.embed(["a"], { inputType: "document" }), (e: AIProviderError) => e.code === "dimension_mismatch");
});

test("fehlende Modelle → missing_model", async () => {
  const { client } = recordingClient();
  const p = new AnyMizeProvider({ env: envWith({ ANYMIZE_API_KEY: "k" }), client });
  await assert.rejects(p.chat({ messages: [] }), (e: AIProviderError) => e.code === "missing_model");
  assert.throws(() => p.embeddingInfo(), (e: AIProviderError) => e.code === "missing_model");
});

test("Factory: unbekannter Provider → Fehler, mock funktioniert", () => {
  const saved = { ...process.env };
  try {
    process.env.AI_PROVIDER = "foo";
    resetServerEnvCache();
    resetAIProvider();
    assert.throws(() => getAIProvider(), (e: AIProviderError) => e.code === "unknown_provider");
    process.env.AI_PROVIDER = "mock";
    resetServerEnvCache();
    resetAIProvider();
    assert.equal(getAIProvider().name, "mock");
  } finally {
    process.env = saved;
    resetServerEnvCache();
    resetAIProvider();
  }
});

test("Mock erfindet keine Fachinhalte und ähnliche Texte liegen näher beieinander", async () => {
  const m = new MockAIProvider({ dimension: 256 });
  const res = await m.chat({ messages: [{ role: "user", content: '<quelle id="S1" typ="web">x</quelle>' }], responseFormat: "json_object" });
  const parsed = JSON.parse(res.content);
  assert.match(parsed.answer, /^\[MOCK\] Technische Testantwort/);
  assert.deepEqual(parsed.citedSourceIds, ["S1"]);

  const [q, near, far] = await m.embed(["Öffnungszeiten der Filiale Kiel", "Filiale Kiel Öffnungszeiten montags", "Kreditkarte sperren"], { inputType: "query" });
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  assert.ok(dot(q, near) > dot(q, far));
});
