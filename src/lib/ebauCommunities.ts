/**
 * Estructura del simulacro EBAU por comunidad autónoma.
 *
 * Esto es una **plantilla de trabajo**, no una promesa de que todas las
 * materias de esa comunidad se examinen exactamente así: la EBAU cambia por
 * materia, por curso y por convocatoria, y el modelo oficial del tribunal
 * siempre manda. Lo que sí fija esta tabla es lo que el simulador necesita para
 * no generar un examen de 90 minutos igual para todo el país:
 *
 *   - cuánto dura la prueba,
 *   - cuántos bloques lleva y cuánto vale cada uno,
 *   - si hay opciones A/B y cuántas se eligen,
 *   - cuánto pesa la notación y cuánto resta cada fallo formal.
 *
 * El catedrático recibe además las instrucciones concretas de la materia y del
 * profesor, así que adapta el enunciado a lo que de verdad cae en su centro.
 *
 * Módulo puro: lo importan tanto el servidor como el selector del examinador.
 */

export interface EbauCommunity {
  code: string;
  name: string;
  short: string;
  durationMinutes: number;
  blocks: number;
  pointsPerBlock: number;
  /** Número de opciones entre las que se elige (0 = examen único). */
  options: number;
  choiceRule: string;
  /** Peso de la notación/unidades dentro de la nota (0-1). */
  notationWeight: number;
  /** Puntos que resta cada fallo de notación (sobre 10). */
  notationPenalty: number;
  summary: string;
}

const BASE: Omit<EbauCommunity, 'code' | 'name' | 'short' | 'summary'> = {
  durationMinutes: 90,
  blocks: 4,
  pointsPerBlock: 2.5,
  options: 2,
  choiceRule: 'Dos opciones (A y B); el alumno elige una y responde solo a sus bloques.',
  notationWeight: 0.1,
  notationPenalty: 0.25,
};

function community(
  code: string,
  name: string,
  short: string,
  summary: string,
  overrides: Partial<EbauCommunity> = {}
): EbauCommunity {
  return { ...BASE, code, name, short, summary, ...overrides };
}

export const EBAU_COMMUNITIES: EbauCommunity[] = [
  community(
    'madrid',
    'Comunidad de Madrid',
    'Madrid',
    'Cuatro bloques de 2,5 puntos, dos opciones y notación penalizada en los apartados formales.'
  ),
  community(
    'cataluna',
    'Cataluña',
    'Cataluña',
    'Examen con dos opciones, bloques de 2,5 puntos y corrección estricta de notación y unidades.'
  ),
  community(
    'andalucia',
    'Andalucía',
    'Andalucía',
    'Cuatro bloques y dos opciones; se exige justificar cada paso y cuidar la presentación.'
  ),
  community(
    'valenciana',
    'Comunitat Valenciana',
    'Valencia',
    'Dos opciones con cuatro bloques; los errores de notación descuentan en el apartado correspondiente.'
  ),
  community(
    'galicia',
    'Galicia',
    'Galicia',
    'Prueba de 90 minutos con dos opciones y cuatro bloques; notación y unidades dentro de la rúbrica.'
  ),
  community(
    'castilla-leon',
    'Castilla y León',
    'Castilla y León',
    'Cuatro bloques de 2,5 puntos con dos opciones; se penaliza el resultado sin justificar.'
  ),
  community(
    'pais-vasco',
    'País Vasco',
    'País Vasco',
    'Examen con opciones y cuatro bloques; la corrección valora el razonamiento y la notación.'
  ),
  community(
    'aragon',
    'Aragón',
    'Aragón',
    'Dos opciones y cuatro bloques; los fallos de notación restan dentro del bloque.'
  ),
  community(
    'murcia',
    'Región de Murcia',
    'Murcia',
    'Cuatro bloques de 2,5 puntos; se exige desarrollo justificado y notación correcta.'
  ),
  community(
    'canarias',
    'Canarias',
    'Canarias',
    'Examen de 90 minutos con dos opciones y cuatro bloques; la presentación cuenta.'
  ),
];

/** Madrid es la comunidad por defecto del perfil si no hay ninguna elegida. */
export const DEFAULT_EBAU_COMMUNITY = 'madrid';

export function getEbauCommunity(code: string | null | undefined): EbauCommunity {
  const normalized = String(code ?? '').trim().toLowerCase();
  return (
    EBAU_COMMUNITIES.find((community) => community.code === normalized) ??
    EBAU_COMMUNITIES[0]
  );
}

export function isEbauCommunity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    EBAU_COMMUNITIES.some((community) => community.code === value.trim().toLowerCase())
  );
}

/** Línea corta para prompts y tarjetas: «Madrid · 90 min · 4 × 2,5». */
export function communityStructureLabel(community: EbauCommunity): string {
  return `${community.name} · ${community.durationMinutes} min · ${community.blocks} × ${community.pointsPerBlock
    .toString()
    .replace('.', ',')} pts`;
}
