# Förde Sparkasse – interner RAG Bot POC

POC für einen internen Wissensassistenten der Förde Sparkasse in Kiel.

## Zielarchitektur

Mitarbeiter → Chat → Retrieval → Correction Layer → AI Provider → Antwort + Quellen + Confidence.

Die Wissensquellen sind die offiziellen Webseiten der Förde Sparkasse und später Uploads. GitHub hält Code und Config, Netlify deployt die Next.js-App, und Supabase/Postgres mit pgvector hält Chunks, Embeddings, Korrekturen und Audit-Daten. Details stehen in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Korrektur-Priorität

1. APPROVED-Korrektur: hat Vorrang vor widersprechendem RAG-Wissen.
2. Aktuelle offizielle Quelle.
3. REVIEW-Korrektur: darf einfließen, muss aber sichtbar als „in Prüfung“ markiert werden.
4. DRAFT-Korrektur: nur als vorläufiger Hinweis „Entwurf / möglicherweise im Wandel“.
5. Bei Konflikt: den Konflikt offen nennen und nichts erfinden.

## Confidence

Die Prozentzahl ist keine behauptete Modell-Wahrscheinlichkeit. Sie ist ein erklärbarer Evidenz-Score aus Retrieval-Similarity, Quellenanzahl, Aktualität, Konflikten und Korrekturstatus (`lib/confidence/score.ts`). Zusätzlich werden immer ein Label (low/medium/high) und die Begründungen angezeigt.

## AI Provider: anymize

- Chat: `POST https://app.anymize.ai/api/v1/llm-anonymous/chat/completions`, wenn `ANYMIZE_USE_ANONYMIZATION=true` (Standard). Sonst `…/api/v1/llm/chat/completions`.
- Embeddings: `POST https://app.anymize.ai/api/v1/llm/embeddings` mit `input_type` `document` bzw. `query`.
- Der Key liegt ausschließlich serverseitig in `ANYMIZE_API_KEY`, niemals in `NEXT_PUBLIC_*`.
- Modellnamen kommen aus der Env (`ANYMIZE_CHAT_MODEL`, `ANYMIZE_EMBEDDING_MODEL`), nicht aus dem Code.
- **Vektordimension:** siehe [docs/EMBEDDINGS.md](docs/EMBEDDINGS.md). `ANYMIZE_EMBEDDING_DIMENSION` muss zu `vector(N)` in der Migration passen.
- Ohne anymize-Konfiguration: `AI_PROVIDER=mock`. Dann liefert die App technische Testantworten ohne Fachinhalte, und die Embeddings sind Hash-Vektoren.

## API

| Route | Zweck |
|---|---|
| `POST /api/chat` `{question}` | Antwort als `BotAnswer` (answer, confidence, sources, notices) |
| `POST /api/chat/stream` `{question}` | SSE: `sources`, `delta`, `final`, `error` |
| `GET /api/health` | Konfigurationsstatus (nur ob etwas gesetzt ist, nie die Werte) |

## POC-Start

1. `Copy-Item .env.example .env.local` und die Werte eintragen. Ohne API-Key `AI_PROVIDER=mock` setzen.
2. `npm install`
3. Mit anymize `npm run ai:check` ausführen. Das Skript prüft Key, Modelle, Embedding-Dimension und den Chat-Endpunkt.
4. Wenn die Dimension von 1024 abweicht: `npm run db:vector-migration`.
5. Supabase-Projekt anlegen und `supabase/migrations/001_init.sql` sowie `002_vector_search.sql` ausführen.
6. `npm run ingest` crawlt die Seed-URLs, bettet sie ein und speichert sie. Mit `npm run corrections:embed` werden die Korrekturen eingebettet.
7. `npm run dev`
8. Tests und Typprüfung: `npm test`, `npm run typecheck`
9. GitHub-Repo erstellen und verbinden. Danach das Repo in Netlify importieren und dieselben Secrets als Environment Variables hinterlegen.

Vor Produktion: SSO/RBAC, Datenschutz (inkl. Query-Embeddings ohne Anonymisierung, siehe EMBEDDINGS.md), Informationssicherheit, Audit, Upload-Validierung, Löschkonzept, Prompt-Injection-Tests und offizielle CI-Freigabe.
