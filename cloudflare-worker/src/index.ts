/*
 * MUNDO DE CRIATURAS
 * Worker único de producción.
 *
 * El motor funcional consolidado procede de worker-standalone/worker.js.
 * Se conserva como módulo interno para evitar duplicar o perder lógica.
 */

import standaloneWorker from "./standalone-engine.js";

export default standaloneWorker;
