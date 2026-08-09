import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { telegramAuthMiddleware, TelegramUser } from "./middleware/telegram-auth";
import users from "./routes/users";
import creatures from "./routes/creatures";

const app = new Hono<{ Bindings: Env; Variables: { telegramUser: TelegramUser } }>();

// CORS: en producción, cambia "*" por el dominio real de tu Cloudflare Pages
// (ej. "https://mundo-de-criaturas.pages.dev") para que solo tu frontend
// pueda llamar a esta API.
app.use("*", cors({ origin: "*" }));

// Healthcheck simple, sin autenticación - útil para confirmar que el
// Worker está desplegado y respondiendo antes de probar nada más.
app.get("/health", (c) => c.json({ status: "ok", service: "mundo-de-criaturas-api" }));

// Todo lo que empiece con /api requiere initData de Telegram válido.
app.use("/api/*", telegramAuthMiddleware);
app.route("/api/users", users);
app.route("/api/creatures", creatures);

export default app;