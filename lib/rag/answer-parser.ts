import { z } from "zod";
import { STREAM_CONFLICT_MARKER } from "./context-builder";
import type { GeneratedAnswer } from "../types/knowledge";

const generatedSchema = z.object({
  answer: z.string().min(1),
  citedSourceIds: z.array(z.string()).default([]),
  unresolvedConflict: z.boolean().default(false),
});

export type ParsedAnswer = GeneratedAnswer & {
  /** true, wenn das Modell kein gültiges JSON geliefert hat und auf Text-Parsing zurückgefallen wurde. */
  usedFallback: boolean;
  /** Zitierte IDs, die es im Kontext gar nicht gab (werden verworfen). */
  unknownCitations: string[];
};

const MARKER = /\[([SK]\d{1,3})\]/g;

function markersIn(text: string): string[] {
  return [...text.matchAll(MARKER)].map((m) => m[1]);
}

function tryParseJson(content: string): unknown {
  const stripped = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Liest die strukturierte Modellantwort; fällt robust auf Text + [S1]-Marker zurück. */
export function parseGeneratedAnswer(content: string, validIds: Set<string>): ParsedAnswer {
  const parsed = generatedSchema.safeParse(tryParseJson(content));
  let answer: string;
  let cited: string[];
  let unresolvedConflict: boolean;
  let usedFallback = false;

  if (parsed.success) {
    answer = parsed.data.answer.trim();
    cited = [...parsed.data.citedSourceIds, ...markersIn(answer)];
    unresolvedConflict = parsed.data.unresolvedConflict;
  } else {
    usedFallback = true;
    ({ answer, unresolvedConflict } = stripConflictMarker(content));
    cited = markersIn(answer);
  }

  const unique = [...new Set(cited.map((id) => id.trim().toUpperCase()))];
  return {
    answer,
    citedSourceIds: unique.filter((id) => validIds.has(id)),
    unknownCitations: unique.filter((id) => !validIds.has(id)),
    unresolvedConflict,
    usedFallback,
  };
}

/** Streaming-Modus: Text-Antwort mit optionaler Schlusszeile [KONFLIKT]. */
export function parseStreamedAnswer(text: string, validIds: Set<string>): ParsedAnswer {
  const { answer, unresolvedConflict } = stripConflictMarker(text);
  const unique = [...new Set(markersIn(answer))];
  return {
    answer,
    citedSourceIds: unique.filter((id) => validIds.has(id)),
    unknownCitations: unique.filter((id) => !validIds.has(id)),
    unresolvedConflict,
    usedFallback: false,
  };
}

function stripConflictMarker(text: string): { answer: string; unresolvedConflict: boolean } {
  const unresolvedConflict = text.includes(STREAM_CONFLICT_MARKER);
  return { answer: text.split(STREAM_CONFLICT_MARKER).join("").trim(), unresolvedConflict };
}
