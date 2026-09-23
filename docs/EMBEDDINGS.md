# Embeddings & Vektordimension

> **Kurzfassung:** `ANYMIZE_EMBEDDING_DIMENSION` in der Umgebung und `vector(N)` in
> `supabase/migrations/002_vector_search.sql` müssen **exakt gleich** sein. Wenn du eins davon änderst,
> musst du auch das andere ändern und **alle Embeddings neu berechnen**.

## Wo Embeddings entstehen

| Fluss | `input_type` | Code |
|---|---|---|
| Webseite → Chunks → Embeddings → pgvector | `document` | `lib/rag/ingest.ts` (`npm run ingest`) |
| Korrektur → Embedding → pgvector | `document` | `lib/corrections/embedding.ts` (`npm run corrections:embed`) |
| Benutzerfrage → Query-Embedding → Similarity Search | `query` | `lib/rag/pipeline.ts` |

Laut anymize-Doku unterstützt der Endpunkt `input_type: "query" | "document"`. Das bringt bessere Treffer, und Vektoren mit und ohne `input_type` bleiben vergleichbar.

## Endpunkt und Modell (Stand der anymize-Doku, 23.09.2026)

- `POST https://app.anymize.ai/api/v1/llm/embeddings`: OpenAI-kompatibel, Bearer-Auth.
- `GET` auf denselben Pfad liefert die Modellliste mit Dimensionen und Preisen. `npm run ai:check` gibt sie aus.
- Aktuell gibt es genau ein Modell: **`voyage-4-lite`**. Es ist trotzdem nicht im Code hartcodiert, sondern wird über `ANYMIZE_EMBEDDING_MODEL` gesetzt.
- Mit dem Parameter `output_dimension` wird die Vektorlänge festgelegt. Wir senden immer `output_dimension = ANYMIZE_EMBEDDING_DIMENSION`. Dadurch ist die Länge deterministisch und hängt nicht vom Standardwert des Modells ab.
- **Datenschutz:** Für Embeddings gibt es laut Doku **keinen** anonymisierenden Endpunkt. Die Texte werden von Voyage AI berechnet und verlassen dafür kurzzeitig die anymize-Infrastruktur. Das betrifft auch die **Benutzerfrage**, wenn sie als Query-Embedding berechnet wird. Für den POC mit Testdaten ist das vertretbar. Vor echtem Einsatz muss es in die Datenschutzprüfung, zum Beispiel mit einer Vor-Anonymisierung der Frage über die anymize Core API.

## Festlegen der Dimension

1. `.env.local`: `AI_PROVIDER=anymize`, `ANYMIZE_API_KEY`, `ANYMIZE_EMBEDDING_MODEL` und `ANYMIZE_EMBEDDING_DIMENSION` setzen (Vorschlag: `1024`).
2. `npm run ai:check`: Das Skript listet die Modelle samt unterstützten Dimensionen, erzeugt ein Test-Embedding und meldet dessen tatsächliche Länge. Wenn die Länge nicht zur Konfiguration passt, bricht es mit `dimension_mismatch` ab.
3. `npm run db:vector-migration`: Das Skript erzeugt `supabase/migrations/002_vector_search.sql` aus `supabase/templates/vector_search.sql.tpl` mit der konfigurierten Dimension.
4. `001_init.sql` und danach `002_vector_search.sql` in Supabase ausführen.

Die Datei `002_vector_search.sql` im Repo ist für **1024** Dimensionen generiert.

### Grenzen

- pgvector-HNSW-Indizes auf `vector` erlauben maximal **2000** Dimensionen. Der Generator lehnt größere Werte ab. Wer mehr braucht, muss das Template auf `halfvec` umstellen.
- Die Similarity-Schwellen (`RAG_MIN_SIMILARITY`, `CORRECTION_MIN_SIMILARITY`) hängen vom Modell ab und müssen mit echten Daten kalibriert werden. Mit dem Mock-Provider (Hash-Vektoren) liegen sinnvolle Werte bei etwa `0.1`.

## Modell- oder Dimensionswechsel

1. Env anpassen, dann `npm run ai:check`.
2. `npm run db:vector-migration` ausführen und die Migration anwenden. Vorhandene `embedding`-Spalten mit anderer Dimension werden dabei ersetzt, ihre Vektoren gehen verloren.
3. `npm run ingest` und `npm run corrections:embed -- --all` ausführen.

Jeder Vektor wird mit `embedding_model` gespeichert. Die Suchfunktionen vergleichen nur Vektoren desselben Modells. So werden Mock-Vektoren und echte Vektoren nie vermischt.
