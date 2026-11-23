/**
 * Política de los bloques de un apunte modular.
 *
 * Tres reglas que no dependen del modelo ni de la base:
 *
 *   1. **Lo que el alumno ha editado no se sobrescribe.** Ni al regenerar la
 *      sección, ni al desarrollar el tema entero, ni al pedir una variante.
 *   2. **Máximo dos niveles de anidamiento** (bloque raíz → variante → variante
 *      de la variante). Más profundo deja de ser un apunte y se convierte en un
 *      hilo de chat.
 *   3. **Una sección solo está COMPLETED si tiene contenido propio**, no por el
 *      hecho de haber intentado generarla.
 *
 * Módulo puro: se prueba sin base de datos y sin red (`verify:lienzo`).
 */

export const MAX_BLOCK_DEPTH = 2;

export type VariantKind = 'simpler' | 'example' | 'deeper';

export const VARIANT_KINDS: Record<
  VariantKind,
  { label: string; heading: string; instruction: string }
> = {
  simpler: {
    label: 'Más sencillo',
    heading: 'Explicación más sencilla',
    instruction:
      'Explica lo mismo con palabras llanas y una analogía cotidiana. No añadas contenido nuevo que no esté en el bloque ni en la fuente.',
  },
  example: {
    label: 'Un ejemplo',
    heading: 'Ejemplo',
    instruction:
      'Añade un ejemplo concreto y resuelto paso a paso, usando solo los datos y el método de la fuente. Si la fuente no permite un ejemplo numérico, usa uno cualitativo y dilo.',
  },
  deeper: {
    label: 'Más profundo',
    heading: 'Ampliación',
    instruction:
      'Profundiza en el porqué del bloque: hipótesis, condiciones de aplicación y errores típicos. Lo que no conste en la fuente se marca como «no consta».',
  },
};

export interface BlockLike {
  id: string;
  parentId: string | null;
  order: number;
  type: string;
  content: string;
  isEdited: boolean;
  isAiGenerated: boolean;
  chunkId: string | null;
  quote: string | null;
  quoteStatus: string;
}

/** Profundidad del bloque: raíz = 0, variante = 1, variante de variante = 2. */
export function blockDepth(
  blockId: string | null,
  byId: ReadonlyMap<string, Pick<BlockLike, 'id' | 'parentId'>>
): number {
  let depth = 0;
  let current = blockId;
  const seen = new Set<string>();

  while (current) {
    if (seen.has(current)) return Number.POSITIVE_INFINITY; // ciclo corrupto
    seen.add(current);
    const block = byId.get(current);
    if (!block) return Number.POSITIVE_INFINITY;
    depth += 1;
    current = block.parentId;
  }

  // Se cuentan **aristas**, no nodos: la raíz está a profundidad 0 y una
  // variante de una variante (dos niveles) a profundidad 2.
  return Math.max(0, depth - 1);
}

/** ¿Se le puede pedir una variante a este bloque? */
export function canAddVariant(
  parentId: string,
  byId: ReadonlyMap<string, Pick<BlockLike, 'id' | 'parentId'>>
): { ok: true } | { ok: false; reason: string } {
  const parent = byId.get(parentId);
  if (!parent) return { ok: false, reason: 'Ese bloque ya no está en el apunte.' };

  const depth = blockDepth(parentId, byId);
  if (!Number.isFinite(depth)) {
    return { ok: false, reason: 'La estructura del apunte está rota: no se puede ampliar.' };
  }
  if (depth >= MAX_BLOCK_DEPTH) {
    return {
      ok: false,
      reason: `Solo se permiten ${MAX_BLOCK_DEPTH} niveles de ampliación.`,
    };
  }
  return { ok: true };
}

/** Variante que se puede colgar de un bloque de profundidad `depth`. */
export function variantDepthFor(parentDepth: number): number {
  return parentDepth + 1;
}

export interface MergeResult<T extends BlockLike> {
  /** Bloques editados por el alumno que se conservan tal cual. */
  kept: T[];
  /** Bloques nuevos que sustituyen a los generados no editados. */
  added: T[];
  /** Bloques generados que se descartan por estar editados. */
  discarded: number;
}

/**
 * Ids que no se pueden borrar: los editados **y sus antecesores**. Si se borra
 * el bloque padre de una variante que el alumno editó, la cascada se lleva por
 * delante su trabajo. Esto lo evita sin tocar la base.
 */
export function preservedBlockIds(blocks: readonly BlockLike[]): Set<string> {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const keep = new Set<string>();

  for (const block of blocks) {
    if (!block.isEdited) continue;
    let current: BlockLike | undefined = block;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      keep.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }

  return keep;
}

/**
 * Mezcla una generación nueva con lo que ya había en la sección.
 *
 * No muta nada: devuelve las dos listas y el llamador decide cómo guardarlas.
 * Los editados se conservan **siempre**, aunque la generación venga vacía.
 */
export function mergeGeneratedBlocks<T extends BlockLike>(
  existing: readonly T[],
  generated: readonly T[],
  options: { preserveIds?: ReadonlySet<string> } = {}
): MergeResult<T> {
  const kept = existing
    .filter((block) => block.isEdited || Boolean(options.preserveIds?.has(block.id)))
    .slice()
    .sort((a, b) => a.order - b.order);

  // Un bloque generado que coincide con uno conservado no se duplica: se
  // compara por id (el modelo no inventa ids) y se descarta.
  const keptIds = new Set(kept.map((block) => block.id));
  const added = generated.filter((block) => !keptIds.has(block.id));
  const discarded = generated.filter((block) => keptIds.has(block.id)).length;

  return { kept, added, discarded };
}

/** Estado de la sección tras desarrollar: COMPLETED solo si hay contenido. */
export function sectionStatusAfterExpansion(blocks: readonly BlockLike[]): 'COMPLETED' | 'PENDING' {
  return blocks.some((block) => block.content.trim().length > 0) ? 'COMPLETED' : 'PENDING';
}

/** Bloques raíz (los que no cuelgan de otro), en orden. */
export function rootBlocks<T extends BlockLike>(blocks: readonly T[]): T[] {
  return blocks
    .filter((block) => block.parentId === null)
    .slice()
    .sort((a, b) => a.order - b.order);
}

/** Hijos directos de un bloque, en orden. */
export function childBlocks<T extends BlockLike>(blocks: readonly T[], parentId: string): T[] {
  return blocks
    .filter((block) => block.parentId === parentId)
    .slice()
    .sort((a, b) => a.order - b.order);
}
