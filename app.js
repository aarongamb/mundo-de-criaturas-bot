============================================
// MUNDO DE CRIATURAS - app.js
// ============================================

// =============================
// 1. CONFIGURACIÓN DE SUPABASE
// =============================

// Estos valores los obtienes de tu proyecto en Supabase:
// - Settings → API → Project URL
// - Settings → API → anon public key
const SUPABASE_URL = "https://szybzqmbmoxjyltordow.supabase.co";
const SUPABASE_KEY = "sb_publishable_D7n8jTiYATYJB8fZvlxUJQ_-iWEgunu";

// =============================
// 2. DATOS DEL JUGADOR (simulados por ahora)
// =============================

// Más adelante estos datos vendrán de Supabase
// Por ahora usamos valores de ejemplo para ver la interfaz

const jugador = {
    nombre: "ShadowRider",
    nivel: 37,
    monedas: 12450,
    experiencia: 84 // porcentaje hacia el siguiente nivel
};

// =============================
// 3. MOSTRAR DATOS EN PANTALLA
// =============================

function actualizarUI() {
    // Nombre
    const nombreElement = document.getElementById("playerName");
    if (nombreElement) {
        nombreElement.textContent = jugador.nombre;
    }

    // Nivel
    const nivelElement = document.getElementById("playerLevel");
    if (nivelElement) {
        nivelElement.textContent = jugador.nivel;
    }

    // Monedas (formateadas con separador de miles)
    const monedasElement = document.getElementById("playerCoins");
    if (monedasElement) {
        monedasElement.textContent = jugador.monedas.toLocaleString();
    }
}

// =============================
// 4. INTERACCIÓN CON EL MENÚ
// =============================

document.addEventListener("DOMContentLoaded", function() {

    // Actualizar la interfaz con los datos del jugador
    actualizarUI();

    // Escuchar clics en los elementos del menú
    const menuItems = document.querySelectorAll(".menu-item");
    
    menuItems.forEach(item => {
        item.addEventListener("click", function() {
            const seccion = this.getAttribute("data-section");
            const nombreSeccion = this.querySelector(".menu-label")?.textContent || seccion;
            
            // Mostrar un mensaje temporal (más adelante esto abrirá la sección real)
            alert(`🛠️ Sección "${nombreSeccion}" en construcción.\nPróximamente disponible.`);
        });
    });

    console.log("✅ Mundo de Criaturas - Interfaz cargada correctamente");
});