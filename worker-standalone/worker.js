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
  return genes.map((gene) => ({
    gene_id: gene.id,
    gene_code: gene.gene_code,
    resolved_euv_value: Math.floor(Math.random() * 11),
    genetic_state: "Activo",
    mutation_applied: false,
    father_euv_value: null,
    mother_euv_value: null,
  }));
}

async function breedGenomes(env, fatherCreatureId, motherCreatureId, realmId) {
  const genes = await getActiveGenesForRealm(env, realmId);

  const [fatherGenome, motherGenome] = await Promise.all([
    supabaseRequest(env, `creature_genome?creature_id=eq.${fatherCreatureId}&select=gene_id,resolved_euv_value`),
    supabaseRequest(env, `creature_genome?creature_id=eq.${motherCreatureId}&select=gene_id,resolved_euv_value`),
  ]);

  const fatherMap = new Map(fatherGenome.map((g) => [g.gene_id, g.resolved_euv_value]));
  const motherMap = new Map(motherGenome.map((g) => [g.gene_id, g.resolved_euv_value]));

  const resolved = [];
  for (const gene of genes) {
    const fatherValue = fatherMap.get(gene.id);
    const motherValue = motherMap.get(gene.id);
    if (fatherValue === undefined || motherValue === undefined) continue;
    resolved.push({ ...resolveGeneValue(gene, fatherValue, motherValue), gene_code: gene.gene_code });
  }
  return resolved;
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
  const vdEstabilidad = avgVal([g("B033"), g("B002"), g("B006"), g("B005")]);
  const vdIntegridad = avgVal([g("B017"), invVal(g("B014")), invVal(g("B013")), g("B010"), g("B012"), g("B011")]);

  const SCALE = 3;
  return {
    str: Math.round((vdCalidad - 5) * SCALE + (vdPeso - 5) * SCALE * 0.5),
    def: Math.round((vdCalidad - 5) * SCALE),
    agi: Math.round((vdEstabilidad - 5) * SCALE - (vdPeso - 5) * SCALE * 0.5),
    rst: Math.round((vdIntegridad - 5) * SCALE),
  };
}

function applyDeltasToSpeciesBase(species, deltas) {
  const clamp = (v) => Math.max(1, Math.min(100, v));
  return {
    hp: species.base_hp,
    str: clamp(species.base_str + (deltas.str || 0)),
    mag: species.base_mag,
    agi: clamp(species.base_agi + (deltas.agi || 0)),
    def: clamp(species.base_def + (deltas.def || 0)),
    rst: clamp(species.base_rst + (deltas.rst || 0)),
    int_stat: species.base_int,
    luk: species.base_luk,
    foc: species.base_foc,
    eva: species.base_eva,
    res: species.base_res,
    cha: species.base_cha,
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

        const users = await supabaseRequest(env, `users?telegram_id=eq.${telegramUser.id}&select=id`);
        if (users.length === 0) return json({ error: "Usuario no encontrado. Llama primero a /api/users/init" }, 404);
        const userId = users[0].id;

        const realms = await supabaseRequest(env, `realms?name=eq.${body.realm_name}&select=id`);
        if (realms.length === 0) return json({ error: `Reino '${body.realm_name}' no encontrado` }, 404);
        const realmId = realms[0].id;

        const speciesRows = await supabaseRequest(env, `species?id=eq.${body.species_id}&select=*`);
        if (speciesRows.length === 0) return json({ error: "Especie no encontrada" }, 404);
        const species = speciesRows[0];

        const genome = await generateFounderGenome(env, realmId);
        const genomeByCode = buildGenomeByCode(genome);
        const deltas = calculateBlockBStatDeltas(genomeByCode);
        const finalStats = applyDeltasToSpeciesBase(species, deltas);

        const createdCreature = await supabaseRequest(env, "creatures", {
          method: "POST",
          body: {
            owner_id: userId, species_id: species.id, nickname: body.nickname ?? null, stage: "egg",
            ...finalStats,
          },
        });
        const creature = createdCreature[0];

        const genomeRows = genome.map((g) => ({
          creature_id: creature.id, gene_id: g.gene_id, resolved_euv_value: g.resolved_euv_value,
          genetic_state: g.genetic_state, mutation_applied: g.mutation_applied,
          father_euv_value: g.father_euv_value, mother_euv_value: g.mother_euv_value,
        }));
        await supabaseRequest(env, "creature_genome", { method: "POST", body: genomeRows, prefer: "return=minimal" });

        return json({ creature, genesCreated: genomeRows.length, derivedStatDeltas: deltas }, 201);
      }

      if (path === "/api/creatures/breed" && request.method === "POST") {
        const body = await request.json();
        if (!body.father_id || !body.mother_id || !body.realm_name) {
          return json({ error: "Faltan father_id, mother_id o realm_name" }, 400);
        }

        const users = await supabaseRequest(env, `users?telegram_id=eq.${telegramUser.id}&select=id`);
        if (users.length === 0) return json({ error: "Usuario no encontrado" }, 404);
        const userId = users[0].id;

        const realms = await supabaseRequest(env, `realms?name=eq.${body.realm_name}&select=id`);
        if (realms.length === 0) return json({ error: `Reino '${body.realm_name}' no encontrado` }, 404);
        const realmId = realms[0].id;

        const fatherRows = await supabaseRequest(env, `creatures?id=eq.${body.father_id}&select=*,species(*)`);
        const motherRows = await supabaseRequest(env, `creatures?id=eq.${body.mother_id}&select=*`);
        if (fatherRows.length === 0 || motherRows.length === 0) return json({ error: "Padre o madre no encontrados" }, 404);
        const father = fatherRows[0];
        const mother = motherRows[0];

        const offspringGenome = await breedGenomes(env, father.id, mother.id, realmId);
        const genomeByCode = buildGenomeByCode(offspringGenome);
        const deltas = calculateBlockBStatDeltas(genomeByCode);
        const finalStats = applyDeltasToSpeciesBase(father.species, deltas);

        const createdOffspring = await supabaseRequest(env, "creatures", {
          method: "POST",
          body: {
            owner_id: userId, species_id: father.species_id, nickname: body.nickname ?? null, stage: "egg",
            ...finalStats,
          },
        });
        const offspring = createdOffspring[0];

        const genomeRows = offspringGenome.map((g) => ({
          creature_id: offspring.id, gene_id: g.gene_id, resolved_euv_value: g.resolved_euv_value,
          genetic_state: g.genetic_state, mutation_applied: g.mutation_applied,
          father_euv_value: g.father_euv_value, mother_euv_value: g.mother_euv_value,
        }));
        await supabaseRequest(env, "creature_genome", { method: "POST", body: genomeRows, prefer: "return=minimal" });

        await supabaseRequest(env, "breeding_events", {
          method: "POST",
          prefer: "return=minimal",
          body: {
            mother_creature_id: mother.id, father_creature_id: father.id, offspring_creature_id: offspring.id,
            fertility_check_passed: true, viability_passed: true,
          },
        });

        return json({ offspring, genesInherited: genomeRows.length, derivedStatDeltas: deltas }, 201);
      }

      return json({ error: "Ruta no encontrada" }, 404);
    } catch (err) {
      return json({ error: "Error interno", detail: err.message }, 500);
    }
  },
};