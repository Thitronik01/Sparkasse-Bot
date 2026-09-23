/**
 * Minimaler strukturierter Logger.
 *
 * Regel: Es werden nur Metadaten geloggt (Endpunkt-Art, Status, Dauer, Modell, Fehlercode, Anzahl).
 * Niemals API-Keys, Prompts, Fragen, Antworten oder Kontexttexte übergeben – sie könnten
 * personenbezogene Daten enthalten. Deshalb akzeptiert der Logger nur primitive Felder und
 * kürzt Strings hart.
 */

type Level = "debug" | "info" | "warn" | "error";
type Field = string | number | boolean | null | undefined;

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_STRING = 120;

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL ?? "info") as Level;
  return order[lvl] ?? order.info;
}

function sanitize(fields: Record<string, Field>): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = typeof v === "string" && v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  }
  return out;
}

function write(level: Level, event: string, fields: Record<string, Field> = {}) {
  if (order[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...sanitize(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Record<string, Field>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, Field>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, Field>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, Field>) => write("error", event, fields),
};
