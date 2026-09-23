import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "../config/server-env";
import { RetrievalError } from "../rag/errors";

if (typeof window !== "undefined") {
  throw new Error("supabase-server darf nur serverseitig verwendet werden.");
}

let client: SupabaseClient | undefined;

/** Supabase-Client mit Service-Role-Key. Umgeht RLS – ausschließlich serverseitig verwenden. */
export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;
  const env = getServerEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new RetrievalError("store_not_configured", "NEXT_PUBLIC_SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt");
  }
  client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
