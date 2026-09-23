import "./_env";
import { getAIProvider } from "../lib/ai/provider-factory";
import { embedPendingCorrections } from "../lib/corrections/embedding";
import { getSupabaseAdmin } from "../lib/db/supabase-server";

/** Berechnet fehlende/veraltete Korrektur-Embeddings. `--all` berechnet alle neu. */
async function main() {
  const n = await embedPendingCorrections(getSupabaseAdmin(), getAIProvider(), { all: process.argv.includes("--all") });
  console.log(`${n} Korrektur(en) eingebettet.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
