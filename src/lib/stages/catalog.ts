import type {
  EducationStage,
  StageConfig,
  StageGradeLevel,
  StageProfileLike,
  StageSelection,
  StageSubjectTemplate,
  StageSummary,
  StageTrack,
} from './types';

/**
 * Catálogo único de etapas.
 *
 * Reglas de oro:
 * - `modality` sigue siendo la cadena que guarda el curso exacto; estas
 *   funciones la interpretan y producen la selección canónica.
 * - Adding una etapa nueva es tocar SOLO este archivo y su plantilla.
 * - La inferencia es idempotente: pasar una `modality` ya canónica por
 *   `inferStageFromModality` devuelve lo mismo.
 */

const ESO_LEVELS: readonly StageGradeLevel[] = [
  { key: '1º ESO', label: '1º ESO' },
  { key: '2º ESO', label: '2º ESO' },
  { key: '3º ESO', label: '3º ESO' },
  { key: '4º ESO', label: '4º ESO' },
];

const BACH_LEVELS: readonly StageGradeLevel[] = [
  { key: '1º Bachillerato', label: '1º Bachillerato' },
  { key: '2º Bachillerato', label: '2º Bachillerato' },
];

const UNI_LEVELS: readonly StageGradeLevel[] = [
  { key: '1º curso', label: '1º curso' },
  { key: '2º curso', label: '2º curso' },
  { key: '3º curso', label: '3º curso' },
  { key: '4º curso', label: '4º curso' },
  { key: '5º curso', label: '5º curso' },
];

const BACH_TRACKS: readonly StageTrack[] = [
  {
    key: 'ciencias',
    label: 'Ciencias y Tecnología',
    hint: 'Matemáticas, Física, Química, Biología, Tecnología e Ingeniería.',
  },
  {
    key: 'humanidades',
    label: 'Humanidades y Ciencias Sociales',
    hint: 'Lengua, Literatura, Historia, Filosofía, Economía y Latín.',
  },
  {
    key: 'general',
    label: 'General',
    hint: 'Itinerario mixto de la LOMLOE, sin especialización cerrada.',
  },
];

const UNI_TRACKS: readonly StageTrack[] = [
  {
    key: 'ingenieria',
    label: 'Ingeniería y Arquitectura',
    hint: 'Cálculo, física, álgebra, materiales y proyecto técnico.',
  },
  {
    key: 'ciencias',
    label: 'Ciencias',
    hint: 'Matemáticas, física, química, biología y geología.',
  },
  {
    key: 'salud',
    label: 'Ciencias de la Salud',
    hint: 'Anatomía, fisiología, bioquímica, enfermería y medicina.',
  },
  {
    key: 'sociales',
    label: 'Ciencias Sociales y Jurídicas',
    hint: 'Derecho, economía, empresa, sociología y educación.',
  },
  {
    key: 'artes',
    label: 'Artes y Humanidades',
    hint: 'Historia del arte, literatura, filosofía, lenguas y música.',
  },
];

/**
 * Materias troncales orientativas por rama (3–5). Son una plantilla editable:
 * al activar Universidad se crean las que falten y el alumno puede añadir las
 * de su guía docente sin borrar nada.
 */
const UNI_TEMPLATES: Record<string, readonly StageSubjectTemplate[]> = {
  ingenieria: [
    { name: 'Cálculo I', color: '#3b82f6', credits: 6 },
    { name: 'Física I', color: '#0ea5e9', credits: 6 },
    { name: 'Álgebra Lineal', color: '#6366f1', credits: 6 },
    { name: 'Química General', color: '#f97316', credits: 6 },
  ],
  ciencias: [
    { name: 'Cálculo I', color: '#3b82f6', credits: 6 },
    { name: 'Física General', color: '#0ea5e9', credits: 6 },
    { name: 'Química General', color: '#f97316', credits: 6 },
    { name: 'Biología Celular', color: '#10b981', credits: 6 },
  ],
  salud: [
    { name: 'Anatomía Humana', color: '#ef4444', credits: 6 },
    { name: 'Bioquímica', color: '#10b981', credits: 6 },
    { name: 'Fisiología', color: '#ec4899', credits: 6 },
    { name: 'Estadística Aplicada', color: '#8b5cf6', credits: 6 },
  ],
  sociales: [
    { name: 'Introducción al Derecho', color: '#d97706', credits: 6 },
    { name: 'Economía', color: '#14b8a6', credits: 6 },
    { name: 'Estadística', color: '#8b5cf6', credits: 6 },
    { name: 'Historia Contemporánea', color: '#a855f7', credits: 6 },
  ],
  artes: [
    { name: 'Historia del Arte', color: '#d97706', credits: 6 },
    { name: 'Literatura Comparada', color: '#f59e0b', credits: 6 },
    { name: 'Filosofía', color: '#a855f7', credits: 6 },
    { name: 'Lengua y Comunicación', color: '#8b5cf6', credits: 6 },
  ],
};

/**
 * Materias base por curso de ESO. 1º conserva exactamente las nueve que ya
 * existían; 2º–4º siguen el currículo LOMLOE común y son plantillas editables.
 */
const ESO_TEMPLATES: Record<string, readonly StageSubjectTemplate[]> = {
  '1º ESO': [
    { name: 'Lengua Castellana y Literatura', color: '#f59e0b' },
    { name: 'Matemáticas', color: '#3b82f6' },
    { name: 'Geografía e Historia', color: '#d97706' },
    { name: 'Biología y Geología', color: '#10b981' },
    { name: 'Inglés', color: '#8b5cf6' },
    { name: 'Tecnología y Digitalización', color: '#06b6d4' },
    { name: 'Educación Física', color: '#ef4444' },
    { name: 'Música', color: '#ec4899' },
    { name: 'Educación Plástica', color: '#a855f7' },
  ],
  '2º ESO': [
    { name: 'Lengua Castellana y Literatura', color: '#f59e0b' },
    { name: 'Matemáticas', color: '#3b82f6' },
    { name: 'Geografía e Historia', color: '#d97706' },
    { name: 'Física y Química', color: '#f97316' },
    { name: 'Biología y Geología', color: '#10b981' },
    { name: 'Inglés', color: '#8b5cf6' },
    { name: 'Tecnología y Digitalización', color: '#06b6d4' },
    { name: 'Educación Física', color: '#ef4444' },
    { name: 'Música', color: '#ec4899' },
  ],
  '3º ESO': [
    { name: 'Lengua Castellana y Literatura', color: '#f59e0b' },
    { name: 'Matemáticas', color: '#3b82f6' },
    { name: 'Geografía e Historia', color: '#d97706' },
    { name: 'Biología y Geología', color: '#10b981' },
    { name: 'Física y Química', color: '#f97316' },
    { name: 'Inglés', color: '#8b5cf6' },
    { name: 'Tecnología y Digitalización', color: '#06b6d4' },
    { name: 'Educación Física', color: '#ef4444' },
    { name: 'Música', color: '#ec4899' },
  ],
  '4º ESO': [
    { name: 'Lengua Castellana y Literatura', color: '#f59e0b' },
    { name: 'Matemáticas A', color: '#3b82f6' },
    { name: 'Matemáticas B', color: '#2563eb' },
    { name: 'Geografía e Historia', color: '#d97706' },
    { name: 'Inglés', color: '#8b5cf6' },
    { name: 'Educación Física', color: '#ef4444' },
    { name: 'Biología y Geología', color: '#10b981' },
    { name: 'Física y Química', color: '#f97316' },
    { name: 'Economía', color: '#14b8a6' },
  ],
};

export const STAGE_CONFIGS: Record<EducationStage, StageConfig> = {
  ESO: {
    stage: 'ESO',
    label: 'ESO',
    pedagogyLabel: 'Educación Secundaria Obligatoria',
    scale: { kind: 'sobre10', max: 10, label: 'Nota /10', hasPau: false },
    planner: { capacityRatio: 0.7, minBlockMin: 10, maxBlocks: 4 },
    gradeLevels: ESO_LEVELS,
    tracks: [],
    tools: { hiddenHrefs: ['/examinador'], navBadge: 'ESO · LOMLOE' },
    supportsEcts: false,
    supportsConvocatorias: false,
    personality:
      'Ajustas el nivel al currículo oficial de la ESO: explicas desde cero, con ejemplos cotidianos, no das por sabidos contenidos de cursos superiores y preparas las pruebas del curso sin enfoque PAU. Exiges rigor, preguntas socráticas y trabajo diario.',
  },
  BACHILLERATO: {
    stage: 'BACHILLERATO',
    label: 'Bachillerato',
    pedagogyLabel: 'Bachillerato',
    scale: { kind: 'sobre14', max: 14, label: 'PAU /14', hasPau: true },
    planner: { capacityRatio: 0.7, minBlockMin: 15, maxBlocks: 5 },
    gradeLevels: BACH_LEVELS,
    tracks: BACH_TRACKS,
    tools: { hiddenHrefs: [], navBadge: 'Bachillerato & PAU' },
    supportsEcts: false,
    supportsConvocatorias: false,
    personality:
      'Explicas con rigor, preguntas socráticas y enfoque de preparación pre-PAU. Nota sobre 14, ponderaciones oficiales y criterios de corrección del tribunal.',
  },
  UNIVERSIDAD: {
    stage: 'UNIVERSIDAD',
    label: 'Universidad',
    pedagogyLabel: 'Universidad (Grado)',
    scale: { kind: 'sobre10', max: 10, label: 'Nota /10 · ECTS', hasPau: false },
    planner: { capacityRatio: 0.7, minBlockMin: 20, maxBlocks: 5 },
    gradeLevels: UNI_LEVELS,
    tracks: UNI_TRACKS,
    tools: { hiddenHrefs: ['/examinador'], navBadge: 'Universidad · Grado' },
    supportsEcts: true,
    supportsConvocatorias: true,
    personality:
      'Ajustas el nivel al Grado universitario: rigor formal, bibliografía, guía docente y criterios del profesor. Trabajas con créditos ECTS y convocatorias, sin enfoque PAU ni contenidos de Bachillerato. Exiges autonomía: el alumno propone y tú verificas.',
  },
};

const STAGE_ALIASES: Record<string, EducationStage> = {
  ESO: 'ESO',
  'SECUNDARIA': 'ESO',
  BACHILLERATO: 'BACHILLERATO',
  BACH: 'BACHILLERATO',
  UNIVERSIDAD: 'UNIVERSIDAD',
  GRADO: 'UNIVERSIDAD',
};

const ALL_STAGES: readonly EducationStage[] = ['ESO', 'BACHILLERATO', 'UNIVERSIDAD'];

function clean(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Acepta el enum de Prisma, un texto libre o `null`. */
export function parseStage(value: string | null | undefined): EducationStage | null {
  const raw = clean(value).toUpperCase();
  if (!raw) return null;
  return STAGE_ALIASES[raw] ?? null;
}

export function stageConfig(stage: EducationStage): StageConfig {
  return STAGE_CONFIGS[stage];
}

/** ¿La cadena de etapa es una de las tres soportadas? */
export function isEducationStage(value: string): value is EducationStage {
  return (ALL_STAGES as readonly string[]).includes(value);
}

/**
 * Infiere etapa, curso y rama desde `modality`.
 *
 * Es la pieza que hace el backfill idempotente y la que permite que un perfil
 * antiguo («1º de Bachillerato (Ciencias y Tecnología)») siga funcionando sin
 * haber pasado por Ajustes.
 */
export function inferStageFromModality(modality: string | null | undefined): StageSelection {
  const raw = clean(modality);

  const uni = /universidad|universitari|\bgrado\b|ects/i.test(raw);
  if (uni) {
    const levelMatch = raw.match(/(\d)\s*[ºª°]?\s*(?:curso|de\s+grado)/i);
    const level = levelMatch ? `${Number(levelMatch[1])}º curso` : '1º curso';
    const track = UNI_TRACKS.find((candidate) => raw.toLowerCase().includes(candidate.label.toLowerCase()));
    const degreeMatch = raw.match(/grado\s+en\s+([^()·]+)/i);
    const degreeName = degreeMatch ? clean(degreeMatch[1]) : null;
    return {
      stage: 'UNIVERSIDAD',
      gradeLevel: level,
      trackKey: track?.key ?? null,
      degreeName,
      modality: buildModality({ stage: 'UNIVERSIDAD', gradeLevel: level, trackKey: track?.key ?? null, degreeName }),
    };
  }

  if (/\beso\b/i.test(raw)) {
    const match = raw.match(/(\d)\s*[ºª°]?\s*(?:de\s+)?eso\b/i);
    const level = `${match ? Number(match[1]) : 1}º ESO`;
    const safe = ESO_LEVELS.some((option) => option.key === level) ? level : '1º ESO';
    return { stage: 'ESO', gradeLevel: safe, trackKey: null, degreeName: null, modality: safe };
  }

  const bach = raw.match(/(\d)\s*[ºª°]?\s*(?:de\s+)?bachillerato\b/i);
  const isBach = Boolean(bach) || /bachillerato|pau|ebau/i.test(raw);
  if (isBach) {
    const level = `${bach ? Number(bach[1]) : 1}º Bachillerato`;
    const safe = BACH_LEVELS.some((option) => option.key === level) ? level : '1º Bachillerato';
    let trackKey: string | null = null;
    if (/humanidades|sociales/i.test(raw)) trackKey = 'humanidades';
    else if (/general/i.test(raw)) trackKey = 'general';
    else if (/ciencias|tecnolog/i.test(raw)) trackKey = 'ciencias';
    return {
      stage: 'BACHILLERATO',
      gradeLevel: safe,
      trackKey,
      degreeName: null,
      modality: buildModality({ stage: 'BACHILLERATO', gradeLevel: safe, trackKey, degreeName: null }),
    };
  }

  // Cualquier texto desconocido mantiene el comportamiento histórico: se trata
  // como Bachillerato y se conserva el texto original como curso.
  return {
    stage: 'BACHILLERATO',
    gradeLevel: '2º Bachillerato',
    trackKey: null,
    degreeName: null,
    modality: raw || '2º de Bachillerato',
  };
}

/** ¿La modalidad guardada nombra una etapa que el catálogo entiende? */
export function isRecognizedModality(modality: string | null | undefined): boolean {
  return /eso|bachillerato|pau|ebau|universidad|universitari|\bgrado\b/i.test(clean(modality));
}

/** Cadena canónica que se guarda en `UserProfile.modality`. */
export function buildModality(input: {
  stage: EducationStage;
  gradeLevel: string;
  trackKey?: string | null;
  degreeName?: string | null;
}): string {
  const { stage, gradeLevel, trackKey, degreeName } = input;
  if (stage === 'ESO') {
    const level = ESO_LEVELS.find((option) => option.key === gradeLevel)?.key ?? '1º ESO';
    return level;
  }
  if (stage === 'UNIVERSIDAD') {
    const track = UNI_TRACKS.find((option) => option.key === trackKey);
    const degree = clean(degreeName) || 'Grado';
    const level = UNI_LEVELS.find((option) => option.key === gradeLevel)?.key ?? '1º curso';
    return `Universidad · ${degree}${track ? ` (${track.label})` : ''} · ${level}`;
  }
  const level = BACH_LEVELS.find((option) => option.key === gradeLevel)?.key ?? '1º Bachillerato';
  const short = level.replace(' Bachillerato', '');
  const track = BACH_TRACKS.find((option) => option.key === trackKey);
  return track ? `${short} de Bachillerato (${track.label})` : `${short} de Bachillerato`;
}

/**
 * Valida y normaliza una elección de etapa (la que llega de Ajustes). Si el
 * curso o la rama no existen en el catálogo, se cae al primero válido en vez
 * de guardar basura.
 */
export function normalizeStageSelection(input: {
  stage: string;
  gradeLevel?: string | null;
  trackKey?: string | null;
  degreeName?: string | null;
}): StageSelection {
  const stage = parseStage(input.stage) ?? 'BACHILLERATO';
  const config = stageConfig(stage);
  const gradeLevel =
    config.gradeLevels.find((option) => option.key === clean(input.gradeLevel))?.key ??
    config.gradeLevels[0].key;
  const trackKey =
    config.tracks.length === 0
      ? null
      : config.tracks.find((option) => option.key === clean(input.trackKey))?.key ??
        config.tracks[0].key;
  const degreeName = stage === 'UNIVERSIDAD' ? clean(input.degreeName) || null : null;
  return {
    stage,
    gradeLevel,
    trackKey,
    degreeName,
    modality: buildModality({ stage, gradeLevel, trackKey, degreeName }),
  };
}

/** Resuelve la etapa de un perfil, prefiriendo la columna y cayendo a modality. */
export function getStageConfig(profile: StageProfileLike | null | undefined): StageConfig {
  const explicit = parseStage(profile?.stage ?? null);
  const inferred = inferStageFromModality(profile?.modality);
  return stageConfig(explicit ?? inferred.stage);
}

/** Plantillas de materias para una etapa/curso/rama concretos. */
export function subjectTemplatesFor(input: {
  stage: EducationStage;
  gradeLevel: string;
  trackKey?: string | null;
}): readonly StageSubjectTemplate[] {
  if (input.stage === 'ESO') return ESO_TEMPLATES[input.gradeLevel] ?? [];
  if (input.stage === 'UNIVERSIDAD') return input.trackKey ? UNI_TEMPLATES[input.trackKey] ?? [] : [];
  return [];
}

export const STAGE_SUMMARIES: readonly StageSummary[] = ALL_STAGES.map((stage) => {
  const config = STAGE_CONFIGS[stage];
  return {
    stage,
    label: config.label,
    gradeLevels: config.gradeLevels,
    tracks: config.tracks,
    supportsEcts: config.supportsEcts,
    supportsConvocatorias: config.supportsConvocatorias,
    scaleLabel: config.scale.label,
    hasPau: config.scale.hasPau,
  };
});

/** Etiqueta corta del curso para cabecera/sidebar. */
export function courseDisplayLabel(selection: StageSelection): string {
  if (selection.stage === 'UNIVERSIDAD') return selection.gradeLevel;
  return selection.gradeLevel;
}
