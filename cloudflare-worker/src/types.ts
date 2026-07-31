// Define qué variables de entorno espera el Worker.
// Hono usa esto para darte autocompletado y chequeo de tipos con c.env.X

export type Env = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
};
