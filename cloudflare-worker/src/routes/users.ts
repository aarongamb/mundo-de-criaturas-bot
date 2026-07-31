import { Hono } from "hono";
import type { Env } from "../types";
import type { TelegramUser } from "../middleware/telegram-auth";
import { getSupabaseClient } from "../db/supabase-client";

const users = new Hono<{ Bindings: Env; Variables: { telegramUser: TelegramUser } }>();

// POST /api/users/init
// Se llama cada vez que el usuario abre la Mini App.
// Si el usuario no existe en Supabase, lo crea (con su criatura fundadora
// en un paso posterior). Si ya existe, simplemente lo devuelve.
users.post("/init", async (c) => {
  const telegramUser = c.get("telegramUser"); // ya viene verificado por el middleware
  const supabase = getSupabaseClient(c.env);

  const { data: existingUser, error: fetchError } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramUser.id)
    .maybeSingle();

  if (fetchError) {
    return c.json({ error: "Error consultando usuario", detail: fetchError.message }, 500);
  }

  if (existingUser) {
    return c.json({ user: existingUser, isNewUser: false });
  }

  const { data: newUser, error: insertError } = await supabase
    .from("users")
    .insert({
      telegram_id: telegramUser.id,
      username: telegramUser.username ?? telegramUser.first_name ?? "Jugador",
    })
    .select()
    .single();

  if (insertError) {
    return c.json({ error: "Error creando usuario", detail: insertError.message }, 500);
  }

  return c.json({ user: newUser, isNewUser: true }, 201);
});

export default users;
