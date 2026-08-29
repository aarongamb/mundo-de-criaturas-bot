async function supabaseRequest(env, path, options = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": options.prefer || "return=representation",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new Error(`Supabase error (${res.status}): ${text}`);
  }
  return data;
}

// --- Validación de entradas del usuario antes de usarlas en filtros REST ---
// Nada de lo que manda el jugador debe llegar directo a una URL de Supabase
// sin pasar por aquí primero.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9_]{1,64}$/i;

function isValidUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function isValidSlug(value) {
  return typeof value === "string" && SLUG_RE.test(value);
}

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return { valid: false, user: null };
  params.delete("hash");

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKeyBuffer = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const computedHashBuffer = await hmacSha256(secretKeyBuffer, dataCheckString);
  const computedHash = bufferToHex(computedHashBuffer);

  if (computedHash !== receivedHash) return { valid: false, user: null };

  const userRaw = params.get("user");
  const user = userRaw ? JSON.parse(userRaw) : null;
  return { valid: true, user };
}

async function getActiveGenesForRealm(env, realmId) {
  const rows = await supabaseRequest(
    env,
    `realm_gene_expression?realm_id=eq.${realmId}&is_active=eq.true&select=gene_id,genes(id,gene_code,name,dominance,heritability,mutation_probability)`
  );
  return rows.map((r) => r.genes).filter(Boolean);
}

function resolveGeneValue(gene, fatherValue, motherValue) {
  const higher = Math.max(fatherValue, motherValue);
  const avg = (fatherValue + motherValue) / 2;
  const fromFather = fatherValue >= motherValue;

  const dominanceFactor = gene.dominance / 10;
  const baseValue = avg + dominanceFactor * (higher - avg);

  const heritabilityFactor = gene.heritability / 10;
  const environmentalNoise = Math.random() * 10;
  let preMutationValue = baseValue * heritabilityFactor + environmentalNoise * (1 - heritabilityFactor);

  let mutationApplied = false;
  if (Math.random() < gene.mutation_probability) {
    mutationApplied = true;
    const shift = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 3);
    preMutationValue += shift;
  }

  const finalValue = Math.max(0, Math.min(10, Math.round(preMutationValue)));

  let state;
  if (mutationApplied) state = "Mutado";
  else if (dominanceFactor >= 0.7) state = fromFather ? "Dominante_padre" : "Dominante_madre";
  else if (dominanceFactor <= 0.3) state = "Codominante";
  else state = "Dominancia_incompleta";

  return {
    gene_id: gene.id,
    resolved_euv_value: finalValue,
    genetic_state: state,
    mutation_applied: mutationApplied,
    father_euv_value: fatherValue,
    mother_euv_value: motherValue,
  };
}

async function generateFounderGenome(env, realmId) {
  const genes = await getActiveGenesForRealm(env, realmId);
  return genes.map((gene) => {
    if (CODIGOS_GEN_ELEMENTO.has(gene.gene_code)) {
      return {
        gene_id: gene.id, gene_code: gene.gene_code,
        resolved_euv_value: null, resolved_element_index: elegirElementoPonderado(),
        genetic_state: "Activo", mutation_applied: false,
        father_euv_value: null, mother_euv_value: null,
      };
    }
    return {
      gene_id: gene.id, gene_code: gene.gene_code,
      resolved_euv_value: Math.floor(Math.random() * 11), resolved_element_index: null,
      genetic_state: "Activo", mutation_applied: false,
      father_euv_value: null, mother_euv_value: null,
    };
  });
}

async function breedGenomes(env, fatherCreatureId, motherCreatureId, realmId) {
  const genes = await getActiveGenesForRealm(env, realmId);

  const [fatherGenome, motherGenome] = await Promise.all([
    supabaseRequest(env, `creature_genome?creature_id=eq.${fatherCreatureId}&select=resolved_euv_value,resolved_element_index,genes(id,gene_code)`),
    supabaseRequest(env, `creature_genome?creature_id=eq.${motherCreatureId}&select=resolved_euv_value,resolved_element_index,genes(id,gene_code)`),
  ]);

  const fatherByGeneId = new Map();
  const fatherByCode = new Map();
  for (const row of fatherGenome) {
    if (!row.genes) continue;
    fatherByGeneId.set(row.genes.id, row);
    fatherByCode.set(row.genes.gene_code, row);
  }
  const motherByGeneId = new Map();
  const motherByCode = new Map();
  for (const row of motherGenome) {
    if (!row.genes) continue;
    motherByGeneId.set(row.genes.id, row);
    motherByCode.set(row.genes.gene_code, row);
  }

  // Estabilidad de afinidad (K007) de cada padre, usada para pesar la herencia
  // categórica de elemento. Si no existe todavía (no está activo en este reino), 5 neutral.
  const estabilidadPadre = fatherByCode.get("K007")?.resolved_euv_value ?? 5;
  const estabilidadMadre = motherByCode.get("K007")?.resolved_euv_value ?? 5;

  const resolved = [];
  for (const gene of genes) {
    const fatherRow = fatherByGeneId.get(gene.id);
    const motherRow = motherByGeneId.get(gene.id);
    if (fatherRow === undefined || motherRow === undefined) continue;

    if (CODIGOS_GEN_ELEMENTO.has(gene.gene_code)) {
      const r = resolverElementoHeredado(
        fatherRow.resolved_element_index, estabilidadPadre,
        motherRow.resolved_element_index, estabilidadMadre,
        gene.mutation_probability
      );
      resolved.push({
        gene_id: gene.id, gene_code: gene.gene_code,
        resolved_euv_value: null, resolved_element_index: r.indice,
        genetic_state: r.mutado ? "Mutado" : "Activo", mutation_applied: r.mutado,
        father_euv_value: null, mother_euv_value: null,
      });
      continue;
    }

    const fatherValue = fatherRow.resolved_euv_value;
    const motherValue = motherRow.resolved_euv_value;
    if (fatherValue === undefined || motherValue === undefined) continue;
    resolved.push({ ...resolveGeneValue(gene, fatherValue, motherValue), gene_code: gene.gene_code, resolved_element_index: null });
  }
  return resolved;
}

// --- Herencia CATEGÓRICA para elemento principal/secundario/terciario (K001/K002/K003) ---
// Estos 3 genes NO se promedian como el resto del genoma: "cuál elemento" no es un
// número continuo, es una elección. Hereda el elemento de uno de los dos padres
// (con más peso hacia el de mayor Estabilidad de afinidad, gen K007), con una
// probabilidad real de mutación que salta a un elemento al azar -- PERO no con
// probabilidad pareja: los elementos místicos (Ultrararo/Legendario/Único) están
// fuertemente sub-representados a propósito, para que sean de verdad excepcionales.
const CODIGOS_GEN_ELEMENTO = new Set(["K001", "K002", "K003"]);

// order_index -> peso, según la Escala de Rareza oficial del documento maestro (R01-R07).
// R01 Común (11 físicos): 10000. R04 Épico (Luz=8,Sonido=13,Gravedad=14): 300.
// R05 Legendario (Oscuridad=9,Psíquico=12,Espacio=15): 20. R06 Mítico (Sagrado=10,Maldito=11,Vacío=21): 3.
// R07 Primordial (Tiempo=16,Caos=17,Destino=22): 1. (R02 Poco común y R03 Raro no son
// elementos propios -- surgen de combinar 2 o 3 elementos Comunes distintos en K001/K002/K003.)
const PESO_ELEMENTO_POR_INDICE = {
  0: 10000, 1: 10000, 2: 10000, 3: 10000, 4: 10000, 5: 10000, 6: 10000, 7: 10000, 18: 10000, 19: 10000, 20: 10000,
  8: 300, 13: 300, 14: 300,
  9: 20, 12: 20, 15: 20,
  10: 3, 11: 3, 21: 3,
  16: 1, 17: 1, 22: 1,
};
const PESO_TOTAL_ELEMENTOS = Object.values(PESO_ELEMENTO_POR_INDICE).reduce((a, b) => a + b, 0);

function elegirElementoPonderado() {
  let azar = Math.random() * PESO_TOTAL_ELEMENTOS;
  for (const [indice, peso] of Object.entries(PESO_ELEMENTO_POR_INDICE)) {
    if (azar < peso) return Number(indice);
    azar -= peso;
  }
  return 0; // fallback, no debería alcanzarse
}

function resolverElementoHeredado(indiceElementoPadre, estabilidadPadre, indiceElementoMadre, estabilidadMadre, probabilidadMutacion) {
  if (Math.random() < probabilidadMutacion) {
    return { indice: elegirElementoPonderado(), mutado: true };
  }
  const pesoTotal = Math.max(0.001, estabilidadPadre + estabilidadMadre);
  const azar = Math.random() * pesoTotal;
  const heredaDelPadre = azar < estabilidadPadre;
  return { indice: heredaDelPadre ? indiceElementoPadre : indiceElementoMadre, mutado: false };
}

// --- Clasificación de Rareza (R01-R07), basada en los 3 genes de afinidad elemental ---
const TIER_POR_INDICE_ELEMENTO = {
  0: "Común", 1: "Común", 2: "Común", 3: "Común", 4: "Común", 5: "Común", 6: "Común", 7: "Común", 18: "Común", 19: "Común", 20: "Común",
  8: "Épico", 13: "Épico", 14: "Épico",
  9: "Legendario", 12: "Legendario", 15: "Legendario",
  10: "Mítico", 11: "Mítico", 21: "Mítico",
  16: "Primordial", 17: "Primordial", 22: "Primordial",
};
const RANGO_TIER = { "Común": 0, "Poco común": 1, "Raro": 2, "Épico": 3, "Legendario": 4, "Mítico": 5, "Primordial": 6 };

function clasificarRareza(indiceK001, indiceK002, indiceK003) {
  const tiers = [indiceK001, indiceK002, indiceK003].map((i) => TIER_POR_INDICE_ELEMENTO[i] ?? "Común");
  const masAlto = tiers.reduce((max, t) => (RANGO_TIER[t] > RANGO_TIER[max] ? t : max), "Común");
  if (masAlto !== "Común") return masAlto;
  const distintos = new Set([indiceK001, indiceK002, indiceK003]).size;
  if (distintos === 1) return "Común";
  if (distintos === 2) return "Poco común";
  return "Raro";
}

async function obtenerClasificacionCriatura(env, creatureId) {
  const rows = await supabaseRequest(
    env,
    `creature_genome?creature_id=eq.${creatureId}&select=resolved_element_index,genes(gene_code)`
  );
  const porCodigo = {};
  for (const r of rows) {
    if (r.genes?.gene_code) porCodigo[r.genes.gene_code] = r.resolved_element_index;
  }
  if (porCodigo.K001 == null || porCodigo.K002 == null || porCodigo.K003 == null) return null;
  const rareza = clasificarRareza(porCodigo.K001, porCodigo.K002, porCodigo.K003);
  return { rareza, nivelTope: TOPE_NIVEL_POR_TIER[rareza] };
}

// --- Sistema de Nivel: tope por rareza + curva de experiencia ---
// El tope depende de la categoría de rareza REAL del individuo (no de la especie),
// bajando 10 por categoría desde el máximo. Cada 10 niveles se desbloquea una
// habilidad intrínseca de la especie (tabla species_abilities).
const TOPE_NIVEL_POR_TIER = {
  "Común": 40, "Poco común": 50, "Raro": 60,
  "Épico": 70, "Legendario": 80, "Mítico": 90, "Primordial": 100,
};

// Curva de experiencia real (no lineal): exp_necesaria(nivel) = 0.1825 * nivel^3.
// Calibrada para que nivel 100 (solo alcanzable por Primordial) tome ~1 año real
// de juego activo, asumiendo ~500 XP/día -- ESTE SUPUESTO DE 500 XP/día ES LO ÚNICO
// AJUSTABLE; si cambia, toda la curva se recalibra sola cambiando XP_POR_DIA_ASUMIDO.
// La misma fórmula, aplicada al tope de cada categoría, reparte la dificultad sola:
// Común tarda ~23 días en tocar su tope (40), Primordial tarda ~365 en tocar el suyo (100).
const XP_POR_DIA_ASUMIDO = 500;
const DIAS_OBJETIVO_NIVEL_100 = 365;
const EXPONENTE_CURVA = 3;
const COEFICIENTE_CURVA = (XP_POR_DIA_ASUMIDO * DIAS_OBJETIVO_NIVEL_100) / Math.pow(100, EXPONENTE_CURVA);

function expNecesariaParaNivel(nivel) {
  return Math.round(COEFICIENTE_CURVA * Math.pow(nivel, EXPONENTE_CURVA));
}

function calcularNivelDesdeExp(expActual, topeNivel) {
  let nivel = 1;
  while (nivel < topeNivel && expActual >= expNecesariaParaNivel(nivel + 1)) {
    nivel++;
  }
  return nivel;
}

// Ascenso automático de nivel: cuando un jugador hace un descubrimiento novedoso para
// la comunidad o gana un evento, la criatura sube 1 nivel de inmediato, sin importar
// su experiencia acumulada -- pero nunca por encima del tope de su categoría.
async function otorgarNivelPorLogro(env, creatureId, motivo) {
  const rows = await supabaseRequest(env, `creatures?id=eq.${creatureId}&select=id,level,current_exp,species_id`);
  if (rows.length === 0) throw new Error("Criatura no encontrada para otorgar nivel");
  const creature = rows[0];

  const clasificacion = await obtenerClasificacionCriatura(env, creatureId);
  const topeNivel = clasificacion ? clasificacion.nivelTope : 40;

  if (creature.level >= topeNivel) {
    return { subioNivel: false, nivel: creature.level, motivo, razon: "Ya está en su nivel tope" };
  }

  const nuevoNivel = creature.level + 1;
  const expMinimaParaNuevoNivel = expNecesariaParaNivel(nuevoNivel);
  const nuevoExp = Math.max(creature.current_exp, expMinimaParaNuevoNivel);

  await supabaseRequest(env, `creatures?id=eq.${creatureId}`, {
    method: "PATCH", prefer: "return=minimal",
    body: { level: nuevoNivel, current_exp: nuevoExp },
  });

  const habilidades = await obtenerHabilidadesDesbloqueadas(env, creature.species_id, creature.level, nuevoNivel);
  return { subioNivel: true, nivel: nuevoNivel, motivo, habilidadesDesbloqueadas: habilidades };
}

async function obtenerHabilidadesDesbloqueadas(env, speciesId, nivelAnterior, nivelNuevo) {
  if (nivelNuevo <= nivelAnterior) return [];
  const umbrales = [];
  for (let u = Math.ceil((nivelAnterior + 1) / 10) * 10; u <= nivelNuevo; u += 10) umbrales.push(u);
  if (umbrales.length === 0) return [];
  const filtro = umbrales.join(",");
  return supabaseRequest(env, `species_abilities?species_id=eq.${speciesId}&level_threshold=in.(${filtro})&select=*`);
}

function avgVal(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function invVal(v) {
  return 10 - v;
}

function buildGenomeByCode(resolvedGenomeArray) {
  const map = {};
  for (const g of resolvedGenomeArray) {
    if (g.gene_code) map[g.gene_code] = g.resolved_euv_value;
  }
  return map;
}

function calculateBlockBStatDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const vdPeso = avgVal([g("B001"), g("B002"), g("B035"), g("B036")]);
  const vdCalidad = avgVal([g("B003"), invVal(g("B013")), invVal(g("B014")), g("B034"), g("B017")]);
  const vdEstabilidad = avgVal([g("B033"), g("B002"), g("B006"), g("B005"), g("A016")]);
  const vdIntegridad = avgVal([g("B017"), invVal(g("B014")), invVal(g("B013")), g("B010"), g("B012"), g("B011")]);
  const SCALE = 30;
  return {
    str: Math.round((vdCalidad - 5) * SCALE + (vdPeso - 5) * SCALE * 0.5),
    def: Math.round((vdCalidad - 5) * SCALE),
    agi: Math.round((vdEstabilidad - 5) * SCALE - (vdPeso - 5) * SCALE * 0.5),
    rst: Math.round((vdIntegridad - 5) * SCALE),
  };
}

function calculateBlockCStatDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const vdProteccion = avgVal([g("C002"), g("C003"), g("C004"), g("C019")]);
  const vdAislamiento = avgVal([g("C016"), g("C017"), g("C018"), g("C002")]);
  const vdMantenimiento = avgVal([g("C025"), g("C026")]);
  const SCALE = 30;
  return {
    def: Math.round((vdProteccion - 5) * SCALE),
    res: Math.round((vdAislamiento - 5) * SCALE),
    rst: Math.round((vdMantenimiento - 5) * SCALE * 0.5),
    agi: Math.round(-(g("C002") - 5) * SCALE * 0.3),
  };
}

function calculateBlockEStatDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const vdPotencia = avgVal([g("E002"), g("E003"), g("E009"), g("B003"), g("A013")]);
  const vdEficiencia = avgVal([invVal(g("E018")), g("E020"), g("E011"), g("E019")]);
  const vdRendimiento = avgVal([g("E009"), g("E013"), g("E014"), g("E020"), g("E023")]);
  const SCALE = 30;
  return {
    str: Math.round((vdPotencia - 5) * SCALE),
    agi: Math.round((vdRendimiento - 5) * SCALE * 0.4),
    foc: Math.round((vdRendimiento - 5) * SCALE * 0.3),
    eva: Math.round((vdRendimiento - 5) * SCALE * 0.3),
    rst: Math.round((vdEficiencia - 5) * SCALE * 0.5),
  };
}

function calculateBlockFStatDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const vdEficiencia = avgVal([g("F003"), g("F011"), invVal(g("F007")), g("F020"), g("F025")]);
  const vdResistencia = avgVal([g("F014"), g("F015"), g("F022"), g("F025")]);
  const vdBalance = avgVal([g("F005"), invVal(g("F008"))]);
  const SCALE = 30;
  return {
    rst: Math.round((vdEficiencia - 5) * SCALE * 0.5 + (vdResistencia - 5) * SCALE * 0.5),
    res: Math.round((vdResistencia - 5) * SCALE * 0.5),
    hp: Math.round((vdBalance - 5) * SCALE * 1.2),
  };
}

function calculateBlockGStatDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const vdRendimiento = avgVal([g("G003"), g("G005"), g("G027"), invVal(g("G025")), g("G004")]);
  const vdAdaptabilidad = avgVal([g("G011"), g("G012"), g("G013"), g("G014"), g("G024")]);
  const SCALE = 30;
  return {
    agi: Math.round((vdRendimiento - 5) * SCALE),
    eva: Math.round((vdAdaptabilidad - 5) * SCALE * 0.3),
  };
}

function calculateBlockIStatDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const vdCapacidad = avgVal([g("I003"), g("I004"), g("I005"), g("I027")]);
  const vdConciencia = avgVal([g("I019"), g("I029"), g("I021")]);
  const SCALE = 30;
  return {
    foc: Math.round((vdCapacidad - 5) * SCALE),
    eva: Math.round((vdConciencia - 5) * SCALE * 0.3),
  };
}

function calculateBlockJStatDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const vdAmbiental = avgVal([g("J001"), g("J002"), g("J003"), g("J005"), g("J010")]);
  const vdBiologica = avgVal([g("J015"), g("J017"), g("J007")]);
  const vdMagica = avgVal([g("J014"), g("J013"), g("J024"), g("J027")]);
  const SCALE = 30;
  return {
    res: Math.round((vdAmbiental - 5) * SCALE * 0.4 + (vdMagica - 5) * SCALE * 0.3),
    rst: Math.round((vdBiologica - 5) * SCALE * 0.4),
  };
}

function calculateBlockKStatDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const vdDominio = avgVal([g("K004"), g("K015"), g("K016"), g("K017"), g("K018")]);
  const vdPotencial = avgVal([g("K001"), g("K009"), g("K030"), g("K029")]);
  const SCALE = 30;
  return {
    mag: Math.round((vdDominio - 5) * SCALE + (vdPotencial - 5) * SCALE * 0.5),
  };
}

function calculateBlockLStatDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const vdInteligencia = avgVal([g("L010"), g("L012"), g("L007")]);
  const SCALE = 30;
  return {
    int_stat: Math.round((vdInteligencia - 5) * SCALE),
  };
}

function calculateBlockAStatDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const vdTamano = avgVal([g("A001"), g("A002"), g("A003"), g("A004"), g("A005"), g("A013")]);
  const vdProporcion = avgVal([g("A008"), g("A018"), g("A010"), g("A011")]);
  const SCALE = 30;
  return {
    hp: Math.round((vdTamano - 5) * SCALE * 0.8),
    str: Math.round((vdTamano - 5) * SCALE * 0.5),
    agi: Math.round(-(vdTamano - 5) * SCALE * 0.4 + (vdProporcion - 5) * SCALE * 0.3),
  };
}

function calculateBlockALukChaDeltas(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const SCALE = 30;
  return {
    cha: Math.round((g("A031") - 5) * SCALE),
    luk: Math.round((g("A032") - 5) * SCALE),
  };
}

// Penalización real por discordancia fenotípica: masa corporal alta (Bloque A)
// combinada con densidad estructural baja (Bloque B) representa un esqueleto
// que no puede soportar el propio cuerpo de la criatura.
function calculatePhenotypicDiscordancePenalties(genomeByCode) {
  const g = (code) => genomeByCode[code] ?? 5;
  const masa = g("A013");
  const densidadEstructural = g("B002");
  const desajuste = Math.max(0, masa - densidadEstructural);
  if (desajuste === 0) return { hp: 0, def: 0 };
  const SCALE = 30;
  return {
    hp: -Math.round(desajuste * SCALE * 0.6),
    def: -Math.round(desajuste * SCALE * 0.4),
  };
}

function sumDeltas(...deltaObjects) {
  const total = {};
  for (const deltas of deltaObjects) {
    for (const [stat, value] of Object.entries(deltas)) {
      total[stat] = (total[stat] || 0) + value;
    }
  }
  return total;
}

function calculateAllPhenotypeDeltas(genomeByCode) {
  return sumDeltas(
    calculateBlockAStatDeltas(genomeByCode),
    calculateBlockALukChaDeltas(genomeByCode),
    calculatePhenotypicDiscordancePenalties(genomeByCode),
    calculateBlockBStatDeltas(genomeByCode),
    calculateBlockCStatDeltas(genomeByCode),
    calculateBlockEStatDeltas(genomeByCode),
    calculateBlockFStatDeltas(genomeByCode),
    calculateBlockGStatDeltas(genomeByCode),
    calculateBlockIStatDeltas(genomeByCode),
    calculateBlockJStatDeltas(genomeByCode),
    calculateBlockKStatDeltas(genomeByCode),
    calculateBlockLStatDeltas(genomeByCode)
  );
}

function applyDeltasToSpeciesBase(species, deltas) {
  const clamp = (v) => Math.max(1, Math.min(9999, v));
  return {
    hp: clamp(species.base_hp + (deltas.hp || 0)),
    str: clamp(species.base_str + (deltas.str || 0)),
    mag: clamp(species.base_mag + (deltas.mag || 0)),
    agi: clamp(species.base_agi + (deltas.agi || 0)),
    def: clamp(species.base_def + (deltas.def || 0)),
    rst: clamp(species.base_rst + (deltas.rst || 0)),
    int_stat: clamp(species.base_int + (deltas.int_stat || 0)),
    luk: clamp(species.base_luk + (deltas.luk || 0)),
    foc: clamp(species.base_foc + (deltas.foc || 0)),
    eva: clamp(species.base_eva + (deltas.eva || 0)),
    res: clamp(species.base_res + (deltas.res || 0)),
    cha: clamp(species.base_cha + (deltas.cha || 0)),
  };
}

// ============================================================
// FERTILIDAD REAL, CONSANGUINIDAD REAL, VALIDACIÓN DE REINO
// (agregado — antes esto no existía, fertility_check_passed
// estaba puesto en `true` fijo sin comprobar nada)
// ============================================================

// Sube por el árbol genealógico usando breeding_events.
// Devuelve un mapa: { creatureId: generación } hasta la profundidad indicada.
async function getAncestryMap(env, creatureId, maxDepth = 5) {
  const ancestry = new Map();
  let frontier = [creatureId];
  let generation = 0;

  while (frontier.length > 0 && generation < maxDepth) {
    generation++;
    const idsFilter = frontier.map((id) => `"${id}"`).join(",");
    const events = await supabaseRequest(
      env,
      `breeding_events?offspring_creature_id=in.(${idsFilter})&select=offspring_creature_id,father_creature_id,mother_creature_id`
    );

    const nextFrontier = [];
    for (const ev of events) {
      if (ev.father_creature_id && !ancestry.has(ev.father_creature_id)) {
        ancestry.set(ev.father_creature_id, generation);
        nextFrontier.push(ev.father_creature_id);
      }
      if (ev.mother_creature_id && !ancestry.has(ev.mother_creature_id)) {
        ancestry.set(ev.mother_creature_id, generation);
        nextFrontier.push(ev.mother_creature_id);
      }
    }
    frontier = nextFrontier;
  }
  return ancestry;
}

// Fórmula estándar de genética de poblaciones (simplificada, asumiendo que los
// ancestros compartidos no están ya emparentados entre sí):
// F = suma, por cada ancestro común, de (1/2)^(n1 + n2 + 1)
async function calculateInbreedingCoefficient(env, fatherId, motherId) {
  if (fatherId === motherId) return 1;

  const [fatherAncestry, motherAncestry] = await Promise.all([
    getAncestryMap(env, fatherId),
    getAncestryMap(env, motherId),
  ]);

  fatherAncestry.set(fatherId, 0);
  motherAncestry.set(motherId, 0);

  let coefficient = 0;
  for (const [ancestorId, n1] of fatherAncestry.entries()) {
    if (motherAncestry.has(ancestorId)) {
      const n2 = motherAncestry.get(ancestorId);
      coefficient += Math.pow(0.5, n1 + n2 + 1);
    }
  }

  return Math.min(1, Math.round(coefficient * 10000) / 10000);
}

async function getReproductiveGeneValues(env, creatureId) {
  const rows = await supabaseRequest(
    env,
    `creature_genome?creature_id=eq.${creatureId}&select=resolved_euv_value,genes(gene_code)`
  );
  const byCode = {};
  for (const r of rows) {
    if (r.genes?.gene_code) byCode[r.genes.gene_code] = r.resolved_euv_value;
  }
  return {
    madurez: byCode["H004"] ?? 5,
    compatibilidad: byCode["H003"] ?? 5,
    limiteBiologico: byCode["H030"] ?? 5,
    compatibilidadInterespecifica: byCode["H029"] ?? 5,
  };
}

// Edad real en días. Si la criatura no tiene fila todavía (creada antes de
// este parche), se crea con born_at = ahora.
async function getRealAgeInDays(env, creatureId) {
  const rows = await supabaseRequest(env, `creature_age?creature_id=eq.${creatureId}&select=born_at`);
  let bornAt;
  if (rows.length === 0) {
    const created = await supabaseRequest(env, "creature_age", {
      method: "POST",
      body: { creature_id: creatureId },
    });
    bornAt = created[0].born_at;
  } else {
    bornAt = rows[0].born_at;
  }
  const ageMs = Date.now() - new Date(bornAt).getTime();
  return ageMs / (1000 * 60 * 60 * 24);
}

// No existe una lista de cruces "prohibidos": todo cruce dentro del MISMO
// REINO se puede intentar, sea la misma especie o no — la consanguinidad y
// la compatibilidad genética empujan la viabilidad hacia abajo hasta volverla,
// en la práctica, casi imposible en casos extremos. Lo único bloqueado de
// forma dura es cruzar entre reinos distintos (no tiene lógica biológica real).
async function checkFertility(env, father, mother) {
  if (father.species.realm_id !== mother.species.realm_id) {
    return {
      passed: false,
      reason: "Reinos distintos: no existen cruces entre reinos (Dragones, Plantas, Minerales Vivos, Gemas Vivas, Microorganismos son mundos genéticos separados).",
      inbreedingCoefficient: null,
      viabilityScore: 0,
    };
  }

  const sameSpecies = father.species_id === mother.species_id;
  const inbreedingCoefficient = await calculateInbreedingCoefficient(env, father.id, mother.id);

  const [fatherGenes, motherGenes, fatherAgeDays, motherAgeDays] = await Promise.all([
    getReproductiveGeneValues(env, father.id),
    getReproductiveGeneValues(env, mother.id),
    getRealAgeInDays(env, father.id),
    getRealAgeInDays(env, mother.id),
  ]);

  // Madurez y ciclo de vida: cada especie tiene sus propios días base
  // (species.base_maturity_days / species.base_lifespan_days), ajustados
  // por el gen H004 de cada individuo. base_lifespan_days = NULL significa
  // inmortal (Minerales Vivos, Gemas Vivas) y nunca aplica techo de edad.
  const fatherFactor = Math.max(0.1, fatherGenes.madurez / 5);
  const motherFactor = Math.max(0.1, motherGenes.madurez / 5);

  const madurezRequeridaFather = father.species.base_maturity_days / fatherFactor;
  const madurezRequeridaMother = mother.species.base_maturity_days / motherFactor;
  const fatherMaduro = fatherAgeDays >= madurezRequeridaFather;
  const motherMaduro = motherAgeDays >= madurezRequeridaMother;

  const fatherLifespanLimit = father.species.base_lifespan_days == null
    ? Infinity
    : father.species.base_lifespan_days / fatherFactor;
  const motherLifespanLimit = mother.species.base_lifespan_days == null
    ? Infinity
    : mother.species.base_lifespan_days / motherFactor;
  const fatherDemasiadoViejo = fatherAgeDays > fatherLifespanLimit;
  const motherDemasiadoVieja = motherAgeDays > motherLifespanLimit;

  const madurezFactor = fatherMaduro && motherMaduro && !fatherDemasiadoViejo && !motherDemasiadoVieja ? 1 : 0;

  const compatibilidadFactor = (fatherGenes.compatibilidad + motherGenes.compatibilidad) / 20;

  const interespecificaFactor = sameSpecies
    ? 1
    : (fatherGenes.compatibilidadInterespecifica + motherGenes.compatibilidadInterespecifica) / 20;

  const limiteFactor = Math.min(fatherGenes.limiteBiologico, motherGenes.limiteBiologico) / 10;

  // F=0 -> sin penalización | F=0.0625 primos | F=0.125 medio-hermanos/abuelo-nieto
  // F=0.25 padre-hijo/hermanos completos | F>=0.375 prácticamente inviable
  const inbreedingPenalty = 1 - Math.pow(inbreedingCoefficient / 0.5, 1.3);
  const inbreedingFactor = Math.max(0, inbreedingPenalty);

  const viabilityScore =
    madurezFactor * compatibilidadFactor * interespecificaFactor * limiteFactor * inbreedingFactor;

  // Tirada final: incluso con viabilidad baja, no es matemáticamente imposible
  // (igual que en la vida real), solo muy improbable.
  const roll = Math.random();
  const passed = roll < viabilityScore;

  let reason = null;
  if (!passed) {
    if (fatherDemasiadoViejo || motherDemasiadoVieja) {
      reason = "Al menos uno de los dos ya superó su ciclo de vida natural y no puede reproducirse.";
    } else if (!fatherMaduro || !motherMaduro) {
      reason = "Al menos uno de los dos no alcanzó la madurez reproductiva real todavía.";
    } else {
      reason = `Viabilidad genética insuficiente (score=${viabilityScore.toFixed(3)}, consanguinidad=${inbreedingCoefficient}).`;
    }
  }

  return {
    passed,
    reason,
    inbreedingCoefficient,
    viabilityScore: Math.round(viabilityScore * 10000) / 10000,
  };
}

const DEBUG_SECRET = "mundo-debug-2026-temporal";

const TEST_PAGE_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mundo de Criaturas - Panel de prueba</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 16px; background: #111; color: #eee; }
  h1 { font-size: 20px; }
  button { display: block; width: 100%; padding: 14px; margin: 8px 0; font-size: 16px; border-radius: 8px; border: none; background: #2563eb; color: white; }
  button:disabled { background: #555; }
  input { width: 100%; padding: 10px; margin: 4px 0; border-radius: 6px; border: 1px solid #555; background: #222; color: #eee; box-sizing: border-box; }
  pre { background: #000; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; }
  label { font-size: 13px; color: #aaa; }
</style>
</head>
<body>
  <h1>🐉 Mundo de Criaturas - Panel de prueba</h1>
  <p style="color:#f59e0b">⚠️ Solo para pruebas. No usar en producción.</p>

  <label>ID de especie (Dragón Común)</label>
  <input id="speciesId" value="" placeholder="Pega aquí el ID de la especie">

  <button onclick="initUser()">1. Inicializar usuario de prueba</button>
  <button onclick="createFounder('father')">2. Crear criatura fundadora (padre)</button>
  <button onclick="createFounder('mother')">3. Crear criatura fundadora (madre)</button>
  <button onclick="breed()">4. Cruzar padre x madre</button>

  <h3>Resultado:</h3>
  <pre id="output">Aquí aparecerán los resultados...</pre>

  <script>
    const state = { fatherId: null, motherId: null };
    const output = document.getElementById('output');

    function log(label, data) {
      output.textContent = label + ':\\n' + JSON.stringify(data, null, 2);
    }

    async function apiCall(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Secret': '${DEBUG_SECRET}' },
        body: JSON.stringify(body || {}),
      });
      return res.json();
    }

    async function initUser() {
      const data = await apiCall('/api/users/init', {});
      log('Usuario inicializado', data);
    }

    async function createFounder(role) {
      const speciesId = document.getElementById('speciesId').value.trim();
      if (!speciesId) { alert('Pega el ID de la especie primero'); return; }
      const data = await apiCall('/api/creatures/founder', { species_id: speciesId, realm_name: 'dragones', nickname: role === 'father' ? 'Padre de prueba' : 'Madre de prueba' });
      log('Criatura fundadora creada (' + role + ')', data);
      if (data.creature) {
        if (role === 'father') state.fatherId = data.creature.id;
        else state.motherId = data.creature.id;
      }
    }

    async function breed() {
      if (!state.fatherId || !state.motherId) { alert('Primero crea el padre y la madre (botones 2 y 3)'); return; }
      const data = await apiCall('/api/creatures/breed', { father_id: state.fatherId, mother_id: state.motherId, realm_name: 'dragones', nickname: 'Cría de prueba' });
      log('Cría generada', data);
    }
  </script>
</body>
</html>`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
        },
      });
    }

    if (path === "/health") {
      return json({ status: "ok", service: "mundo-de-criaturas-api" });
    }

    if (path === "/test") {
      return new Response(TEST_PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (!path.startsWith("/api/")) {
      return json({ error: "Ruta no encontrada" }, 404);
    }

    let telegramUser;
    const debugSecret = request.headers.get("X-Debug-Secret");

    if (debugSecret === DEBUG_SECRET) {
      telegramUser = { id: 999999999, username: "debug_tester" };
    } else {
      const initData = request.headers.get("X-Telegram-Init-Data");
      if (!initData) return json({ error: "Falta X-Telegram-Init-Data" }, 401);

      const { valid, user } = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
      if (!valid || !user) return json({ error: "initData inválido o alterado" }, 401);
      telegramUser = user;
    }

    try {
      if (path === "/api/users/init" && request.method === "POST") {
        const existing = await supabaseRequest(env, `users?telegram_id=eq.${telegramUser.id}&select=*`);
        if (existing.length > 0) {
          return json({ user: existing[0], isNewUser: false });
        }
        const created = await supabaseRequest(env, "users", {
          method: "POST",
          body: { telegram_id: telegramUser.id, username: telegramUser.username ?? telegramUser.first_name ?? "Jugador" },
        });
        return json({ user: created[0], isNewUser: true }, 201);
      }

      if (path === "/api/creatures/founder" && request.method === "POST") {
        const body = await request.json();
        if (!body.species_id || !body.realm_name) {
          return json({ error: "Falta species_id o realm_name" }, 400);
        }
        if (!isValidUuid(body.species_id)) {
          return json({ error: "species_id inválido" }, 400);
        }
        if (!isValidSlug(body.realm_name)) {
          return json({ error: "realm_name inválido" }, 400);
        }

        const users = await supabaseRequest(env, `users?telegram_id=eq.${telegramUser.id}&select=id`);
        if (users.length === 0) return json({ error: "Usuario no encontrado. Llama primero a /api/users/init" }, 404);
        const userId = users[0].id;

        const realms = await supabaseRequest(env, `realms?name=eq.${body.realm_name}&select=id`);
        if (realms.length === 0) return json({ error: `Reino '${body.realm_name}' no encontrado` }, 404);
        const realmId = realms[0].id;

        const speciesRows = await supabaseRequest(env, `species?id=eq.${body.species_id}&select=*`);
        if (speciesRows.length === 0) return json({ error: "Especie no encontrada" }, 404);
        const species = speciesRows[0];

        // Verificación real: la especie debe pertenecer al reino que se está pidiendo.
        if (species.realm_id !== realmId) {
          return json({ error: "Esa especie no pertenece al reino indicado" }, 400);
        }

        const genome = await generateFounderGenome(env, realmId);
        const genomeByCode = buildGenomeByCode(genome);
        const deltas = calculateAllPhenotypeDeltas(genomeByCode);
        const finalStats = applyDeltasToSpeciesBase(species, deltas);

        const createdCreature = await supabaseRequest(env, "creatures", {
          method: "POST",
          body: {
            owner_id: userId, species_id: species.id, nickname: body.nickname ?? null, stage: "egg",
            ...finalStats,
          },
        });
        const creature = createdCreature[0];

        // A partir de aquí, si algo falla, la criatura ya creada queda huérfana
        // (sin genoma, sin edad) a menos que la deshagamos nosotros mismos.
        try {
          const genomeRows = genome.map((g) => ({
            creature_id: creature.id, gene_id: g.gene_id, resolved_euv_value: g.resolved_euv_value,
            resolved_element_index: g.resolved_element_index,
            genetic_state: g.genetic_state, mutation_applied: g.mutation_applied,
            father_euv_value: g.father_euv_value, mother_euv_value: g.mother_euv_value,
          }));
          await supabaseRequest(env, "creature_genome", { method: "POST", body: genomeRows, prefer: "return=minimal" });

          await supabaseRequest(env, "creature_age", {
            method: "POST", prefer: "return=minimal",
            body: { creature_id: creature.id },
          });

          const clasificacion = await obtenerClasificacionCriatura(env, creature.id);

          return json({ creature, genesCreated: genomeRows.length, derivedStatDeltas: deltas, clasificacion }, 201);
        } catch (innerErr) {
          // Deshacer: sin esto, la criatura queda huérfana en la base para siempre.
          await supabaseRequest(env, `creatures?id=eq.${creature.id}`, { method: "DELETE", prefer: "return=minimal" }).catch(() => {});
          throw innerErr;
        }
      }

      if (path === "/api/creatures/breed" && request.method === "POST") {
        const body = await request.json();
        if (!body.father_id || !body.mother_id || !body.realm_name) {
          return json({ error: "Faltan father_id, mother_id o realm_name" }, 400);
        }
        if (!isValidUuid(body.father_id) || !isValidUuid(body.mother_id)) {
          return json({ error: "father_id o mother_id inválidos" }, 400);
        }
        if (!isValidSlug(body.realm_name)) {
          return json({ error: "realm_name inválido" }, 400);
        }

        const users = await supabaseRequest(env, `users?telegram_id=eq.${telegramUser.id}&select=id`);
        if (users.length === 0) return json({ error: "Usuario no encontrado" }, 404);
        const userId = users[0].id;

        const realms = await supabaseRequest(env, `realms?name=eq.${body.realm_name}&select=id`);
        if (realms.length === 0) return json({ error: `Reino '${body.realm_name}' no encontrado` }, 404);
        const realmId = realms[0].id;

        const fatherRows = await supabaseRequest(env, `creatures?id=eq.${body.father_id}&select=*,species(*)`);
        const motherRows = await supabaseRequest(env, `creatures?id=eq.${body.mother_id}&select=*,species(*)`);
        if (fatherRows.length === 0 || motherRows.length === 0) return json({ error: "Padre o madre no encontrados" }, 404);
        const father = fatherRows[0];
        const mother = motherRows[0];

        // ---- CHEQUEO REAL DE FERTILIDAD ----
        const fertility = await checkFertility(env, father, mother);
        if (!fertility.passed) {
          if (fertility.inbreedingCoefficient !== null) {
            await supabaseRequest(env, "breeding_events", {
              method: "POST",
              prefer: "return=minimal",
              body: {
                mother_creature_id: mother.id, father_creature_id: father.id, offspring_creature_id: null,
                inbreeding_coefficient: fertility.inbreedingCoefficient,
                fertility_check_passed: false, viability_passed: false,
              },
            });
          }
          return json({ error: "Cruce no viable", detail: fertility.reason, fertility }, 422);
        }
        // ---- FIN DEL CHEQUEO ----

        const offspringGenome = await breedGenomes(env, father.id, mother.id, realmId);
        const genomeByCode = buildGenomeByCode(offspringGenome);
        const deltas = calculateAllPhenotypeDeltas(genomeByCode);
        const finalStats = applyDeltasToSpeciesBase(father.species, deltas);

        const createdOffspring = await supabaseRequest(env, "creatures", {
          method: "POST",
          body: {
            owner_id: userId, species_id: father.species_id, nickname: body.nickname ?? null, stage: "egg",
            ...finalStats,
          },
        });
        const offspring = createdOffspring[0];

        // A partir de aquí, si algo falla, la cría queda huérfana a menos que la deshagamos.
        try {
          const genomeRows = offspringGenome.map((g) => ({
            creature_id: offspring.id, gene_id: g.gene_id, resolved_euv_value: g.resolved_euv_value,
            resolved_element_index: g.resolved_element_index,
            genetic_state: g.genetic_state, mutation_applied: g.mutation_applied,
            father_euv_value: g.father_euv_value, mother_euv_value: g.mother_euv_value,
          }));
          await supabaseRequest(env, "creature_genome", { method: "POST", body: genomeRows, prefer: "return=minimal" });

          await supabaseRequest(env, "creature_age", {
            method: "POST", prefer: "return=minimal",
            body: { creature_id: offspring.id },
          });

          await supabaseRequest(env, "breeding_events", {
            method: "POST",
            prefer: "return=minimal",
            body: {
              mother_creature_id: mother.id, father_creature_id: father.id, offspring_creature_id: offspring.id,
              inbreeding_coefficient: fertility.inbreedingCoefficient,
              fertility_check_passed: true, viability_passed: true,
            },
          });

          return json({ offspring, genesInherited: genomeRows.length, derivedStatDeltas: deltas, fertility, clasificacion: await obtenerClasificacionCriatura(env, offspring.id) }, 201);
        } catch (innerErr) {
          // Deshacer: sin esto, la cría queda huérfana en la base para siempre.
          await supabaseRequest(env, `creatures?id=eq.${offspring.id}`, { method: "DELETE", prefer: "return=minimal" }).catch(() => {});
          throw innerErr;
        }
      }

      if (path === "/api/creatures/award-level" && request.method === "POST") {
        const body = await request.json();
        if (!body.creature_id || !body.motivo) {
          return json({ error: "Falta creature_id o motivo" }, 400);
        }
        if (!isValidUuid(body.creature_id)) {
          return json({ error: "creature_id inválido" }, 400);
        }
        const resultado = await otorgarNivelPorLogro(env, body.creature_id, body.motivo);
        return json(resultado, 200);
      }

      return json({ error: "Ruta no encontrada" }, 404);
    } catch (err) {
      return json({ error: "Error interno", detail: err.message }, 500);
    }
  },
};
