
import os
import logging
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes
from supabase import create_client, Client

# Cargar variables de entorno
load_dotenv()
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

# Configurar logs
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Inicializar Supabase
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# =============================
# WEB APP URL (cambia esto si cambia tu URL)
# =============================
WEBAPP_URL = "https://glittery-souffle-30a2d9.netlify.app/"

# =============================
# MENÚ PRINCIPAL (con Web App)
# =============================
def menu_principal():
    keyboard = [
        [InlineKeyboardButton(
            "🎮 Abrir Mundo de Criaturas",
            web_app=WebAppInfo(url=WEBAPP_URL)
        )],
        [InlineKeyboardButton("❓ Ayuda", callback_data="ayuda")]
    ]
    return InlineKeyboardMarkup(keyboard)

# =============================
# COMANDO /start
# =============================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    telegram_id = user.id
    nombre = user.first_name

    # Verificar si el usuario existe en la base de datos
    response = supabase.table("usuarios").select("*").eq("telegram_id", telegram_id).execute()

    if not response.data:
        nuevo_usuario = {
            "telegram_id": telegram_id,
            "nombre": nombre,
            "monedas": 1000,
            "nivel": 1
        }
        supabase.table("usuarios").insert(nuevo_usuario).execute()
        logger.info(f"✅ Nuevo usuario registrado: {nombre} (ID: {telegram_id})")

    await update.message.reply_text(
        f"🎉 ¡Bienvenido a MUNDO DE CRIATURAS, {nombre}!\n\n"
        f"🐉 Toca el botón de abajo para abrir el juego.\n"
        f"💰 Tus monedas: {response.data[0]['monedas'] if response.data else 1000}\n\n"
        f"⚡ Versión 0.3 — Web App integrada",
        reply_markup=menu_principal()
    )

# =============================
# CALLBACK PARA AYUDA
# =============================
async def menu_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    await query.edit_message_text(
        "❓ AYUDA\n\n"
        "1. Toca 'Abrir Mundo de Criaturas' para entrar al juego.\n"
        "2. Allí podrás ver tu criatura, alimentarla y combatir.\n"
        "3. Gana monedas y sube de nivel.\n\n"
        "¡Pronto más funciones!",
        reply_markup=menu_principal()
    )

# =============================
# CONFIGURAR EL BOT
# =============================
def main():
    if not TOKEN:
        logger.error("❌ No se encontró el token de Telegram")
        return

    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(menu_callback))

    logger.info("🚀 Bot iniciado correctamente")
    logger.info(f"🌐 Web App URL: {WEBAPP_URL}")
    app.run_polling()

if __name__ == "__main__":
    main()