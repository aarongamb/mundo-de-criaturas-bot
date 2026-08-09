import { SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Motor Biológico - versión real, conectada a Supabase
// ============================================================================
// Misma fórmula validada en el prototipo: Dominancia + Heredabilidad + Mutación.
// Aquí opera sobre datos reales de la tabla `genes`, no sobre objetos de prueba.
// ============================================================================

export interface Gene {
  id: string;
  gene_code: string;
  name: string;
  dominance: number;
  heritability: number;
  mutation_probability: number;
}

export interface ResolvedGene {
  gene_id: string;
  resolved_euv_value: number;
  genetic_state: string;
  mutation_applied: boolean;
  father_euv_value: number | null;
  mother_euv_value: number | null;
}

// Obtiene los genes activos para un reino específico
export async function getActiveGenesForRealm(
  supabase: SupabaseClient,
  realmId: string
): Promise<Gene[]> {
  const { data, error } = await supabase
    .from("realm_gene_expression")
    .select("gene_id, is_active, genes(id, gene_code, name, dominance, heritability, mutation_probability)")
    .eq("realm_id", realmId)
    .eq("is_active", true);

  if (error) throw new Error(`Error obteniendo genes activos: ${error.message}`);

  return (data ?? [])
    .map((row: any) => row.genes)
    .filter(Boolean);
}

function resolveGeneValue(gene: Gene, fatherValue: number, motherValue: number): ResolvedGene {
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

  let state: string;
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

// Genera un genoma fundador (sin padres) - valores aleatorios uniformes 0-10.
// Usado para las primeras criaturas del juego, o capturas salvajes.
export async function generateFounderGenome(
  supabase: SupabaseClient,
  realmId: string
): Promise<ResolvedGene[]> {
  const genes = await getActiveGenesForRealm(supabase, realmId);

  return genes.map((gene) => ({
    gene_id: gene.id,
    resolved_euv_value: Math.floor(Math.random() * 11), // 0-10 inclusive
    genetic_state: "Activo",
    mutation_applied: false,
    father_euv_value: null,
    mother_euv_value: null,
  }));
}

// Cruza dos genomas existentes (padre x madre) y devuelve el genoma resuelto de la cría
export async function breedGenomes(
  supabase: SupabaseClient,
  fatherCreatureId: string,
  motherCreatureId: string,
  realmId: string
): Promise<ResolvedGene[]> {
  const genes = await getActiveGenesForRealm(supabase, realmId);

  const [{ data: fatherGenome, error: fatherErr }, { data: motherGenome, error: motherErr }] = await Promise.all([
    supabase.from("creature_genome").select("gene_id, resolved_euv_value").eq("creature_id", fatherCreatureId),
    supabase.from("creature_genome").select("gene_id, resolved_euv_value").eq("creature_id", motherCreatureId),
  ]);

  if (fatherErr) throw new Error(`Error leyendo genoma del padre: ${fatherErr.message}`);
  if (motherErr) throw new Error(`Error leyendo genoma de la madre: ${motherErr.message}`);

  const fatherMap = new Map((fatherGenome ?? []).map((g) => [g.gene_id, g.resolved_euv_value]));
  const motherMap = new Map((motherGenome ?? []).map((g) => [g.gene_id, g.resolved_euv_value]));

  const resolved: ResolvedGene[] = [];
  for (const gene of genes) {
    const fatherValue = fatherMap.get(gene.id);
    const motherValue = motherMap.get(gene.id);

    // Si alguno de los padres no tiene este gen registrado (dato incompleto),
    // no podemos cruzarlo con confianza - se omite en vez de adivinar.
    if (fatherValue === undefined || motherValue === undefined) continue;

    resolved.push(resolveGeneValue(gene, fatherValue, motherValue));
  }

  return resolved;
}