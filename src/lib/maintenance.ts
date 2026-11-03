/**
 * Mantenimiento del sistema.
 *
 * Esto es el taller: mira dentro de la base y del temario, busca cosas que no
 * cuadran —unidades repetidas, numeración rota, intervalos imposibles, un nivel
 * «inventado» en una unidad que nadie ha medido— y dice qué encuentra y cómo se
 * arregla.
 *
 * Dos reglas que no se rompen nunca:
 *
 *   1. **Nada se arregla a escondidas.** Cada hallazgo se explica en castellano
 *      (qué pasa, cuántos casos y un ejemplo) y cada arreglo dice exactamente qué
 *      va a cambiar antes de aplicarlo.
 *   2. **Lo que borra, avisa.** Los arreglos se marcan como `safe` (renombrar,
 *      renumerar, acotar un rango: no pierden información) o no. Lo que borra
 *      filas solo se propone cuando la fila está **demostrablemente vacía** (una
 *      unidad duplicada sin apuntes, sin errores, sin sesiones ni repasos).
 *
 * Módulo puro (sin Prisma ni red): el vigilante lo ejecuta con datos ya cargados,
 * la página lo ejecuta igual, y las dos ven lo mismo.
 *
 * Desde que existe el rastro de funcionamiento (`operationalTrace.ts`), el motor
 * mira **dos cosas**: los datos (esto) y cómo va la app por dentro (cuándo se ha
 * caído, si la IA está fallando). Las dos se cuentan igual y se arreglan por la
 * misma puerta —para ti el problema es el mismo: algo no funciona—, y la unión de
 * las dos vive en `maintenanceScan.ts`.
 *
 * Este fichero sigue siendo **puro de verdad**: el único import es de tipos, que
 * el compilador borra. Sin Prisma, sin red y sin tocar el disco, las reglas de
 * los datos se pueden probar solas (y el test lo exige).
 */

import type { OperationalTrace } from './operationalTrace';

export type MaintenanceSeverity = 'critico' | 'aviso' | 'info';

export const SEVERITY_META: Record<
  MaintenanceSeverity,
  { label: string; badgeColor: string; dotColor: string }
> = {
  critico: {
    label: 'Crítico',
    badgeColor: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    dotColor: 'bg-rose-400',
  },
  aviso: {
    label: 'Aviso',
    badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    dotColor: 'bg-amber-400',
  },
  info: {
    label: 'Información',
    badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    dotColor: 'bg-sky-400',
  },
};

/**
 * El nivel al que se devuelve una unidad cuando se limpia su medición.
 *
 * Es el valor que usa la propia app para decir «sin medir»: `actions.ts` escribe
 * `{ masteryLevel: 0, masterySource: 'sin_medir' }` cuando se borra una
 * autoevaluación, y `setupApply.ts` lo mismo al cargar temario nuevo.
 */
export const NEUTRAL_MASTERY_LEVEL = 0;

/**
 * Todos los valores con los que el sistema dice «esto no se ha medido»:
 *
 *   - `0`  → lo que escriben `actions.ts` y `setupApply.ts` al crear o limpiar.
 *   - `20` → el valor por defecto de `Topic.masteryLevel` en el esquema, para las
 *            unidades que nacieron sin que nadie especificara un nivel.
 *
 * Los dos son honestos. Lo que **no** lo es: cualquier otro número guardado con
 * `masterySource: 'sin_medir'`, porque aparenta una medición que nadie ha hecho.
 * (El planificador trabaja por dentro con 50 para lo no medido —`NEUTRAL_MASTERY`
 * en `knowledge.ts`—, pero ese es un valor de cálculo, no algo que se guarde.)
 */
export const UNMEASURED_MASTERY_LEVELS: readonly number[] = [0, 20];

/** ¿Este nivel dice una medición que el origen desmiente? */
export function claimsUnmeasuredReading(topic: { masteryLevel: number; masterySource: string }): boolean {
  return topic.masterySource === 'sin_medir' && !UNMEASURED_MASTERY_LEVELS.includes(topic.masteryLevel);
}

export const SRS_MIN_EASE = 1.3;
export const SRS_MAX_EASE = 2.8;
export const SRS_MAX_INTERVAL_DAYS = 180;

export interface MaintenanceTopicRow {
  id: string;
  subjectId: string;
  subjectName: string;
  title: string;
  unitNumber: number | null;
  status: string;
  lastReviewedAt: string | null;
  srsIntervalDays: number;
  srsEaseFactor: number;
  masteryLevel: number;
  masterySource: string;
  /** Cuántas cosas cuelgan de la unidad (para saber si borrarla pierde algo). */
  attached: { notes: number; errors: number; blocks: number; sessions: number; reviews: number };
}

/**
 * Una fila del cuaderno de apuntes, tal y como la mira el taller.
 *
 * Solo hace falta el texto: la comprobación busca **restos de código** dentro del
 * Markdown —vallas, etiquetas HTML, desplegables viejos, saltos de línea
 * escapados— que el redactor deja cuando se pone nervioso y que luego salen
 * impresos en mitad del apunte.
 */
export interface MaintenanceNoteRow {
  id: string;
  title: string;
  content: string;
  /** `alumno` o `catedratico`: quién lo escribió (para poder decirlo). */
  author: string;
}

/**
 * Los restos de código que no deben quedar dentro de un apunte, ya con nombre.
 *
 * Es la misma lista que limpia `sanitizeNoteContent` al guardar; aquí se mira
 * **dentro** de los apuntes que ya están escritos, que son los que se quedaron
 * con las marcas de antes de que existiera el limpiador.
 */
export function noteCodeRemnants(content: string): string[] {
  const text = String(content ?? '');
  const found: string[] = [];

  if (/```|~~~/.test(text)) found.push('valla de código');
  if (/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(text)) found.push('etiqueta HTML');
  if (text.includes('\\n')) found.push('salto de línea escapado');
  if (/\[\[\s*(?:etapa|nivel|apunte)\s*:/i.test(text)) found.push('etiqueta interna del sistema');

  return found;
}

export interface MaintenanceInput {
  /** Fecha de hoy en ISO (para comparar sin depender del reloj real). */
  today: string;
  /** Clave de la semana en curso («2026-W42»). */
  weekKey: string;
  topics: MaintenanceTopicRow[];
  subjects: Array<{
    id: string;
    name: string;
    order: number;
    units: number;
    classPeriods: number;
    /**
     * ¿Esta materia se trabaja en la app? Las que solo están en el horario
     * (Religión, Educación Física…) no necesitan temario: avisar de que no lo
     * tienen sería ruido en el taller, no un hallazgo.
     */
    tracked?: boolean;
    /**
     * Cuántas unidades traería la mejor **copia de seguridad** disponible de esa
     * materia (0 o sin valor = no hay ninguna copia que la pueda reponer).
     *
     * Es el dato que separa «esta materia no tiene temario porque aún no lo has
     * cargado» —normal, el alumno lo carga cuando quiere— de «esta materia se ha
     * quedado sin temario y antes sí lo tenía» —que es una pérdida y se arregla
     * sola—. Sin esta distinción el taller no puede saber la diferencia.
     */
    backupUnits?: number;
    /** El fichero de la copia del que saldrían las unidades (para poder decirlo). */
    backupFrom?: string;
  }>;
  exams: Array<{ id: string; title: string; subjectName: string; examDate: string; isCompleted: boolean }>;
  habits: Array<{
    id: string;
    title: string;
    streak: number;
    logsToday: number;
    /** Registros de hoy sobrantes (los que se borrarían), ya resueltos por quien carga los datos. */
    extraLogIds?: string[];
  }>;
  challenges: Array<{ id: string; weekKey: string; weekStart: string; status: string; title: string }>;
  issues: Array<{
    id: string;
    title: string;
    status: string;
    /**
     * Hallazgo del vigilante que abrió la incidencia, si lo hay (sale de su
     * `contextJson`). Sirve para que el aviso de incidencias no se cuente a sí
     * mismo: sin este dato, la incidencia que abre ese aviso lo mantenía abierto
     * para siempre (ver el comentario de `incidencias_abiertas`).
     */
    findingId?: string | null;
  }>;
  ai: { gemini: boolean; groq: boolean; availableModels: number; coolingDown: number };
  /**
   * El instante exacto de la pasada. `today` es el día (para comparar fechas);
   * esto es la hora, que es lo que necesitan las ventanas del rastro (un fallo de
   * hace media hora no es lo mismo que uno de esta mañana).
   */
  now?: string;
  /**
   * Cómo va la app por dentro: caídas, paradas de salud, errores, fallos de la IA.
   * Es opcional a propósito: el motor de datos se puede probar sin rastro (y así
   * las comprobaciones de siempre se siguen midiendo solas), pero el sistema real
   * siempre lo trae (lo carga `operationalData.ts`).
   */
  trace?: OperationalTrace;
  /**
   * El cuaderno de apuntes (los de texto). Opcional por la misma razón que el
   * rastro: el sistema real siempre lo trae (lo carga `maintenanceData.ts`).
   */
  notes?: MaintenanceNoteRow[];
}

export interface MaintenanceFinding {
  /** Identificador estable de la comprobación. */
  id: string;
  severity: MaintenanceSeverity;
  title: string;
  detail: string;
  count: number;
  fixable: boolean;
  fixLabel?: string;
  /** Ejemplos concretos, para saber de qué se está hablando. */
  samples: string[];
}

export type MaintenanceOperation =
  | { kind: 'rename_topic'; topicId: string; title: string }
  | { kind: 'renumber_topic'; topicId: string; unitNumber: number }
  | { kind: 'delete_topic'; topicId: string }
  | { kind: 'clamp_srs'; topicId: string; intervalDays: number; easeFactor: number }
  | { kind: 'clear_future_review'; topicId: string }
  | { kind: 'fix_topic_status'; topicId: string; status: string }
  | { kind: 'reset_mastery'; topicId: string }
  | { kind: 'delete_habit_log'; logId: string }
  | { kind: 'clamp_habit_streak'; habitId: string; streak: number }
  | { kind: 'expire_challenge'; challengeId: string }
  | { kind: 'complete_exam'; examId: string }
  /* Apuntes: no cambian ni una palabra, solo quitan las marcas que no son del
     apunte (vallas, HTML, desplegables viejos, saltos escapados). */
  | { kind: 'clean_note_code'; noteId: string }
  /* Reponer el temario de las materias que se han quedado vacías desde la copia
     de seguridad más reciente. Solo rellena lo que está vacío: una materia con
     unidades no se toca, y antes de escribir nada se deja otra copia de cómo
     estaba todo. */
  | { kind: 'restore_temario' }
  /* Funcionamiento: no tocan datos, devuelven la app a su sitio. */
  | { kind: 'start_server' }
  | { kind: 'restart_server' };

export interface MaintenanceFix {
  /** Igual que el id del hallazgo que lo propone. */
  id: string;
  label: string;
  /** Qué va a cambiar, en una frase, ANTES de aplicarlo. */
  description: string;
  count: number;
  /** `true` = no pierde información (renombrar, renumerar, acotar rangos). */
  safe: boolean;
  operations: MaintenanceOperation[];
}

function startOfDay(iso: string): number {
  const date = new Date(iso);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Título comparable: sin espacios de sobra, sin acentos y en minúsculas. */
export function normalizeTitle(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Título limpio para guardar: espacios colapsados y sin puntos/símbolos al final. */
export function tidyTitle(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,;:·-]+$/g, '')
    .trim();
}

function attachedTotal(topic: MaintenanceTopicRow): number {
  const a = topic.attached;
  return a.notes + a.errors + a.blocks + a.sessions + a.reviews;
}

function isUnitStatus(value: string): boolean {
  return value === 'pendiente' || value === 'en_curso' || value === 'visto' || value === 'repasado';
}

/* ------------------------------------------------------------------ */
/* 1. Las comprobaciones                                               */
/* ------------------------------------------------------------------ */

export function runMaintenanceChecks(input: MaintenanceInput): MaintenanceFinding[] {
  const findings: MaintenanceFinding[] = [];
  const today = startOfDay(input.today);

  const bySubject = new Map<string, MaintenanceTopicRow[]>();
  for (const topic of input.topics) {
    const list = bySubject.get(topic.subjectId) ?? [];
    list.push(topic);
    bySubject.set(topic.subjectId, list);
  }

  /* --- Temario: títulos sucios --- */
  const dirtyTitles = input.topics.filter((topic) => tidyTitle(topic.title) !== topic.title);
  if (dirtyTitles.length > 0) {
    findings.push({
      id: 'titulos_sucios',
      severity: 'info',
      title: 'Títulos con espacios o signos de sobra',
      detail:
        'Espacios dobles y puntos finales en los títulos de las unidades. Se ven raros en el temario y al ordenar alfabéticamente.',
      count: dirtyTitles.length,
      fixable: true,
      fixLabel: `Limpiar ${dirtyTitles.length} título(s)`,
      samples: dirtyTitles.slice(0, 4).map((topic) => `«${topic.title}»`),
    });
  }

  /* --- Temario: unidades duplicadas --- */
  const duplicates: MaintenanceTopicRow[] = [];
  let duplicatesWithData = 0;
  for (const [, topics] of bySubject) {
    const seen = new Map<string, MaintenanceTopicRow[]>();
    for (const topic of topics) {
      const key = normalizeTitle(topic.title);
      seen.set(key, [...(seen.get(key) ?? []), topic]);
    }
    for (const [, group] of seen) {
      if (group.length < 2) continue;
      // Se conserva la que más cosas tiene (o la primera) y se marca el resto.
      const sorted = [...group].sort((a, b) => attachedTotal(b) - attachedTotal(a));
      for (const extra of sorted.slice(1)) {
        duplicates.push(extra);
        if (attachedTotal(extra) > 0) duplicatesWithData += 1;
      }
    }
  }

  if (duplicates.length > 0) {
    findings.push({
      id: 'unidades_duplicadas',
      severity: duplicatesWithData > 0 ? 'aviso' : 'info',
      title: 'Unidades repetidas en el temario',
      detail:
        duplicatesWithData > 0
          ? `Hay ${duplicates.length} unidad(es) con el mismo título repetidas, y ${duplicatesWithData} de ellas tienen datos (apuntes, errores o repasos) colgando: esas hay que fusionarlas a mano, no se borran solas.`
          : `Hay ${duplicates.length} unidad(es) con el mismo título repetidas y vacías: se pueden quitar sin perder nada.`,
      count: duplicates.length,
      fixable: duplicates.some((topic) => attachedTotal(topic) === 0),
      fixLabel: duplicates.some((topic) => attachedTotal(topic) === 0)
        ? `Quitar las repetidas vacías (${duplicates.filter((topic) => attachedTotal(topic) === 0).length})`
        : undefined,
      samples: duplicates.slice(0, 4).map((topic) => `«${topic.title}» (${topic.subjectName})`),
    });
  }

  /* --- Temario: numeración duplicada --- */
  const duplicateNumbers: MaintenanceTopicRow[] = [];
  for (const [, topics] of bySubject) {
    const seen = new Map<number, number>();
    for (const topic of topics) {
      if (topic.unitNumber === null) continue;
      seen.set(topic.unitNumber, (seen.get(topic.unitNumber) ?? 0) + 1);
    }
    for (const topic of topics) {
      if (topic.unitNumber !== null && (seen.get(topic.unitNumber) ?? 0) > 1) {
        duplicateNumbers.push(topic);
      }
    }
  }
  if (duplicateNumbers.length > 0) {
    findings.push({
      id: 'numeracion_duplicada',
      severity: 'aviso',
      title: 'Dos unidades con el mismo número',
      detail:
        'Una misma asignatura tiene dos unidades compartiendo número de unidad. Al renumerar en orden, cada una recupera el suyo.',
      count: duplicateNumbers.length,
      fixable: true,
      fixLabel: 'Renumerar en orden',
      samples: duplicateNumbers
        .slice(0, 4)
        .map((topic) => `U${topic.unitNumber} «${topic.title}» (${topic.subjectName})`),
    });
  }

  /* --- Temario: numeración con huecos o sin numerar --- */
  const gapTopics: MaintenanceTopicRow[] = [];
  for (const [, topics] of bySubject) {
    const numbered = topics
      .filter((topic) => topic.unitNumber !== null)
      .sort((a, b) => (a.unitNumber as number) - (b.unitNumber as number));
    const unnumbered = topics.filter((topic) => topic.unitNumber === null);
    if (numbered.length === 0 && unnumbered.length === 0) continue;

    const expected = new Set(numbered.map((_, index) => index + 1));
    const hasGap = numbered.some((topic) => !expected.has(topic.unitNumber as number));
    // Un hueco solo cuenta si el temario ya está numerado: una lista sin números
    // no está «rota», está sin numerar.
    if (numbered.length > 0 && (hasGap || unnumbered.length > 0)) {
      gapTopics.push(...numbered, ...unnumbered);
    }
  }
  if (gapTopics.length > 0) {
    findings.push({
      id: 'numeracion_rota',
      severity: 'info',
      title: 'Numeración del temario con huecos',
      detail:
        'Algunas asignaturas tienen números saltados (1, 2, 4…) o unidades sin número. Renumerar en orden deja el temario correlativo y hace que «vamos por la U5» signifique lo mismo para todos.',
      count: gapTopics.length,
      fixable: true,
      fixLabel: 'Renumerar en orden',
      samples: gapTopics.slice(0, 4).map((topic) => `${topic.subjectName} · «${topic.title}»`),
    });
  }

  /* --- Temario: asignaturas sin nada (y sin copia de la que tirar) --- */
  //
  // Las que **sí** tienen copia no entran aquí: esas no están «sin cargar»,
  // están perdidas, y eso es otra cosa (ver la comprobación siguiente).
  const emptySubjects = input.subjects.filter(
    (subject) =>
      subject.tracked !== false &&
      subject.units === 0 &&
      (subject.backupUnits ?? 0) === 0
  );
  if (emptySubjects.length > 0) {
    findings.push({
      id: 'temario_vacio',
      severity: 'info',
      title: 'Asignaturas sin temario',
      detail:
        'Estas materias todavía no tienen unidades. Sin temario el planificador no puede repartir nada en ellas: se cargan pegando tu índice en /temario o dictándoselo al coordinador.',
      count: emptySubjects.length,
      fixable: false,
      samples: emptySubjects.slice(0, 6).map((subject) => subject.name),
    });
  }

  /* --- Temario: una materia que se ha quedado sin unidades y hay copia --- */
  //
  // Esto es una **pérdida**, no un temario pendiente de cargar: la materia tenía
  // unidades antes (por eso existe una copia) y ahora no tiene ninguna. Se avisa
  // y se repara solo, porque reponer desde la copia no puede perder nada: solo
  // rellena lo que está vacío.
  const lostSubjects = input.subjects.filter(
    (subject) => subject.units === 0 && (subject.backupUnits ?? 0) > 0
  );
  if (lostSubjects.length > 0) {
    findings.push({
      id: 'temario_perdido',
      severity: 'aviso',
      title: 'Temario perdido que se puede reponer',
      detail:
        'Hay materias que tenían unidades y ahora están vacías, pero el sistema conserva una copia de su temario. Se vuelven a escribir tal y como estaban (mismo título, número y origen) sin tocar ninguna otra materia. Suele pasar al sembrar la base de demostración o al sustituir un temario: la copia es la red que evita perder el curso entero.',
      count: lostSubjects.length,
      fixable: true,
      fixLabel: `Reponer el temario de ${lostSubjects.length} materia(s)`,
      samples: lostSubjects
        .slice(0, 6)
        .map(
          (subject) =>
            `${subject.name} (${subject.backupUnits} ${
              subject.backupUnits === 1 ? 'unidad' : 'unidades'
            } en la copia)`
        ),
    });
  }

  /* --- Expediente honesto: nivel inventado --- */
  const inventedMastery = input.topics.filter((topic) => claimsUnmeasuredReading(topic));
  if (inventedMastery.length > 0) {
    findings.push({
      id: 'nivel_sin_medir',
      severity: 'aviso',
      title: 'Nivel puesto en unidades sin medir',
      detail:
        'Estas unidades tienen un nivel guardado que aparenta una medición, pero su origen dice «sin medir». La regla de la casa es que lo que nadie ha medido no se juzga: se devuelven a 0 (que es como la app dice «sin medir»), para que el planificador no las trate como flojas ni como dominadas. Un 0 o un 20 no son un problema: son las dos formas que tiene el sistema de decir «no lo sé».',
      count: inventedMastery.length,
      fixable: true,
      fixLabel: `Devolver ${inventedMastery.length} unidad(es) al nivel neutro`,
      samples: inventedMastery
        .slice(0, 4)
        .map((topic) => `«${topic.title}» al ${topic.masteryLevel}%`),
    });
  }

  /* --- SRS: intervalos y facilidad imposibles --- */
  const brokenSrs = input.topics.filter(
    (topic) =>
      topic.srsIntervalDays < 1 ||
      topic.srsIntervalDays > SRS_MAX_INTERVAL_DAYS ||
      !Number.isFinite(topic.srsEaseFactor) ||
      topic.srsEaseFactor < SRS_MIN_EASE ||
      topic.srsEaseFactor > SRS_MAX_EASE
  );
  if (brokenSrs.length > 0) {
    findings.push({
      id: 'srs_fuera_de_rango',
      severity: 'critico',
      title: 'Calendario de repaso en valores imposibles',
      detail:
        'Hay intervalos menores de un día o mayores de 180, y factores de facilidad fuera del rango del algoritmo (1.3–2.8). Con esos valores la cola de repaso miente. Se acotan a los límites válidos.',
      count: brokenSrs.length,
      fixable: true,
      fixLabel: `Acotar ${brokenSrs.length} calendario(s)`,
      samples: brokenSrs
        .slice(0, 4)
        .map((topic) => `«${topic.title}» · intervalo ${topic.srsIntervalDays} · facilidad ${topic.srsEaseFactor}`),
    });
  }

  /* --- SRS: repasos fechados en el futuro --- */
  const futureReviews = input.topics.filter(
    (topic) => topic.lastReviewedAt !== null && startOfDay(topic.lastReviewedAt) > today
  );
  if (futureReviews.length > 0) {
    findings.push({
      id: 'repaso_en_el_futuro',
      severity: 'critico',
      title: 'Repasos con fecha futura',
      detail:
        'Estas unidades dicen haberse repasado en el futuro, así que su próximo repaso nunca llega. Se limpia la fecha: la unidad queda sin calendario y entra en la primera pasada de /repaso.',
      count: futureReviews.length,
      fixable: true,
      fixLabel: `Limpiar ${futureReviews.length} fecha(s)`,
      samples: futureReviews.slice(0, 4).map((topic) => `«${topic.title}»`),
    });
  }

  /* --- Temario: estado que no cuadra con el calendario --- */
  const oddStatus = input.topics.filter(
    (topic) => topic.status === 'repasado' && topic.lastReviewedAt === null
  );
  if (oddStatus.length > 0) {
    findings.push({
      id: 'estado_incoherente',
      severity: 'info',
      title: 'Unidades «repasadas» sin ningún repaso',
      detail:
        'Están marcadas como repasadas pero no tienen ninguna fecha de repaso. Se devuelven a «visto en clase», que es lo que de verdad consta.',
      count: oddStatus.length,
      fixable: true,
      fixLabel: `Corregir ${oddStatus.length} estado(s)`,
      samples: oddStatus.slice(0, 4).map((topic) => `«${topic.title}» (${topic.subjectName})`),
    });
  }

  /* --- Temario: estado desconocido --- */
  const badStates = input.topics.filter((topic) => !isUnitStatus(topic.status));
  if (badStates.length > 0) {
    findings.push({
      id: 'estado_desconocido',
      severity: 'aviso',
      title: 'Unidades con un estado que el sistema no conoce',
      detail:
        'El estado de una unidad solo puede ser pendiente, en curso, visto o repasado. Las demás se quedan como pendientes (el valor más prudente).',
      count: badStates.length,
      fixable: true,
      fixLabel: `Reiniciar ${badStates.length} estado(s)`,
      samples: badStates.slice(0, 4).map((topic) => `«${topic.title}»: ${topic.status}`),
    });
  }

  /* --- Exámenes ya pasados sin cerrar --- */
  const staleExams = input.exams.filter(
    (exam) => !exam.isCompleted && startOfDay(exam.examDate) < today
  );
  if (staleExams.length > 0) {
    findings.push({
      id: 'examenes_caducados',
      severity: 'info',
      title: 'Exámenes con fecha pasada sin cerrar',
      detail:
        'Siguen contando como próximos exámenes, así que el planificador les da urgencia y los retos los ven como inminentes. Puedes cerrarlos (marcarlos como realizados) o dejarlos si aún te falta ponerles la nota.',
      count: staleExams.length,
      fixable: true,
      fixLabel: `Marcar ${staleExams.length} examen(es) como realizados`,
      samples: staleExams
        .slice(0, 4)
        .map((exam) => `${exam.subjectName} · ${exam.title} (${exam.examDate.slice(0, 10)})`),
    });
  }

  /* --- Hábitos: rachas y duplicados --- */
  const negativeStreaks = input.habits.filter((habit) => habit.streak < 0);
  if (negativeStreaks.length > 0) {
    findings.push({
      id: 'racha_negativa',
      severity: 'info',
      title: 'Rachas de hábitos en negativo',
      detail:
        'Una racha de días no puede ser negativa: pasa cuando se desmarca un hábito más veces de las que se marcó. Se pone a cero.',
      count: negativeStreaks.length,
      fixable: true,
      fixLabel: `Poner ${negativeStreaks.length} racha(s) a cero`,
      samples: negativeStreaks.slice(0, 4).map((habit) => `«${habit.title}»: ${habit.streak} días`),
    });
  }

  const duplicatedHabitLogs = input.habits.filter((habit) => habit.logsToday > 1);
  const extraLogIds = input.habits.flatMap((habit) => habit.extraLogIds ?? []);
  if (extraLogIds.length > 0) {
    findings.push({
      id: 'habitos_duplicados',
      severity: 'info',
      title: 'Hábitos marcados varias veces el mismo día',
      detail:
        'Hay más de un registro del mismo día para el mismo hábito: uno basta. Se conserva el primero y se quitan los repetidos.',
      count: extraLogIds.length,
      fixable: true,
      fixLabel: `Limpiar ${extraLogIds.length} registro(s)`,
      samples: duplicatedHabitLogs.slice(0, 4).map((habit) => `«${habit.title}»: ${habit.logsToday} registros`),
    });
  }

  /* --- Retos: activos de semanas que ya pasaron --- */
  const staleChallenges = input.challenges.filter(
    (challenge) => challenge.status === 'active' && challenge.weekKey !== input.weekKey
  );
  if (staleChallenges.length > 0) {
    findings.push({
      id: 'retos_caducados',
      severity: 'aviso',
      title: 'Retos de semanas pasadas que siguen «en juego»',
      detail:
        'Ya no se vuelven a medir (su semana terminó), así que aparecen como activos sin poder cerrarse nunca. Se marcan como quedados a medias — que es lo que pasó.',
      count: staleChallenges.length,
      fixable: true,
      fixLabel: `Cerrar ${staleChallenges.length} reto(s)`,
      samples: staleChallenges.slice(0, 4).map((challenge) => `${challenge.weekKey} · ${challenge.title}`),
    });
  }

  /* --- Motor de IA --- */
  if (!input.ai.gemini && !input.ai.groq) {
    findings.push({
      id: 'ia_sin_claves',
      severity: 'critico',
      title: 'Sin ninguna clave de IA configurada',
      detail:
        'Sin GEMINI_API_KEY (o GROQ_API_KEY) en el archivo .env no hay catedráticos, ni examinador, ni redacción de apuntes. El resto de la app funciona; la puesta a punto responde en modo local. Se consigue gratis en aistudio.google.com y console.groq.com.',
      count: 1,
      fixable: false,
      samples: ['.env → GEMINI_API_KEY=… (y opcional GROQ_API_KEY=…)'],
    });
  } else if (input.ai.availableModels === 0 || input.ai.coolingDown > 0) {
    findings.push({
      id: 'ia_saturada',
      severity: input.ai.availableModels === 0 ? 'aviso' : 'info',
      title: 'Modelos de IA en enfriamiento',
      detail:
        input.ai.availableModels === 0
          ? 'Todos los modelos disponibles están en enfriamiento (cupo agotado o errores). La app reintenta sola y, si no hay ninguno libre, responde en modo local. Añadir una clave de Groq de respaldo evita que se note.'
          : `${input.ai.coolingDown} modelo(s) en enfriamiento ahora mismo. La app los salta y sigue con los que están libres; se recuperan solos.`,
      count: input.ai.coolingDown,
      fixable: false,
      samples: [`Claves: ${input.ai.gemini ? 'Gemini ✓' : 'Gemini ✗'} · ${input.ai.groq ? 'Groq ✓' : 'Groq ✗'}`],
    });
  }

  /* --- Apuntes: restos de código dentro del texto --- */
  const notesWithCode = (input.notes ?? []).filter((note) => noteCodeRemnants(note.content).length > 0);
  if (notesWithCode.length > 0) {
    findings.push({
      id: 'apuntes_con_codigo',
      severity: 'aviso',
      title: 'Restos de código dentro de un apunte',
      detail:
        'Hay apuntes guardados con marcas que no son del apunte: vallas de código, etiquetas HTML, desplegables del formato viejo o saltos de línea escapados. Los que escribe el catedrático se limpian al guardarlos, así que estos son de antes. Impresos salen tal cual, en mitad del texto que estudias.',
      count: notesWithCode.length,
      fixable: true,
      fixLabel: `Limpiar ${notesWithCode.length} apunte(s)`,
      samples: notesWithCode
        .slice(0, 4)
        .map((note) => `«${note.title}» · ${noteCodeRemnants(note.content).join(', ')}`),
    });
  }

  /* --- Incidencias reportadas --- */
  //
  // La incidencia que abre ESTE aviso no cuenta como fallo pendiente. Si contara,
  // el aviso se vería a sí mismo: el vigilante abría «Fallos reportados sin
  // revisar» y, en la ronda siguiente, esa misma incidencia lo mantenía abierto.
  // Nunca se cerraba y el taller enseñaba un problema permanente que no existía.
  const openIssues = input.issues.filter(
    (issue) => issue.status === 'abierto' && issue.findingId !== 'incidencias_abiertas'
  );
  if (openIssues.length > 0) {
    findings.push({
      id: 'incidencias_abiertas',
      severity: 'aviso',
      title: 'Fallos reportados sin revisar',
      detail:
        'Hay fallos anotados esperando revisión. Revísalos y cuéntame qué pasó: con el contexto anotado se puede ir a por la causa en vez de adivinar.',
      count: openIssues.length,
      fixable: false,
      samples: openIssues.slice(0, 4).map((issue) => issue.title),
    });
  }

  return sortFindings(findings);
}

/**
 * El orden con el que se enseñan los hallazgos: lo grave primero y, a igualdad,
 * lo que más casos tiene. Vive aquí y se exporta para que la unión con el rastro
 * de funcionamiento (`maintenanceScan.ts`) ordene **igual**: dos listas con
 * criterios distintos es la forma más tonta de confundir a quien las lee.
 */
export function sortFindings(findings: MaintenanceFinding[]): MaintenanceFinding[] {
  const order: Record<MaintenanceSeverity, number> = { critico: 0, aviso: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

/* ------------------------------------------------------------------ */
/* 2. Los arreglos                                                     */
/* ------------------------------------------------------------------ */

/**
 * Plan de arreglos para los hallazgos que se pueden reparar. Devuelve, por cada
 * comprobación, la lista exacta de operaciones: la página las enseña antes de
 * aplicarlas y el vigilante solo aplica las que están marcadas como seguras.
 */
export function buildMaintenanceFixes(input: MaintenanceInput): MaintenanceFix[] {
  const fixes: MaintenanceFix[] = [];
  const findings = new Map(runMaintenanceChecks(input).map((finding) => [finding.id, finding]));
  const today = startOfDay(input.today);

  const bySubject = new Map<string, MaintenanceTopicRow[]>();
  for (const topic of input.topics) {
    const list = bySubject.get(topic.subjectId) ?? [];
    list.push(topic);
    bySubject.set(topic.subjectId, list);
  }

  /* Títulos sucios */
  const dirtyTitles = input.topics.filter((topic) => tidyTitle(topic.title) !== topic.title);
  if (dirtyTitles.length > 0) {
    fixes.push({
      id: 'titulos_sucios',
      label: findings.get('titulos_sucios')?.fixLabel ?? 'Limpiar títulos',
      description: 'Colapsa los espacios dobles y quita puntos finales de los títulos. Solo cambia el texto.',
      count: dirtyTitles.length,
      safe: true,
      operations: dirtyTitles.map((topic) => ({
        kind: 'rename_topic' as const,
        topicId: topic.id,
        title: tidyTitle(topic.title),
      })),
    });
  }

  /* Duplicadas vacías */
  const emptyDuplicates: MaintenanceTopicRow[] = [];
  for (const [, topics] of bySubject) {
    const seen = new Map<string, MaintenanceTopicRow[]>();
    for (const topic of topics) {
      const key = normalizeTitle(topic.title);
      seen.set(key, [...(seen.get(key) ?? []), topic]);
    }
    for (const [, group] of seen) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => attachedTotal(b) - attachedTotal(a));
      for (const extra of sorted.slice(1)) {
        // Solo se borra si no cuelga NADA de ella y hay otra copia con datos.
        if (attachedTotal(extra) === 0 && attachedTotal(sorted[0]) > 0) emptyDuplicates.push(extra);
        else if (attachedTotal(extra) === 0 && attachedTotal(sorted[0]) === 0) emptyDuplicates.push(extra);
      }
    }
  }
  if (emptyDuplicates.length > 0) {
    fixes.push({
      id: 'unidades_duplicadas',
      label: findings.get('unidades_duplicadas')?.fixLabel ?? 'Quitar repetidas vacías',
      description:
        'Borra las unidades repetidas que no tienen ningún apunte, error, bloque, sesión ni repaso colgando. Se conserva la copia con datos (o la primera).',
      count: emptyDuplicates.length,
      safe: true,
      operations: emptyDuplicates.map((topic) => ({ kind: 'delete_topic' as const, topicId: topic.id })),
    });
  }

  /* Numeración: duplicada y huecos -> renumerar en orden */
  const renumber: MaintenanceTopicRow[] = [];
  for (const [, topics] of bySubject) {
    const ordered = [...topics].sort((a, b) => {
      const aNum = a.unitNumber ?? Number.MAX_SAFE_INTEGER;
      const bNum = b.unitNumber ?? Number.MAX_SAFE_INTEGER;
      if (aNum !== bNum) return aNum - bNum;
      return a.title.localeCompare(b.title, 'es');
    });

    const needsRenumber =
      ordered.some((topic) => topic.unitNumber === null) ||
      new Set(ordered.map((topic) => topic.unitNumber)).size !== ordered.length ||
      ordered.some((topic, index) => topic.unitNumber !== index + 1);

    if (needsRenumber && ordered.length > 1) renumber.push(...ordered);
  }
  const renumberOps = new Map<string, number>();
  for (const [, topics] of bySubject) {
    const ordered = [...topics].sort((a, b) => {
      const aNum = a.unitNumber ?? Number.MAX_SAFE_INTEGER;
      const bNum = b.unitNumber ?? Number.MAX_SAFE_INTEGER;
      if (aNum !== bNum) return aNum - bNum;
      return a.title.localeCompare(b.title, 'es');
    });
    ordered.forEach((topic, index) => {
      if (topic.unitNumber !== index + 1) renumberOps.set(topic.id, index + 1);
    });
  }
  if (renumberOps.size > 0) {
    fixes.push({
      id: 'renumerar_temario',
      label: `Renumerar ${renumberOps.size} unidad(es) en orden`,
      description:
        'Numera las unidades de cada asignatura de 1 a N en su orden actual (primero por número, luego por título). No cambia títulos ni borra nada.',
      count: renumberOps.size,
      safe: true,
      operations: [...renumberOps.entries()].map(([topicId, unitNumber]) => ({
        kind: 'renumber_topic' as const,
        topicId,
        unitNumber,
      })),
    });
  }

  /* Temario perdido: se repone desde la copia */
  const lostSubjects = input.subjects.filter(
    (subject) => subject.units === 0 && (subject.backupUnits ?? 0) > 0
  );
  if (lostSubjects.length > 0) {
    fixes.push({
      id: 'temario_perdido',
      label: findings.get('temario_perdido')?.fixLabel ?? 'Reponer el temario',
      description:
        'Vuelve a escribir las unidades de esas materias desde la copia de seguridad más reciente (mismo título, número, evaluación y origen). Solo rellena las materias que están vacías, así que ninguna que tenga su temario se toca, y antes de escribir nada se guarda una copia de cómo estaba el sistema.',
      count: lostSubjects.length,
      safe: true,
      operations: [{ kind: 'restore_temario' as const }],
    });
  }

  /* Nivel inventado */
  const invented = input.topics.filter(
    (topic) => claimsUnmeasuredReading(topic)
  );
  if (invented.length > 0) {
    fixes.push({
      id: 'nivel_sin_medir',
      label: findings.get('nivel_sin_medir')?.fixLabel ?? 'Devolver al nivel neutro',
      description: `Pone el nivel de esas unidades en ${NEUTRAL_MASTERY_LEVEL}, el valor con el que la app dice «sin medir»: deja de aparentar una medición que no existe.`,
      count: invented.length,
      safe: true,
      operations: invented.map((topic) => ({ kind: 'reset_mastery' as const, topicId: topic.id })),
    });
  }

  /* SRS fuera de rango */
  const brokenSrs = input.topics.filter(
    (topic) =>
      topic.srsIntervalDays < 1 ||
      topic.srsIntervalDays > SRS_MAX_INTERVAL_DAYS ||
      !Number.isFinite(topic.srsEaseFactor) ||
      topic.srsEaseFactor < SRS_MIN_EASE ||
      topic.srsEaseFactor > SRS_MAX_EASE
  );
  if (brokenSrs.length > 0) {
    fixes.push({
      id: 'srs_fuera_de_rango',
      label: findings.get('srs_fuera_de_rango')?.fixLabel ?? 'Acotar calendarios',
      description: `Deja los intervalos entre 1 y ${SRS_MAX_INTERVAL_DAYS} días y la facilidad entre ${SRS_MIN_EASE} y ${SRS_MAX_EASE}.`,
      count: brokenSrs.length,
      safe: true,
      operations: brokenSrs.map((topic) => ({
        kind: 'clamp_srs' as const,
        topicId: topic.id,
        intervalDays: Math.min(SRS_MAX_INTERVAL_DAYS, Math.max(1, Math.round(topic.srsIntervalDays || 1))),
        easeFactor: Math.min(
          SRS_MAX_EASE,
          Math.max(SRS_MIN_EASE, Number.isFinite(topic.srsEaseFactor) ? topic.srsEaseFactor : 2.5)
        ),
      })),
    });
  }

  /* Repasos en el futuro */
  const futureReviews = input.topics.filter(
    (topic) => topic.lastReviewedAt !== null && startOfDay(topic.lastReviewedAt) > today
  );
  if (futureReviews.length > 0) {
    fixes.push({
      id: 'repaso_en_el_futuro',
      label: findings.get('repaso_en_el_futuro')?.fixLabel ?? 'Limpiar fechas futuras',
      description: 'Quita la fecha de repaso (no el historial) de esas unidades: vuelven a la primera pasada.',
      count: futureReviews.length,
      safe: true,
      operations: futureReviews.map((topic) => ({ kind: 'clear_future_review' as const, topicId: topic.id })),
    });
  }

  /* Estados incoherentes */
  const oddStatus = input.topics.filter(
    (topic) => topic.status === 'repasado' && topic.lastReviewedAt === null
  );
  const badStates = input.topics.filter((topic) => !isUnitStatus(topic.status));
  if (oddStatus.length > 0 || badStates.length > 0) {
    fixes.push({
      id: 'estados_incoherentes',
      label: `Corregir ${oddStatus.length + badStates.length} estado(s)`,
      description:
        'Las marcadas como «repasado» sin ningún repaso pasan a «visto en clase». Las que tienen un estado que no existe pasan a «pendiente».',
      count: oddStatus.length + badStates.length,
      safe: true,
      operations: [
        ...oddStatus.map((topic) => ({
          kind: 'fix_topic_status' as const,
          topicId: topic.id,
          status: 'visto',
        })),
        ...badStates.map((topic) => ({
          kind: 'fix_topic_status' as const,
          topicId: topic.id,
          status: 'pendiente',
        })),
      ],
    });
  }

  /* Exámenes caducados */
  const staleExams = input.exams.filter(
    (exam) => !exam.isCompleted && startOfDay(exam.examDate) < today
  );
  if (staleExams.length > 0) {
    fixes.push({
      id: 'examenes_caducados',
      label: findings.get('examenes_caducados')?.fixLabel ?? 'Cerrar exámenes pasados',
      description:
        'Marca como realizados los exámenes cuya fecha ya pasó. Dejan de dar urgencia al planificador; la nota se puede seguir poniendo después.',
      count: staleExams.length,
      safe: false,
      operations: staleExams.map((exam) => ({ kind: 'complete_exam' as const, examId: exam.id })),
    });
  }

  /* Hábitos: registros repetidos */
  // Los registros sobrantes los resuelve quien carga los datos (mantenimientoData),
  // porque sabe qué ids hay: aquí solo se juntan para el plan de borrado.
  const extraLogIds = input.habits.flatMap((habit) => habit.extraLogIds ?? []);
  if (extraLogIds.length > 0) {
    fixes.push({
      id: 'habitos_duplicados',
      label: findings.get('habitos_duplicados')?.fixLabel ?? 'Limpiar registros repetidos',
      description:
        'Borra los registros de hábito sobrantes del mismo día, conservando el primero de cada uno.',
      count: extraLogIds.length,
      safe: true,
      operations: extraLogIds.map((logId) => ({ kind: 'delete_habit_log' as const, logId })),
    });
  }

  /* Hábitos */
  const negativeStreaks = input.habits.filter((habit) => habit.streak < 0);
  if (negativeStreaks.length > 0) {
    fixes.push({
      id: 'racha_negativa',
      label: findings.get('racha_negativa')?.fixLabel ?? 'Poner rachas a cero',
      description: 'Pone a cero las rachas negativas.',
      count: negativeStreaks.length,
      safe: true,
      operations: negativeStreaks.map((habit) => ({
        kind: 'clamp_habit_streak' as const,
        habitId: habit.id,
        streak: 0,
      })),
    });
  }

  /* Retos caducados */
  const staleChallenges = input.challenges.filter(
    (challenge) => challenge.status === 'active' && challenge.weekKey !== input.weekKey
  );
  if (staleChallenges.length > 0) {
    fixes.push({
      id: 'retos_caducados',
      label: findings.get('retos_caducados')?.fixLabel ?? 'Cerrar retos pasados',
      description:
        'Marca como quedados a medias los retos de semanas anteriores que siguen activos. No toca los de esta semana ni la XP ya ganada.',
      count: staleChallenges.length,
      safe: true,
      operations: staleChallenges.map((challenge) => ({
        kind: 'expire_challenge' as const,
        challengeId: challenge.id,
      })),
    });
  }

  /* Apuntes con restos de código: se pasan por el mismo limpiador que al guardar */
  const notesWithCode = (input.notes ?? []).filter((note) => noteCodeRemnants(note.content).length > 0);
  if (notesWithCode.length > 0) {
    fixes.push({
      id: 'apuntes_con_codigo',
      label: findings.get('apuntes_con_codigo')?.fixLabel ?? `Limpiar ${notesWithCode.length} apunte(s)`,
      description:
        'Pasa cada apunte por el mismo limpiador que se usa al escribir uno nuevo: la valla con LaTeX vuelve como fórmula de verdad, el desplegable viejo pasa a su forma limpia y las etiquetas HTML y los saltos escapados desaparecen. No cambia ni una palabra del contenido.',
      count: notesWithCode.length,
      safe: true,
      operations: notesWithCode.map((note) => ({ kind: 'clean_note_code' as const, noteId: note.id })),
    });
  }

  return fixes;
}

/** Resumen de una pasada: cuántos hallazgos por gravedad. */
export function summarizeFindings(findings: MaintenanceFinding[]): {
  critico: number;
  aviso: number;
  info: number;
  total: number;
  fixable: number;
} {
  return {
    critico: findings.filter((finding) => finding.severity === 'critico').length,
    aviso: findings.filter((finding) => finding.severity === 'aviso').length,
    info: findings.filter((finding) => finding.severity === 'info').length,
    total: findings.length,
    fixable: findings.filter((finding) => finding.fixable).length,
  };
}

/* ------------------------------------------------------------------ */
/* 4. Leer lo que propone la IA                                          */
/* ------------------------------------------------------------------ */

/** Una propuesta de la IA sobre una unidad del temario. */
export interface MaintenanceProposal {
  /** «renombrar», «borrar», «renumerar» o «dudar». */
  action: string;
  /** Título exacto de la unidad sobre la que propone algo. */
  target: string;
  reason: string;
}

/** Las acciones que entiende la auditoría del taller (las cuatro de siempre). */
export const AUDIT_ACTIONS = ['renombrar', 'borrar', 'renumerar', 'dudar'] as const;

/**
 * Las acciones de la IA de guardia: las de la auditoría **más** las que solo
 * tienen sentido cuando nadie está mirando (limpiar un título, acotar un SRS,
 * devolver un nivel a neutro). Sigue siendo una lista cerrada: la IA elige, no
 * improvisa.
 */
export const VIGILANTE_ACTIONS = [
  ...AUDIT_ACTIONS,
  'limpiar',
  'estado',
  'nivel',
  'srs',
] as const;

/**
 * Lee las líneas `ACCION | UNIDAD | MOTIVO` que devuelve la IA y las convierte
 * en propuestas. Se descarta todo lo que no encaje en el formato: es la única
 * forma de que un texto libre no acabe tocando el temario por su cuenta.
 *
 * Está aquí (y no en la acción del taller) porque el vigilante usa **el mismo**
 * parser: lo que el alumno revisa en el taller y lo que aplica la IA de guardia
 * tienen que leerse igual. La diferencia entre los dos es solo `allowed`.
 */
export function parseAuditReply(
  raw: string,
  allowed: readonly string[] = AUDIT_ACTIONS
): MaintenanceProposal[] {
  const proposals: MaintenanceProposal[] = [];

  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim().replace(/^[-*]\s*/, '');
    if (trimmed.length === 0) continue;

    const parts = trimmed.split('|').map((part) => part.trim());
    if (parts.length < 3) continue;

    const action = parts[0].toLowerCase().replace(/[^a-záéíóúñ]/g, '');
    if (!allowed.includes(action)) continue;

    const target = parts[1];
    const reason = parts.slice(2).join(' | ');
    if (target.length === 0 || reason.length === 0) continue;

    proposals.push({ action, target, reason: reason.slice(0, 240) });
  }

  return proposals;
}
