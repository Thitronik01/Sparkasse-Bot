import "./_env";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Erzeugt supabase/migrations/002_vector_search.sql mit der Dimension aus ANYMIZE_EMBEDDING_DIMENSION
 * (oder --dim=N). Vorher mit `npm run ai:check` prüfen, welche Dimension das Modell tatsächlich liefert.
 */
const arg = process.argv.find((a) => a.startsWith("--dim="))?.slice(6);
const dim = Number(arg ?? process.env.ANYMIZE_EMBEDDING_DIMENSION);

if (!Number.isInteger(dim) || dim <= 0) {
  console.error("Bitte ANYMIZE_EMBEDDING_DIMENSION setzen oder --dim=N angeben.");
  process.exit(1);
}
if (dim > 2000) {
  console.error(`Dimension ${dim} > 2000: pgvector-HNSW-Indizes auf 'vector' unterstützen max. 2000 Dimensionen.`);
  console.error("Kleinere output_dimension wählen (z. B. 1024) oder Template auf halfvec umstellen.");
  process.exit(1);
}

const root = join(__dirname, "..");
const template = readFileSync(join(root, "supabase/templates/vector_search.sql.tpl"), "utf8");
const out = join(root, "supabase/migrations/002_vector_search.sql");
writeFileSync(out, template.replaceAll("{{DIM}}", String(dim)), "utf8");
console.log(`Geschrieben: supabase/migrations/002_vector_search.sql (vector(${dim}))`);
