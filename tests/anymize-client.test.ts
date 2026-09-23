import assert from "node:assert/strict";
import { test } from "node:test";
import { AnymizeClient, mapHttpError, parseRetryAfter } from "../lib/ai/anymize-client";
import { AIProviderError } from "../lib/ai/errors";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("keine weitere Antwort vorbereitet");
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const okChat = () => json(200, { model: "m", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof AnymizeClient>[0]> = {}) {
  const sleeps: number[] = [];
  const c = new AnymizeClient({
    apiKey: "test-key",
    llmBaseUrl: "https://example.test/api/v1/llm/",
    anonymousBaseUrl: "https://example.test/api/v1/llm-anonymous",
    timeoutMs: 200,
    maxRetries: 2,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { c, sleeps };
}

const body = { model: "m", messages: [{ role: "user" as const, content: "GEHEIMER PROMPT" }] };

test("wählt anonymen oder normalen Endpunkt und setzt Bearer-Auth", async () => {
  const f = fakeFetch([okChat, okChat]);
  const { c } = client(f.impl);
  await c.chatCompletion(body, { anonymous: true });
  await c.chatCompletion(body, { anonymous: false });
  assert.equal(f.calls[0].url, "https://example.test/api/v1/llm-anonymous/chat/completions");
  assert.equal(f.calls[1].url, "https://example.test/api/v1/llm/chat/completions");
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Bearer test-key");
});

test("ohne API-Key wird gar nicht erst angefragt", async () => {
  const f = fakeFetch([]);
  const { c } = client(f.impl, { apiKey: undefined });
  await assert.rejects(c.chatCompletion(body, { anonymous: true }), (e: AIProviderError) => e.code === "missing_api_key");
  assert.equal(f.calls.length, 0);
});

test("401 → invalid_api_key ohne Retry", async () => {
  const f = fakeFetch([() => json(401, { error: { message: "Invalid API key", type: "auth_error", code: "invalid_api_key" } })]);
  const { c } = client(f.impl);
  await assert.rejects(c.chatCompletion(body, { anonymous: true }), (e: AIProviderError) => e.code === "invalid_api_key" && !e.retryable);
  assert.equal(f.calls.length, 1);
});

test("unbekanntes Modell → model_not_found", async () => {
  const f = fakeFetch([() => json(404, { error: { message: "x", type: "invalid_request_error", code: "model_not_found" } })]);
  const { c } = client(f.impl);
  await assert.rejects(c.chatCompletion(body, { anonymous: false }), (e: AIProviderError) => e.code === "model_not_found");
});

test("429 mit Retry-After wird wiederholt und respektiert die Wartezeit", async () => {
  const f = fakeFetch([() => json(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "3" }), okChat]);
  const { c, sleeps } = client(f.impl);
  const res = await c.chatCompletion(body, { anonymous: true });
  assert.equal(res.choices[0].message?.content, "hi");
  assert.deepEqual(sleeps, [3000]);
});

test("5xx: nach maxRetries → server_error", async () => {
  const f = fakeFetch([() => json(500, {}), () => json(502, {}), () => json(500, {})]);
  const { c, sleeps } = client(f.impl);
  await assert.rejects(c.chatCompletion(body, { anonymous: true }), (e: AIProviderError) => e.code === "server_error");
  assert.equal(f.calls.length, 3);
  assert.equal(sleeps.length, 2);
});

test("Timeout → timeout", async () => {
  const hanging = ((_: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const { c } = client(hanging, { maxRetries: 0, timeoutMs: 20 });
  await assert.rejects(c.chatCompletion(body, { anonymous: true }), (e: AIProviderError) => e.code === "timeout");
});

test("ungültiges JSON bzw. fehlende choices → invalid_response", async () => {
  const f = fakeFetch([() => new Response("<html>", { status: 200 }), () => json(200, { choices: [] })]);
  const { c } = client(f.impl);
  await assert.rejects(c.chatCompletion(body, { anonymous: true }), (e: AIProviderError) => e.code === "invalid_response");
  await assert.rejects(c.chatCompletion(body, { anonymous: true }), (e: AIProviderError) => e.code === "invalid_response");
});

test("Embedding-Fehler werden als embedding_error gemeldet", async () => {
  const f = fakeFetch([() => json(200, { data: [] })]);
  const { c } = client(f.impl);
  await assert.rejects(c.embeddings({ model: "e", input: ["a"] }), (e: AIProviderError) => e.code === "embedding_error");
});

test("SSE-Stream wird in Chunks zerlegt und endet bei [DONE]", async () => {
  const sse =
    'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"Hal"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const f = fakeFetch([() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })]);
  const { c } = client(f.impl);
  let text = "";
  for await (const chunk of c.chatCompletionStream(body, { anonymous: true })) text += chunk.choices?.[0]?.delta?.content ?? "";
  assert.equal(text, "Hallo");
  assert.equal(JSON.parse(String(f.calls[0].init.body)).stream, true);
});

test("Logs enthalten weder Prompt noch API-Key", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const f = fakeFetch([() => json(500, {}), okChat]);
    await client(f.impl).c.chatCompletion(body, { anonymous: true });
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => !l.includes("GEHEIMER PROMPT") && !l.includes("test-key")));
});

test("parseRetryAfter und mapHttpError", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(mapHttpError(503, undefined, null).code, "service_unavailable");
  assert.equal(mapHttpError(404, undefined, null).code, "not_configured");
  assert.equal(mapHttpError(400, { error: { code: "missing_model" } }, null).code, "missing_model");
});
