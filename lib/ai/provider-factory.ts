import { AnyMizeProvider } from "./anymize-provider";
import { AIProviderError } from "./errors";
import { MockAIProvider } from "./mock-provider";
import type { AIProvider } from "./provider";
import { getServerEnv } from "../config/server-env";

let instance: AIProvider | undefined;

/**
 * Liefert den konfigurierten Provider (AI_PROVIDER=anymize | mock).
 * Wird lazy beim ersten Request aufgerufen – die App startet also auch ohne gültige KI-Konfiguration.
 */
export function getAIProvider(): AIProvider {
  if (instance) return instance;
  const provider = getServerEnv().AI_PROVIDER;
  switch (provider) {
    case "anymize":
      instance = new AnyMizeProvider();
      break;
    case "mock":
      instance = new MockAIProvider();
      break;
    default:
      throw new AIProviderError("unknown_provider", `Unknown AI provider: ${provider ?? "(nicht gesetzt)"}`);
  }
  return instance;
}

/** Nur für Tests. */
export function resetAIProvider() {
  instance = undefined;
}
