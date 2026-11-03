export type StudyTechnique =
  | 'active_recall'
  | 'problemas'
  | 'flashcards'
  | 'simulacro'
  | 'error_fix'
  | 'srs_review';

export const STUDY_TECHNIQUES: Record<
  StudyTechnique,
  { label: string; description: string; badgeColor: string; defaultMinutes: number }
> = {
  active_recall: {
    label: 'Active Recall',
    description: 'Evocación activa desde memoria sin mirar apuntes ni esquemas',
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    defaultMinutes: 45,
  },
  problemas: {
    label: 'Resolución de Problemas',
    description: 'Ejercicios tipo PAU paso a paso con justificación formal',
    badgeColor: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
    defaultMinutes: 50,
  },
  flashcards: {
    label: 'Flashcards & Definiciones',
    description: 'Tarjetas de memorización para conceptos, fechas y leyes',
    badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    defaultMinutes: 30,
  },
  simulacro: {
    label: 'Simulacro de Examen',
    description: 'Prueba cronometrada simulando condiciones reales de Selectividad',
    badgeColor: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
    defaultMinutes: 90,
  },
  error_fix: {
    label: 'Corrección de Errores',
    description: 'Análisis quirúrgico y repetición de fallos del banco de errores',
    badgeColor: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    defaultMinutes: 35,
  },
  srs_review: {
    label: 'Repaso Espaciado',
    description: 'Consolidación programada para prevenir la curva del olvido',
    badgeColor: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
    defaultMinutes: 40,
  },
};

export type ErrorRootCause =
  | 'concepto'
  | 'calculo'
  | 'lectura_enunciado'
  | 'tiempo'
  | 'bloqueo';

export const ERROR_CAUSES: Record<
  ErrorRootCause,
  { label: string; description: string; badgeColor: string }
> = {
  concepto: {
    label: 'Fallo Conceptual',
    description: 'No comprendía la teoría fundamental o apliqué mal el teorema',
    badgeColor: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
  },
  calculo: {
    label: 'Error de Cálculo',
    description: 'Signo, despeje o cálculo aritmético erróneo en la calculadora',
    badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  },
  lectura_enunciado: {
    label: 'Lectura / Interpretación',
    description: 'No leí bien lo que pedían o asumí datos que no estaban',
    badgeColor: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  },
  tiempo: {
    label: 'Gestión del Tiempo',
    description: 'Me faltó tiempo o me quedé atascado en un apartado secundario',
    badgeColor: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  },
  bloqueo: {
    label: 'Bloqueo / Ansiedad',
    description: 'Me quedé en blanco a pesar de conocer la materia',
    badgeColor: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  },
};

/**
 * Estado de una unidad del temario dentro del curso lectivo.
 * Es lo que permite saber «qué llevo visto y qué toca ahora» sin abrir el libro.
 */
export type TopicStatus = 'pendiente' | 'en_curso' | 'visto' | 'repasado';

export const TOPIC_STATUSES: TopicStatus[] = ['pendiente', 'en_curso', 'visto', 'repasado'];

export const TOPIC_STATUS_META: Record<
  TopicStatus,
  { label: string; short: string; description: string; badgeColor: string; dotColor: string }
> = {
  pendiente: {
    label: 'Pendiente',
    short: 'Por dar',
    description: 'Todavía no se ha explicado en clase',
    badgeColor: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
    dotColor: 'bg-slate-500',
  },
  en_curso: {
    label: 'En curso',
    short: 'Ahora',
    description: 'Lo estás dando en clase estos días: refuerzo inmediato',
    badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    dotColor: 'bg-amber-400',
  },
  visto: {
    label: 'Visto en clase',
    short: 'Dado',
    description: 'Ya explicado, pendiente de consolidar',
    badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    dotColor: 'bg-sky-400',
  },
  repasado: {
    label: 'Repasado',
    short: 'Cerrado',
    description: 'Explicado y repasado hasta dominarlo',
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    dotColor: 'bg-emerald-400',
  },
};

/** De dónde salió cada unidad del temario (para no fiarte de una lista y no de otra). */
export const TOPIC_SOURCE_META: Record<
  string,
  { label: string; hint: string; badgeColor: string }
> = {
  curriculo: {
    label: 'Lista de referencia',
    hint: 'Un documento curricular externo: es una referencia, NO tu temario. Sustitúyela por tu índice real cuando la tengas.',
    badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  },
  profesor: {
    label: 'Índice de tu profesor',
    hint: 'Cargado por ti desde el índice de clase: esta es la lista que manda',
    badgeColor: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
  },
  libro: {
    label: 'Índice de tu libro',
    hint: 'Cargado por ti desde el índice de tu libro de texto',
    badgeColor: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  },
  ia: {
    label: 'Propuesta editable',
    hint: 'Una propuesta de la app, no tu temario: revisa, corrige o sustitúyela por tu índice',
    badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  },
  manual: {
    label: 'Añadido a mano',
    hint: 'Unidad creada por ti',
    badgeColor: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
  },
  entrevista: {
    label: 'De tu puesta a punto',
    hint: 'Anotada durante la entrevista, tal como tú la contaste: revísala y corrige lo que haga falta',
    badgeColor: 'bg-teal-500/10 text-teal-300 border-teal-500/30',
  },
};

export function isTopicStatus(value: unknown): value is TopicStatus {
  return typeof value === 'string' && (TOPIC_STATUSES as string[]).includes(value);
}

export type StudyMode = 'comfort' | 'athlete';

export const STUDY_MODES: Record<
  StudyMode,
  { label: string; description: string; multiplier: number; badgeColor: string }
> = {
  comfort: {
    label: 'Zona de Confort',
    description: 'Ritmo sostenible de 2-3 bloques diarios. Énfasis en asimilación gradual.',
    multiplier: 1.0,
    badgeColor: 'bg-sky-500/20 text-sky-400 border-sky-500/40',
  },
  athlete: {
    label: 'Modo Atleta',
    description: 'Ritmo de alto rendimiento. 4-6 bloques de máxima intensidad con simulacros semanales.',
    multiplier: 1.4,
    badgeColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
  },
};
