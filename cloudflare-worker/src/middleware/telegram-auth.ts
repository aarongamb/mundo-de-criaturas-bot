import { Context, Next } from "hono";
import type { Env } from "../types";

// ============================================================================
// Verificación de initData de Telegram
// ============================================================================
// Esto es OBLIGATORIO y no es opcional: sin esto, cualquiera puede mandar
// una petición diciendo "soy el usuario X" y robarle criaturas/monedas.
// Algoritmo oficial de Telegram:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// 1. Se separa el campo `hash` del resto de los datos.
// 2. Se ordenan alfabéticamente las claves restantes y se arma un string.
// 3. secret_key = HMAC-SHA256("WebAppData", bot_token)
// 4. computed_hash = HMAC-SHA256(secret_key, data_check_string)
// 5. Si computed_hash === hash recibido, los datos son auténticos y no
//    fueron alterados por el cliente.
// ============================================================================

async function hmacSha256(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export async function verifyTelegramInitData(
  initData: string,
  botToken: string
): Promise<{ valid: boolean; user: TelegramUser | null }> {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return { valid: false, user: null };

  params.delete("hash");

  // Ordenar alfabéticamente y armar el data_check_string
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // secret_key = HMAC-SHA256(key="WebAppData", data=bot_token)
  const secretKeyBuffer = await hmacSha256(
    new TextEncoder().encode("WebAppData"),
    botToken
  );

  // computed_hash = HMAC-SHA256(key=secret_key, data=dataCheckString)
  const computedHashBuffer = await hmacSha256(secretKeyBuffer, dataCheckString);
  const computedHash = bufferToHex(computedHashBuffer);

  if (computedHash !== receivedHash) {
    return { valid: false, user: null };
  }

  const userRaw = params.get("user");
  const user: TelegramUser | null = userRaw ? JSON.parse(userRaw) : null;

  return { valid: true, user };
}

// Middleware de Hono: exige un header `X-Telegram-Init-Data` válido
// y deja el usuario verificado disponible como c.get("telegramUser")
export async function telegramAuthMiddleware(
  c: Context<{ Bindings: Env; Variables: { telegramUser: TelegramUser } }>,
  next: Next
) {
  const initData = c.req.header("X-Telegram-Init-Data");

  if (!initData) {
    return c.json({ error: "Falta X-Telegram-Init-Data" }, 401);
  }

  const { valid, user } = await verifyTelegramInitData(initData, c.env.TELEGRAM_BOT_TOKEN);

  if (!valid || !user) {
    return c.json({ error: "initData inválido o alterado" }, 401);
  }

  c.set("telegramUser", user);
  await next();
}
