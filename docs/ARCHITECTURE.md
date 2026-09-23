# Architektur

## Schichten

```text
UI / API-Routen (app/api/chat, app/api/chat/stream)
        ↓
RAG-Pipeline (lib/rag/pipeline.ts)  ← Quellenauswahl, Korrekturvorrang, Konflikte, Confidence
        ↓
AIProvider (lib/ai/provider.ts)     ← einzige Schnittstelle zum LLM
        ↓
AnyMizeProvider / MockAIProvider    (lib/ai/provider-factory.ts, AI_PROVIDER)
        ↓
AnymizeClient (lib/ai/anymize-client.ts) → anymize API
```

Kein Code außerhalb von `lib/ai` ruft die anymize API direkt auf. Der Provider lässt sich wechseln, ohne dass RAG, Correction Layer oder UI geändert werden müssen.

## Datenfluss einer Frage

Frage → Input Guard (`lib/api/question.ts`) → Query-Embedding (`input_type: query`) → Correction Retrieval + Knowledge Retrieval (pgvector, parallel) → Ranking → Konflikterkennung → Context Builder → `AIProvider.chat` (JSON) → Answer Parser → Confidence Engine → `BotAnswer` (answer, confidence, sources, notices).

Wenn keine Treffer gefunden werden, wird **kein** LLM-Aufruf gemacht. Die Antwort sagt dann ausdrücklich, dass nichts gefunden wurde, und hat Confidence 0.

## Was das LLM entscheidet und was nicht

| Entscheidung | Wer |
|---|---|
| Welche Quellen in den Kontext kommen (Top-K, Schwellen, max. Chunks je Quelle, Zeichenbudget) | Backend (`ranking.ts`, `context-builder.ts`) |
| Vorrang von Korrekturen (approved > offizielle Quelle > review > draft) | Backend (`conflicts.ts`). Überholte Chunks werden gar nicht erst übergeben. |
| Erkennen von Widersprüchen (Beträge, Prozente, Uhrzeiten, Datumsangaben) | Backend (`conflicts.ts`), zusätzlich das Signal `unresolvedConflict` vom Modell |
| Confidence (Score, Label, Begründungen) | Backend (`lib/confidence/score.ts`), nie vom Modell |
| Formulierung der Antwort, Zitieren der Quellen-IDs | LLM. Das Backend verwirft zitierte IDs, die nicht im Kontext waren. |

## Anonymisierung

`ANYMIZE_USE_ANONYMIZATION=true` (Standard) schickt Chat-Requests an `/api/v1/llm-anonymous/chat/completions`, sonst an `/api/v1/llm/chat/completions`. Es ändert sich nur der Endpunkt, entschieden wird ausschließlich serverseitig. Embeddings laufen immer über `/api/v1/llm/embeddings` (siehe `docs/EMBEDDINGS.md`, Abschnitt Datenschutz).

## Streaming

`POST /api/chat/stream` nutzt dieselbe Vorbereitung (`prepareAnswer`) und dieselbe Nachbearbeitung (`finalizeStreamedAnswer`) wie `/api/chat`. Das Modell antwortet im Streaming-Modus als Text mit `[S1]`-Markern. Einen ungelösten Widerspruch meldet es mit der Schlusszeile `[KONFLIKT]`. SSE-Events: `sources`, `delta`, `final`, `error`.

## Fehlerbehandlung

`AIProviderError` (Codes u. a. `missing_api_key`, `invalid_api_key`, `model_not_found`, `rate_limited`, `timeout`, `server_error`, `invalid_response`, `embedding_error`, `dimension_mismatch`) und `RetrievalError` werden in `lib/api/errors.ts` in nutzerfreundliche deutsche Meldungen übersetzt, ohne Stacktraces. Bei 429 und 5xx wiederholt der Client die Anfrage mit exponentiellem Backoff und beachtet dabei `Retry-After`. 4xx-Fehler werden nicht wiederholt.

## Logging

`lib/log.ts` loggt nur Metadaten: Operation, Status, Dauer, Modell, Fehlercodes, Anzahlen und anymize-Header wie `X-Anymize-Credits-Used`. Prompts, Fragen, Antworten, Kontexttexte und API-Keys werden nie geloggt. Ein Test sichert das ab.

## Correction Entity

Speichert `trigger_text`, `corrected_content`, `status` (draft/review/approved/rejected/archived), `rationale`, `source_url`, `valid_from`/`valid_until`, `embedding` + `embedding_model`, `created_by`, `reviewed_by` und Zeitstempel. Im Chat werden nur `approved`/`review`/`draft` innerhalb des Gültigkeitszeitraums berücksichtigt (`match_corrections`).

## Regeln

Eine freigegebene Korrektur (approved) überschreibt widersprechendes gecrawltes Wissen. Review und Draft werden niemals stillschweigend als bestätigte Wahrheit ausgegeben. Webseiten- und Dokumenttext gilt als Datenmaterial, nicht als Instruktion; Struktur-Tags im Quelltext werden entschärft. Secrets bleiben serverseitig, und RLS ist auf allen Tabellen aktiv.
