import os
import logging
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes

load_dotenv()
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def menu_principal():
    keyboard = [
        [InlineKeyboardButton("🥚 Mis Criaturas", callback_data="criaturas")],
        [InlineKeyboardButton("⚔️ Combates", callback_data="combates")],
        [InlineKeyboardButton("🏛️ Catacumbas", callback_data="catacumbas")],
        [InlineKeyboardButton("🏪 Tienda", callback_data="tienda")],
        [InlineKeyboardButton("💰 Retirar", callback_data="retirar")],
        [InlineKeyboardButton("📣 Referidos", callback_data="referidos")],
        [InlineKeyboardButton("⚙️ Configuración", callback_data="config")],
    ]
    return InlineKeyboardMarkup(keyboard)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    await update.message.reply_text(
        f"🎉 ¡Bienvenido a MUNDO DE CRIATURAS, {user.first_name}!\n\n"
        f"🐉 Cría, evoluciona y combate con criaturas únicas.\n"
        f"💰 Gana monedas y compite por premios en USD.\n\n"
        f"📌 Estado: Prototipo en desarrollo activo.\n"
        f"Versión: 0.1",
        reply_markup=menu_principal()
    )

async def menu_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    opciones = {
        "criaturas": "🥚 MIS CRIATURAS\n\nPróximamente.",
        "combates": "⚔️ COMBATES\n\nPróximamente.",
        "catacumbas": "🏛️ CATACUMBAS\n\nPróximamente.",
        "tienda": "🏪 TIENDA\n\nPróximamente.",
        "retirar": "💰 RETIRAR\n\nPróximamente.",
        "referidos": "📣 REFERIDOS\n\nPróximamente.",
        "config": "⚙️ CONFIGURACIÓN\n\nPróximamente."
    }
    await query.edit_message_text(
        opciones.get(query.data, "❌ Opción no disponible"),
        reply_markup=menu_principal()
    )

def main():
    if not TOKEN:
        logger.error("❌ No se encontró el token.")
        return
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(menu_callback))
    logger.info("🚀 Bot iniciado correctamente")
    app.run_polling()

if __name__ == "__main__":
    main()
