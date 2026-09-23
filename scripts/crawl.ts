import "./_env";
import * as cheerio from "cheerio";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAIProvider } from "../lib/ai/provider-factory";
import { getSupabaseAdmin } from "../lib/db/supabase-server";
import { ingestSource } from "../lib/rag/ingest";

/**
 * Crawlt die Seed-URLs (knowledge/seed/urls.txt) und gibt Titel/Textlänge aus.
 * Mit `--ingest` werden die Seiten gechunkt, eingebettet und in Supabase gespeichert.
 */
const host = process.env.CRAWL_ALLOWED_HOST ?? "www.foerde-sparkasse.de";
const userAgent = process.env.CRAWL_USER_AGENT ?? "FoerdeSparkasseInternalPOC/0.1";
const ingest = process.argv.includes("--ingest");

function seeds(): string[] {
  return readFileSync(join(__dirname, "../knowledge/seed/urls.txt"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function allowed(u: URL) {
  const p = u.pathname.toLowerCase();
  return u.protocol === "https:" && u.hostname === host && !p.includes("onlinebanking") && !p.includes("login");
}

/** Extrahiert Fließtext mit Absatzgrenzen (wichtig für das Chunking). */
function extractText($: cheerio.CheerioAPI): string {
  $("script,style,noscript,nav,footer,header,form,iframe,svg").remove();
  const root = $("main").length ? $("main") : $("body");
  const blocks: string[] = [];
  root.find("h1,h2,h3,h4,p,li,td,th,dt,dd").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text) blocks.push(text);
  });
  return blocks.join("\n\n");
}

async function main() {
  const provider = ingest ? getAIProvider() : undefined;
  const db = ingest ? getSupabaseAdmin() : undefined;

  for (const s of seeds()) {
    const u = new URL(s);
    if (!allowed(u)) {
      console.warn("übersprungen (nicht erlaubt):", s);
      continue;
    }
    const r = await fetch(u, { headers: { "User-Agent": userAgent } });
    if (!r.ok) {
      console.warn(r.status, s);
      continue;
    }
    const $ = cheerio.load(await r.text());
    const title = $("title").text().trim() || s;
    const text = extractText($);
    const line: Record<string, unknown> = { url: s, title, chars: text.length };

    if (ingest && provider && db && text.length > 0) {
      const res = await ingestSource(db, provider, { sourceType: "web", title, url: s, text, fetchedAt: new Date() });
      line.chunks = res.chunks;
      line.skipped = res.skipped;
    }
    console.log(JSON.stringify(line));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
