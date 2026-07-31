import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../types";

// Cada request crea su propio cliente (los Workers son stateless por diseño,
// no hay "conexión persistente" que reutilizar entre requests).
// Esto es barato: supabase-js habla por HTTPS, no abre un socket TCP.
export function getSupabaseClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      // El Worker no necesita persistir sesión de usuario final -
      // actúa siempre como admin (service_role) y filtra por su cuenta.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
