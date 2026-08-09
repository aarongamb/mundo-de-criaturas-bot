import { Hono } from "hono";
import type { Env } from "../types";
import type { TelegramUser } from "../middleware/telegram-auth";
import { getSupabaseClient } from "../db/supabase-client";
import { generateFounderGenome, breedGenomes } from "../game-logic/genetics";

const creatures = new Hono<{ Bindings: Env; Variables: { telegramUser: TelegramUser } }>();

// POST /api/creatures/founder
// body: { species_id: string, realm_name: string, nickname?: string }
// Crea una criatura fundadora (sin padres) con genoma aleatorio.
creatures.post("/founder", async (c) => {
  const telegramUser = c.get("telegramUser");
  const supabase = getSupabaseClient(c.env);
  const body = await c.req.json();

  if (!body.species_id || !body.realm_name) {
    return c.json({ error: "Falta species_id o realm_name" }, 400);
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("telegram_id", telegramUser.id)
    .single();

  if (userError || !user) {
    return c.json({ error: "Usuario no encontrado. Llama primero a /api/users/init" }, 404);
  }

  const { data: realm, error: realmError } = await supabase
    .from("realms")
    .select("id")
    .eq("name", body.realm_name)
    .single();

  if (realmError || !realm) {
    return c.json({ error: `Reino '${body.realm_name}' no encontrado` }, 404);
  }

  const { data: species, error: speciesError } = await supabase
    .from("species")
    .select("*")
    .eq("id", body.species_id)
    .single();

  if (speciesError || !species) {
    return c.json({ error: "Especie no encontrada" }, 404);
  }

  // Crear la criatura con las stats base de su especie
  const { data: creature, error: creatureError } = await supabase
    .from("creatures")
    .insert({
      owner_id: user.id,
      species_id: species.id,
      nickname: body.nickname ?? null,
      stage: "egg",
      hp: species.base_hp, str: species.base_str, mag: species.base_mag, agi: species.base_agi,
      def: species.base_def, rst: species.base_rst, int_stat: species.base_int, luk: species.base_luk,
      foc: species.base_foc, eva: species.base_eva, res: species.base_res, cha: species.base_cha,
    })
    .select()
    .single();

  if (creatureError || !creature) {
    return c.json({ error: "Error creando criatura", detail: creatureError?.message }, 500);
  }

  // Generar y guardar el genoma fundador
  const genome = await generateFounderGenome(supabase, realm.id);

  const genomeRows = genome.map((g) => ({
    creature_id: creature.id,
    gene_id: g.gene_id,
    resolved_euv_value: g.resolved_euv_value,
    genetic_state: g.genetic_state,
    mutation_applied: g.mutation_applied,
    father_euv_value: g.father_euv_value,
    mother_euv_value: g.mother_euv_value,
  }));

  const { error: genomeError } = await supabase.from("creature_genome").insert(genomeRows);

  if (genomeError) {
    return c.json({ error: "Criatura creada, pero falló guardar el genoma", detail: genomeError.message }, 500);
  }

  return c.json({ creature, genesCreated: genomeRows.length }, 201);
});

// POST /api/creatures/breed
// body: { father_id: string, mother_id: string, realm_name: string, nickname?: string }
creatures.post("/breed", async (c) => {
  const telegramUser = c.get("telegramUser");
  const supabase = getSupabaseClient(c.env);
  const body = await c.req.json();

  if (!body.father_id || !body.mother_id || !body.realm_name) {
    return c.json({ error: "Faltan father_id, mother_id o realm_name" }, 400);
  }

  const { data: user } = await supabase.from("users").select("id").eq("telegram_id", telegramUser.id).single();
  if (!user) return c.json({ error: "Usuario no encontrado" }, 404);

  const { data: realm } = await supabase.from("realms").select("id").eq("name", body.realm_name).single();
  if (!realm) return c.json({ error: `Reino '${body.realm_name}' no encontrado` }, 404);

  const { data: father } = await supabase.from("creatures").select("*, species(*)").eq("id", body.father_id).single();
  const { data: mother } = await supabase.from("creatures").select("*").eq("id", body.mother_id).single();

  if (!father || !mother) {
    return c.json({ error: "Padre o madre no encontrados" }, 404);
  }

  // Cruzar genomas con la fórmula real (Dominancia + Heredabilidad + Mutación)
  const offspringGenome = await breedGenomes(supabase, father.id, mother.id, realm.id);

  const { data: offspring, error: offspringError } = await supabase
    .from("creatures")
    .insert({
      owner_id: user.id,
      species_id: father.species_id,
      nickname: body.nickname ?? null,
      stage: "egg",
      // Stats base heredadas de la especie del padre por ahora;
      // el cálculo real vía Motor Fenotípico (genoma -> stats) es el siguiente paso pendiente.
      hp: father.species.base_hp, str: father.species.base_str, mag: father.species.base_mag,
      agi: father.species.base_agi, def: father.species.base_def, rst: father.species.base_rst,
      int_stat: father.species.base_int, luk: father.species.base_luk, foc: father.species.base_foc,
      eva: father.species.base_eva, res: father.species.base_res, cha: father.species.base_cha,
    })
    .select()
    .single();

  if (offspringError || !offspring) {
    return c.json({ error: "Error creando la cría", detail: offspringError?.message }, 500);
  }

  const genomeRows = offspringGenome.map((g) => ({
    creature_id: offspring.id,
    gene_id: g.gene_id,
    resolved_euv_value: g.resolved_euv_value,
    genetic_state: g.genetic_state,
    mutation_applied: g.mutation_applied,
    father_euv_value: g.father_euv_value,
    mother_euv_value: g.mother_euv_value,
  }));

  const { error: genomeError } = await supabase.from("creature_genome").insert(genomeRows);

  if (genomeError) {
    return c.json({ error: "Cría creada, pero falló guardar el genoma", detail: genomeError.message }, 500);
  }

  // Registrar el evento de cría (auditoría)
  await supabase.from("breeding_events").insert({
    mother_creature_id: mother.id,
    father_creature_id: father.id,
    offspring_creature_id: offspring.id,
    fertility_check_passed: true,
    viability_passed: true,
  });

  return c.json({ offspring, genesInherited: genomeRows.length }, 201);
});

export default creatures;