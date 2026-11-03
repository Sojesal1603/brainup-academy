/**
 * Puesta a punto: la entrevista con la IA que monta el sistema contigo.
 *
 * Este módulo es PURO (sin base de datos, sin red) y hace tres cosas:
 *   1. Describe el protocolo de etiquetas que el entrevistador emite mientras
 *      habla: cada etiqueta es una acción real sobre tu sistema (un temario, un
 *      examen, tus horas…). Se parsean aquí y se aplican después.
 *   2. Calcula el estado de la puesta a punto (qué falta por materia) para que
 *      el entrevistador sepa siempre qué pregunta toca y tú veas el progreso.
 *   3. Redacta su prompt de sistema: pregunta de una en una, no inventa nada y
 *      acepta correcciones en cualquier momento.
 *
 * Regla de oro, la misma que en el resto de la app: lo que no has dicho tú no
 * existe. Si el alumno no sabe un dato, se pregunta; nunca se rellena solo.
 */

/** Título de la conversación de la puesta a punto (una sola, reutilizada). */
import { buildSystemKnowledgeForAi } from './systemKnowledge';

export const SETUP_CONVERSATION_TITLE = 'Puesta a punto';

export type SetupUnitSource = 'profesor' | 'libro' | 'ia' | 'entrevista';

export const SETUP_SOURCES: SetupUnitSource[] = ['profesor', 'libro', 'ia', 'entrevista'];

export type SetupAction =
  | { kind: 'focus'; subject: string }
  | { kind: 'source'; source: SetupUnitSource }
  | { kind: 'replace'; subject: string | null }
  | { kind: 'unit'; title: string; term: number | null; difficulty: number | null }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'drop-unit'; title: string }
  | { kind: 'exam'; date: string; title: string; subject: string | null; weight: number | null; target: number | null }
  | { kind: 'drop-exam'; title: string }
  | { kind: 'move-exam'; title: string; date: string }
  /**
   * Una clase del horario: qué día, a qué hora y de qué materia.
   *
   * Es el dato que faltaba para que la organización no sea arbitraria: sin el
   * horario lectivo, el plan de la tarde no sabe qué se ha explicado hoy ni qué
   * toca mañana, y el reparto por asignaturas se vuelve una corazonada.
   */
  | { kind: 'class'; day: number; start: string; end: string; period: number; subject: string | null; room: string | null }
  /** Quitar del horario (toda la materia, o solo un día). `day` null = todos. */
  | { kind: 'drop-class'; day: number | null; subject: string }
  /**
   * Marcar si una materia se trabaja en la app o solo está en el horario.
   *
   * Es la diferencia entre «Religión, de 12:25 a 13:20 los martes» (una hora que
   * no puedes usar para estudiar, pero que existe y desordena la tarde si no se
   * ve) y «Religión: dime el temario y las fechas de examen» (datos que no
   * existen y que el coordinador no debe pedir).
   */
  | { kind: 'track'; subject: string; tracked: boolean }
  /** El alumno confirma que el temario de esa materia está ENTERO. */
  | { kind: 'syllabus-complete'; subject: string | null }
  /** El alumno confirma que ha repasado el horario de los cinco días. */
  | { kind: 'timetable-complete' }
  | { kind: 'hours'; weekly: number }
  | { kind: 'mode'; mode: 'comfort' | 'athlete' }
  | { kind: 'pau-target'; value: number };

export interface SetupParseResult {
  /** Mensaje sin etiquetas: lo que se lee en el chat. */
  text: string;
  actions: SetupAction[];
  /** Etiquetas que se han visto pero no se han podido aplicar. */
  rejected: string[];
}

export const MAX_SETUP_ACTIONS = 240;
const MAX_TITLE = 180;

/* ------------------------------------------------------------------ */
/* Etiquetas                                                           */
/* ------------------------------------------------------------------ */

const TAG = /\[\[\s*([a-záéíóúñ-]+)\s*(?::([^\]]*))?\]\]/gi;

function splitParts(value: string): string[] {
  return value.split('|').map((part) => part.trim());
}

function parseTerm(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/[123]/);
  return match ? Number(match[0]) : null;
}

function parseDifficulty(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/[1-5]/);
  return match ? Number(match[0]) : null;
}

/** Cómo se llama cada día al enseñarlo en el chat. */
const DAY_LABEL: Record<number, string> = { 1: 'lunes', 2: 'martes', 3: 'miércoles', 4: 'jueves', 5: 'viernes' };

/**
 * Horas de las seis primeras clases del día en un instituto (la 4ª va después
 * del recreo). Son las que usa el horario de ejemplo y las que se aplican cuando
 * el alumno dice «los lunes a primera hora» en vez de dar las horas.
 */
export const CLASS_PERIOD_TIMES: Array<[string, string]> = [
  ['08:15', '09:10'],
  ['09:10', '10:05'],
  ['10:05', '11:00'],
  ['11:30', '12:25'],
  ['12:25', '13:20'],
  ['13:20', '14:15'],
];

/** Iniciales por día de la semana (`1` = lunes … `5` = viernes), como la base. */
const DAY_NAMES: Record<string, number> = {  l: 1,
  lunes: 1,
  m: 2,
  martes: 2,
  x: 3,
  mi: 3,
  miercoles: 3,
  miércoles: 3,
  j: 4,
  jueves: 4,
  v: 5,
  viernes: 5,
};

/** «L», «martes», «miércoles» → 1..5. Cualquier otra cosa, null. */
export function parseClassDay(value: string | undefined): number | null {
  const key = clean(value).toLowerCase().replace(/\.$/, '');
  if (key.length === 0) return null;
  return DAY_NAMES[key] ?? null;
}

function hmToMinutes(value: string): number | null {
  const match = String(value)
    .trim()
    .match(/^(\d{1,2})[:.h](\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesToHm(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, total));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/** Número de clase (1..6) que le corresponde a una hora de inicio. */
function periodOfStart(startMinutes: number): number {
  for (let index = 0; index < CLASS_PERIOD_TIMES.length; index++) {
    if (hmToMinutes(CLASS_PERIOD_TIMES[index][0])! >= startMinutes) return index + 1;
  }
  return CLASS_PERIOD_TIMES.length;
}

/**
 * La franja de una clase: «1» (número de hora), «08:15» (inicio) o
 * «08:15-09:10» (inicio y fin). Devuelve null si no se entiende.
 */
export function parseClassSlot(value: string | undefined): { start: string; end: string; period: number } | null {
  const raw = String(value ?? '').trim();
  if (raw.length === 0) return null;

  const range = raw.match(/^(\d{1,2}[:.h]\d{2})\s*(?:-|–|a|hasta)\s*(\d{1,2}[:.h]\d{2})$/i);
  if (range) {
    const start = hmToMinutes(range[1]);
    const end = hmToMinutes(range[2]);
    if (start === null || end === null || end <= start) return null;
    return {
      start: minutesToHm(start),
      end: minutesToHm(end),
      period: periodOfStart(start),
    };
  }

  const single = hmToMinutes(raw);
  if (single !== null) {
    return { start: minutesToHm(single), end: minutesToHm(single + 55), period: periodOfStart(single) };
  }

  const number = raw.match(/^(\d)(?:ª|a|º)?$/);
  if (number) {
    const period = Number(number[1]);
    if (period < 1 || period > 8) return null;
    const slot = CLASS_PERIOD_TIMES[period - 1];
    if (slot) return { start: slot[0], end: slot[1], period };
    // Séptima u octava hora: se encadenan de 55 en 55 desde la última conocida.
    const last = CLASS_PERIOD_TIMES[CLASS_PERIOD_TIMES.length - 1];
    const start = hmToMinutes(last[1])! + (period - CLASS_PERIOD_TIMES.length) * 55;
    return { start: minutesToHm(start), end: minutesToHm(start + 55), period };
  }

  return null;
}

/** Fecha del enunciado: AAAA-MM-DD o DD/MM/AAAA. Devuelve ISO o null. */
export function parseSetupDate(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value.trim();

  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const latin = clean.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);

  let year: number;
  let month: number;
  let day: number;

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (latin) {
    day = Number(latin[1]);
    month = Number(latin[2]);
    year = Number(latin[3]);
    if (year < 100) year += 2000;
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function clean(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/**
 * Lee la respuesta del entrevistador y separa lo que se ve de lo que se aplica.
 * Sin etiquetas, el mensaje es solo conversación: no toca nada.
 */
export function parseSetupTags(raw: string): SetupParseResult {
  const actions: SetupAction[] = [];
  const rejected: string[] = [];

  const text = String(raw ?? '')
    .replace(TAG, (whole, rawName: string, rawValue: string | undefined) => {
      const name = rawName.toLowerCase();
      const value = rawValue ?? '';
      const parts = splitParts(value);

      if (actions.length >= MAX_SETUP_ACTIONS) {
        rejected.push(whole);
        return '';
      }

      switch (name) {
        case 'asignatura': {
          const subject = clean(parts[0]);
          if (!subject) break;
          actions.push({ kind: 'focus', subject });
          return '';
        }
        case 'origen': {
          const candidate = clean(parts[0]).toLowerCase() as SetupUnitSource;
          if (!SETUP_SOURCES.includes(candidate)) {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'source', source: candidate });
          return '';
        }
        case 'sustituir': {
          actions.push({ kind: 'replace', subject: parts[0] ? clean(parts[0]) : null });
          return '';
        }
        case 'unidad': {
          const title = clean(parts[0]);
          if (title.length < 2) {
            rejected.push(whole);
            return '';
          }
          actions.push({
            kind: 'unit',
            title,
            term: parseTerm(parts[1]),
            difficulty: parseDifficulty(parts[2]),
          });
          return '';
        }
        case 'renombrar': {
          const from = clean(parts[0]);
          const to = clean(parts[1]);
          if (!from || !to) {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'rename', from, to });
          return '';
        }
        case 'borrar-unidad':
        case 'borrarunidad': {
          const title = clean(parts[0]);
          if (!title) {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'drop-unit', title });
          return '';
        }
        case 'examen': {
          const date = parseSetupDate(parts[0]);
          const title = clean(parts[1]);
          if (!date || title.length < 2) {
            rejected.push(whole);
            return '';
          }
          const weight = parts[3] ? Number(parts[3].replace('%', '').replace(',', '.')) : null;
          const target = parts[4] ? Number(parts[4].replace(',', '.')) : null;
          actions.push({
            kind: 'exam',
            date,
            title,
            subject: parts[2] ? clean(parts[2]) : null,
            weight: Number.isFinite(weight) && weight! > 0 && weight! <= 100 ? weight : null,
            target: Number.isFinite(target) && target! >= 0 && target! <= 10 ? target : null,
          });
          return '';
        }
        case 'borrar-examen':
        case 'borrarexamen': {
          const title = clean(parts[0]);
          if (title.length < 2) {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'drop-exam', title });
          return '';
        }
        case 'mover-examen':
        case 'moverexamen': {
          // Admite las dos formas: [[mover-examen:2026-11-14|Parcial 1]] (lo que
          // dicta el protocolo) y [[mover-examen:Parcial 1|2026-11-14]] (el orden
          // al revés, que el modelo escribe a veces). Se detecta por la forma.
          const firstIsDate = parseSetupDate(parts[0]) !== null;
          const date = parseSetupDate(firstIsDate ? parts[0] : parts[1]);
          const title = clean(firstIsDate ? parts[1] : parts[0]);
          if (!date || title.length < 2) {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'move-exam', title, date });
          return '';
        }
        case 'clase': {
          const day = parseClassDay(parts[0]);
          const slot = parseClassSlot(parts[1]);
          const subject = parts[2] ? clean(parts[2]) : '';
          const room = parts[3] ? clean(parts[3]) : '';
          if (day === null || !slot) {
            rejected.push(whole);
            return '';
          }
          actions.push({
            kind: 'class',
            day,
            start: slot.start,
            end: slot.end,
            period: slot.period,
            subject: subject.length > 0 ? subject : null,
            room: room.length > 0 ? room : null,
          });
          return '';
        }
        case 'solo-horario':
        case 'solohorario': {
          const subject = clean(parts[0]);
          if (subject.length < 2) {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'track', subject, tracked: false });
          return '';
        }
        case 'estudiar':
        case 'si-estudiar': {
          const subject = clean(parts[0]);
          if (subject.length < 2) {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'track', subject, tracked: true });
          return '';
        }
        case 'temario-completo':
        case 'tematico-completo': {
          actions.push({ kind: 'syllabus-complete', subject: parts[0] ? clean(parts[0]) : null });
          return '';
        }
        case 'horario-completo':
        case 'horariocompleto': {
          actions.push({ kind: 'timetable-complete' });
          return '';
        }
        case 'borrar-clase':
        case 'borrarclase': {
          const day = parseClassDay(parts[0]);
          // Dos formas: [[borrar-clase:M|Matemáticas I]] (ese día) y
          // [[borrar-clase:Matemáticas I]] (todos los días).
          const subject = clean(day !== null && parts[1] ? parts[1] : parts[0]);
          if (subject.length < 2) {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'drop-class', day: day !== null && parts[1] ? day : null, subject });
          return '';
        }
        case 'horas': {
          const weekly = Number(String(parts[0]).replace(',', '.').replace(/[^\d.]/g, ''));
          if (!Number.isFinite(weekly) || weekly < 1 || weekly > 80) {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'hours', weekly });
          return '';
        }
        case 'ritmo': {
          const mode = clean(parts[0]).toLowerCase();
          if (mode !== 'comfort' && mode !== 'athlete') {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'mode', mode });
          return '';
        }
        case 'meta-pau': {
          const value2 = Number(String(parts[0]).replace(',', '.').replace(/[^\d.]/g, ''));
          if (!Number.isFinite(value2) || value2 < 5 || value2 > 14) {
            rejected.push(whole);
            return '';
          }
          actions.push({ kind: 'pau-target', value: value2 });
          return '';
        }
        default:
          rejected.push(whole);
          return '';
      }

      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, actions, rejected };
}

/* ------------------------------------------------------------------ */
/* Estado de la puesta a punto                                         */
/* ------------------------------------------------------------------ */

export interface SetupSubjectState {
  id: string;
  name: string;
  units: number;
  /** ¿Se trabaja en la app? Si no, solo está en el horario. */
  tracked: boolean;
  /** ¿Ha confirmado el alumno que el temario está entero? */
  syllabusComplete: boolean;
  /** Clases que tiene a la semana. */
  classCount: number;
  /** Exámenes con fecha futura. */
  upcomingExams: number;
  /** Próximo examen, si lo hay. */
  nextExam: { title: string; date: string } | null;
  /**
   * TODOS los exámenes con fecha que hay apuntados, con su título exacto.
   *
   * Hace falta verlos enteros —y no solo el próximo— para poder corregirlos por
   * voz: si el alumno dice «ese examen no existe», el coordinador necesita el
   * título tal y como está guardado para poder quitarlo.
   */
  exams: Array<{ title: string; date: string }>;
  /** Unidades que está dando ahora (para saber por dónde va el curso). */
  currentUnit: string | null;
}

export interface SetupSnapshot {
  today: string;
  studentName: string;
  modality: string;
  targetPau: number;
  weeklyHoursCap: number;
  weeklyHoursDeclared: boolean;
  studyMode: 'comfort' | 'athlete';
  /** Días y horas de clase por materia ("Matemáticas I: L 08:15-09:10, X …"). */
  timetable: string[];
  /** Clases apuntadas en total (una por día y hora). */
  classCount: number;
  /** Horas de clase a la semana: el tiempo que NO está libre para estudiar. */
  weeklyClassHours: number;
  /** ¿Ha repasado el horario de los cinco días con el coordinador? */
  timetableComplete: boolean;
  /** Materias que están en el horario pero no se trabajan en la app. */
  untracked: string[];
  subjects: SetupSubjectState[];
  setupCompletedAt: string | null;
}

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  hint: string;
}

export interface ChecklistSubject {
  id: string;
  name: string;
  units: number;
  exams: number;
  /** ¿El temario está confirmado como entero? */
  syllabusComplete: boolean;
  items: ChecklistItem[];
  done: boolean;
}

/** Materia que solo está en el horario: no se le pide temario ni exámenes. */
export interface ChecklistUntracked {
  id: string;
  name: string;
  classCount: number;
}

export interface SetupChecklist {
  subjects: ChecklistSubject[];
  untracked: ChecklistUntracked[];
  general: ChecklistItem[];
  doneItems: number;
  totalItems: number;
  percent: number;
  /** Materias a las que les falta algo. */
  pending: ChecklistSubject[];
  complete: boolean;
  /** La pregunta que toca ahora mismo. */
  nextQuestion: { subjectId: string | null; subjectName: string | null; about: 'temario' | 'examenes' | 'horas' | 'horario' | 'cierre'; prompt: string };
}

/**
 * Qué falta y qué toca preguntar. Es la misma cuenta que ve el alumno en el
 * panel: sin esto el entrevistador iría a ciegas o repetiría preguntas.
 *
 * DOS REGLAS QUE HACEN QUE EL CURSO SEA REALISTA Y NO UNA LISTA:
 *   · Solo se piden temario y exámenes de las materias que se trabajan. Las que
 *     solo están en el horario (Religión, Educación Física…) cuentan para las
 *     horas ocupadas, no para lo que hay que estudiar.
 *   · Un temario no está completo por tener unidades: hace falta que el alumno
 *     confirme que no falta ninguna. Con 3 de 12 unidades, el plan saldría
 *     corto y el examen le pillaría sin la mitad del curso.
 */
export function buildSetupChecklist(snapshot: SetupSnapshot): SetupChecklist {
  const subjects: ChecklistSubject[] = snapshot.subjects
    .filter((subject) => subject.tracked)
    .map((subject) => {
      const items: ChecklistItem[] = [
        {
          key: 'temario',
          label: 'Temario',
          done: subject.units > 0 && subject.syllabusComplete,
          hint:
            subject.units === 0
              ? 'sin unidades cargadas'
              : `${subject.units} unidades${subject.syllabusComplete ? ' · completo' : ' · falta confirmar que están todas'}`,
        },
        {
          key: 'examenes',
          label: 'Exámenes',
          done: subject.upcomingExams > 0,
          hint: subject.nextExam
            ? `${subject.nextExam.title} · ${subject.nextExam.date}`
            : 'sin fechas anotadas',
        },
      ];

      return {
        id: subject.id,
        name: subject.name,
        units: subject.units,
        exams: subject.upcomingExams,
        syllabusComplete: subject.syllabusComplete,
        items,
        done: items.every((item) => item.done),
      };
    });

  const untracked: ChecklistUntracked[] = snapshot.subjects
    .filter((subject) => !subject.tracked)
    .map((subject) => ({ id: subject.id, name: subject.name, classCount: subject.classCount }));

  const general: ChecklistItem[] = [
    {
      key: 'horas',
      label: 'Horas disponibles',
      done: snapshot.weeklyHoursDeclared,
      hint: `${snapshot.weeklyHoursCap} h/semana`,
    },
    {
      key: 'ritmo',
      label: 'Ritmo de estudio',
      done: true,
      hint: snapshot.studyMode === 'athlete' ? 'Modo Atleta' : 'Zona de Confort',
    },
    {
      key: 'horario',
      label: 'Horario de clases',
      done: snapshot.timetableComplete,
      hint:
        snapshot.classCount === 0
          ? 'sin horario todavía'
          : `${snapshot.classCount} clases · ${snapshot.weeklyClassHours} h/semana${
              snapshot.timetableComplete ? '' : ' · falta repasar los cinco días'
            }`,
    },
  ];

  const all = [...subjects.flatMap((subject) => subject.items), ...general];
  const doneItems = all.filter((item) => item.done).length;
  const pending = subjects.filter((subject) => !subject.done);

  const subjectMissingUnits = subjects.find((subject) => subject.units === 0);
  // Un temario a medias no se da por bueno: se pregunta por las unidades que
  // faltan antes de pasar a las fechas de examen.
  const subjectIncompleteSyllabus = subjects.find(
    (subject) => subject.units > 0 && !subject.syllabusComplete
  );
  const subjectMissingExams = subjects.filter((subject) => subject.exams === 0);
  const horas = general.find((item) => item.key === 'horas')!;
  const horario = general.find((item) => item.key === 'horario')!;

  let nextQuestion: SetupChecklist['nextQuestion'];

  if (!horas.done) {
    nextQuestion = {
      subjectId: null,
      subjectName: null,
      about: 'horas',
      prompt: 'Cuántas horas reales puedes estudiar a la semana',
    };
  } else if (!horario.done) {
    // El horario se pregunta antes que el temario a propósito: es lo que dice
    // cuándo se da cada materia y, con eso, la tarde se puede estructurar de
    // verdad (repasar lo de hoy y preparar lo de mañana) en vez de repartir
    // horas a bulto entre asignaturas.
    nextQuestion = {
      subjectId: null,
      subjectName: null,
      about: 'horario',
      prompt:
        snapshot.classCount === 0
          ? 'Qué días y a qué horas tienes clase de cada asignatura (todas, también las que no estudias)'
          : 'Repasar el horario entero: qué día y hora tiene cada clase, incluidas las materias que no estudias',
    };
  } else if (subjectMissingUnits) {
    nextQuestion = {
      subjectId: subjectMissingUnits.id,
      subjectName: subjectMissingUnits.name,
      about: 'temario',
      prompt: `El temario completo de ${subjectMissingUnits.name}: todas sus unidades, de la primera a la última`,
    };
  } else if (subjectIncompleteSyllabus) {
    nextQuestion = {
      subjectId: subjectIncompleteSyllabus.id,
      subjectName: subjectIncompleteSyllabus.name,
      about: 'temario',
      prompt: `Confirmar que el temario de ${subjectIncompleteSyllabus.name} está entero (o dictar las unidades que faltan)`,
    };
  } else if (subjectMissingExams.length > 0) {
    nextQuestion = {
      subjectId: subjectMissingExams[0].id,
      subjectName: subjectMissingExams[0].name,
      about: 'examenes',
      prompt: `Las fechas de examen de ${subjectMissingExams[0].name}`,
    };
  } else {
    nextQuestion = {
      subjectId: null,
      subjectName: null,
      about: 'cierre',
      prompt: 'Cerrar la puesta a punto',
    };
  }

  return {
    subjects,
    untracked,
    general,
    doneItems,
    totalItems: all.length,
    percent: all.length === 0 ? 0 : Math.round((doneItems / all.length) * 100),
    pending,
    complete: pending.length === 0 && general.every((item) => item.done),
    nextQuestion,
  };
}

/* ------------------------------------------------------------------ */
/* Lo que se ha aplicado (para enseñarlo en el chat)                   */
/* ------------------------------------------------------------------ */

export function summarizeActions(actions: SetupAction[], subjectName: string | null): string[] {
  const lines: string[] = [];
  const units = actions.filter((action) => action.kind === 'unit').length;
  const exams = actions.filter((action) => action.kind === 'exam') as Array<Extract<SetupAction, { kind: 'exam' }>>;

  if (units > 0) lines.push(`${units} ${units === 1 ? 'unidad anotada' : 'unidades anotadas'}${subjectName ? ` en ${subjectName}` : ''}`);
  for (const exam of exams) {
    lines.push(`Examen el ${exam.date}: ${exam.title}${exam.subject ? ` (${exam.subject})` : ''}`);
  }
  for (const action of actions) {
    if (action.kind === 'rename') lines.push(`Renombrada: «${action.from}» → «${action.to}»`);
    if (action.kind === 'drop-unit') lines.push(`Borrada la unidad «${action.title}»`);
    if (action.kind === 'drop-exam') lines.push(`Quitado el examen «${action.title}»`);
    if (action.kind === 'move-exam') lines.push(`Examen «${action.title}» movido al ${action.date}`);
    if (action.kind === 'class') {
      lines.push(
        `Clase el ${DAY_LABEL[action.day] ?? '?'} de ${action.start} a ${action.end}: ${action.subject ?? subjectName ?? 'materia'}${action.room ? ` (${action.room})` : ''}`
      );
    }
    if (action.kind === 'drop-class') {
      lines.push(
        action.day === null
          ? `Fuera del horario: ${action.subject}`
          : `Fuera del horario: ${action.subject} los ${DAY_LABEL[action.day] ?? '?'}`
      );
    }
    if (action.kind === 'track') {
      lines.push(
        action.tracked
          ? `Se trabaja en la app: ${action.subject}`
          : `Solo en el horario (sin temario ni exámenes): ${action.subject}`
      );
    }
    if (action.kind === 'syllabus-complete') {
      lines.push(
        `Temario confirmado como completo${action.subject ? `: ${action.subject}` : ''}`
      );
    }
    if (action.kind === 'timetable-complete') lines.push('Horario de clases repasado: completo');
    if (action.kind === 'replace') lines.push(`Temario sustituido${action.subject ? ` en ${action.subject}` : ''}`);
    if (action.kind === 'hours') lines.push(`Horas disponibles: ${action.weekly} h/semana`);
    if (action.kind === 'mode') lines.push(action.mode === 'athlete' ? 'Ritmo: Modo Atleta' : 'Ritmo: Zona de Confort');
    if (action.kind === 'pau-target') lines.push(`Nota PAU objetivo: ${action.value}`);
    if (action.kind === 'focus') lines.push(`Materia en la que estamos: ${action.subject}`);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Prompt del entrevistador                                            */
/* ------------------------------------------------------------------ */

export const SETUP_TAG_INSTRUCTION = `PROTOCOLO DE ACCIONES (etiquetas invisibles para el alumno).
Escribe cada etiqueta en su PROPIA línea, justo cuando tengas el dato. El alumno no las ve: el sistema las ejecuta y le enseña el resultado. Nunca inventes un dato para poder emitir una etiqueta.

- [[asignatura:Matemáticas I]] → la materia sobre la que trabajamos ahora. Si no existe, se crea.
- [[origen:profesor]] → de dónde sale la lista que vas a anotar: profesor | libro | ia | entrevista.
  · Por defecto NO emitas esta etiqueta: las unidades quedan como «de tu puesta a punto» (salieron de tus respuestas), que es la etiqueta honesta.
  · Usa «profesor» o «libro» SOLO si él dice expresamente que esa lista es la de su profesor o la de su libro.
  · Usa «ia» SOLO si te pide expresamente que la propongas tú, y avísale en el texto de que es una propuesta a revisar.
- [[unidad:Título de la unidad|1|3]] → una unidad del temario de la materia actual. La evaluación (1, 2 o 3) y la dificultad (1-5) son opcionales: ponlas solo si te las ha dicho.
- [[sustituir:Matemáticas I]] → lo que venga después sustituye el temario de esa materia. ÚSALO cuando él pida expresamente reemplazarlo («sustituye el temario de Lengua por este») o te dicte la lista entera otra vez, desde la unidad 1. **Aunque la lista sea más corta: si lo ha pedido él, el sistema lo aplica.** NUNCA lo uses al contestar una duda ni por iniciativa propia. Si no estás seguro, no lo emitas.
- [[renombrar:Título viejo=Título nuevo]] → corregir una unidad concreta.
- [[borrar-unidad:Título exacto]] → quitar una unidad que no existe o que se coló.
- [[examen:2026-11-14|Parcial 1|Matemáticas I|30|9]] → fecha | título | materia (opcional si ya estamos en ella) | peso % (opcional) | nota objetivo (opcional).
- [[mover-examen:2026-11-21|Parcial 1]] → esa fecha | título exacto del examen que YA está apuntado. Se usa cuando el profesor cambia la fecha o cuando te dice que se ha equivocado. NO le pidas que te lo repita: con el título que ya conoces basta.
- [[borrar-examen:Parcial 1]] → título exacto del examen que hay que quitar del sistema. Se usa cuando te dice que ese examen no existe, que ya no se hace, que estaba mal apuntado o cuando él mismo lo corrige. Es tan importante como apuntarlo: un examen que no existe con fecha inventada le desordena el plan y la cuenta atrás. Si te dice que «no hay exámenes», repasa con él los que el sistema tiene apuntados (los ves arriba) y quita los que no sean de verdad.
- [[clase:L|1|Matemáticas I|Aula 104]] → UNA clase de su horario: día (L, M, X, J o V) | hora (número de clase 1-6, o la hora de inicio «08:15», o el rango «08:15-09:10») | materia (si estamos en ella, se puede dejar vacío) | aula (opcional).
- [[borrar-clase:M|Matemáticas I]] → esa clase deja de existir (ese día). [[borrar-clase:Matemáticas I]] → esa materia sale del horario todos los días.
- [[solo-horario:Religión]] → esa materia está en el horario pero NO se estudia en la app: no se le pide temario, ni exámenes, ni se le asignan horas de estudio. Úsalo con Religión, Educación Física, Tutoría y cualquier materia que él diga que no entra en el curso. Sigue saliendo en el horario (sus horas cuentan como ocupadas).
- [[estudiar:Música]] → lo contrario: esa materia sí se trabaja (por si se marcó por error, o si al final sí entra en el examen).
- [[horario-completo]] → cuando hayáis repasado los CINCO días y no falta ninguna clase. Sin esta etiqueta el sistema no da el horario por cerrado y el plan queda cojo.
- [[temario-completo:Matemáticas I]] → el temario de esa materia está ENTERO (las 12 unidades, no las 3 que te dictó antes de cansarse). Sin esta etiqueta la app sigue preguntando por las que faltan y no da el temario por bueno.
- [[horas:18]] → horas semanales reales de estudio.
- [[ritmo:athlete]] → athlete (exigente, 4 bloques/día) o comfort (3 bloques/día).
- [[meta-pau:13.5]] → nota objetivo sobre 14.

Si detectas que te has equivocado o él te corrige, arréglalo con [[renombrar:…]], [[borrar-unidad:…]] o [[sustituir:…]] en ese mismo turno y confírmaselo.`;

function formatSnapshot(snapshot: SetupSnapshot, checklist: SetupChecklist): string[] {
  const lines: string[] = [];

  lines.push(`Hoy es ${snapshot.today}.`);
  lines.push(
    `Alumno: ${snapshot.studentName}, ${snapshot.modality}. Nota PAU objetivo: ${snapshot.targetPau}/14.`
  );
  lines.push(
    snapshot.weeklyHoursDeclared
      ? `Horas de estudio disponibles: ${snapshot.weeklyHoursCap} h/semana (declaradas por él). Ritmo: ${snapshot.studyMode === 'athlete' ? 'Modo Atleta' : 'Zona de Confort'}.`
      : `Todavía NO sabemos cuántas horas puede estudiar a la semana: pregúntaselo.`
  );

  if (snapshot.timetable.length > 0) {
    lines.push(
      `Horario de clase que ya tienes apuntado (${snapshot.classCount} clases, ${snapshot.weeklyClassHours} h/semana): ${snapshot.timetable.join(' · ')}.`
    );
    lines.push(
      snapshot.timetableComplete
        ? 'El alumno ha confirmado que el horario está completo (cinco días repasados).'
        : 'EL HORARIO NO ESTÁ CERRADO: repasa con él los cinco días (incluidas las materias que no estudia) y emite [[horario-completo]] al terminar.'
    );
  } else {
    lines.push(
      'NO hay horario de clases en el sistema: pregúntale qué días y a qué hora tiene cada asignatura, TODAS (también Religión, Educación Física o Tutoría). Es lo que permite saber cuánto tiempo tiene libre de verdad y organizarle la tarde según lo que tiene clase al día siguiente.'
    );
  }
  if (snapshot.untracked.length > 0) {
    lines.push(
      `Solo en el horario (no se les pide temario ni exámenes): ${snapshot.untracked.join(', ')}.`
    );
  }

  lines.push('');
  lines.push('ESTADO REAL DEL SISTEMA (esto es lo único que sabes; no supongas nada más):');

  for (const subject of snapshot.subjects) {
    if (!subject.tracked) {
      lines.push(`- ${subject.name}: SOLO en el horario (${subject.classCount} clases/semana). No le pidas temario ni exámenes.`);
      continue;
    }
    const parts = [
      `${subject.units} unidades${subject.units > 0 ? (subject.syllabusComplete ? ' (temario completo)' : ' (FALTA confirmar que estén todas)') : ''}`,
    ];
    if (subject.classCount > 0) parts.push(`${subject.classCount} clases/semana`);
    if (subject.nextExam) parts.push(`próximo examen: ${subject.nextExam.title} el ${subject.nextExam.date}`);
    else parts.push('sin exámenes con fecha');
    if (subject.currentUnit) parts.push(`dando ahora: ${subject.currentUnit}`);
    lines.push(`- ${subject.name}: ${parts.join(' · ')}`);
  }

  // Los exámenes con su título exacto: es lo que permite corregir uno por voz
  // ([[borrar-examen:…]] / [[mover-examen:…]]). Sin esto, el coordinador sabe
  // que hay un examen pero no cómo se llama, y no puede quitarlo.
  const withExams = snapshot.subjects.filter((subject) => subject.exams.length > 0);
  lines.push('');
  if (withExams.length === 0) {
    lines.push('EXÁMENES APUNTADOS: ninguno. No hay ninguna fecha de examen en el sistema.');
  } else {
    lines.push('EXÁMENES APUNTADOS AHORA MISMO (así, con este título exacto):');
    for (const subject of withExams) {
      for (const exam of subject.exams) {
        lines.push(`- «${exam.title}» — ${subject.name}, el ${exam.date}`);
      }
    }
  }

  const missing = checklist.pending.map((subject) => subject.name);
  lines.push('');
  if (missing.length > 0) {
    lines.push(`MATERIAS CON ALGO PENDIENTE: ${missing.join(', ')}.`);
  } else {
    lines.push('Todas las materias tienen temario y alguna fecha de examen.');
  }
  lines.push(
    `PROGRESO: ${checklist.doneItems}/${checklist.totalItems} datos puestos (${checklist.percent}%).`
  );
  lines.push(`AHORA TOCA PREGUNTAR POR: ${checklist.nextQuestion.prompt}.`);

  return lines;
}

export function buildSetupSystemPrompt(
  snapshot: SetupSnapshot,
  checklist: SetupChecklist,
  /**
   * Lo que ya se habló en la entrevista los días anteriores (lo escribe
   * `agentMemory.ts`). Vacío el primer día: entonces no se añade nada.
   */
  memory = ''
): string {
  const lines: string[] = [];

  lines.push('Eres el Coordinador de BrainUp Academy: el que monta el sistema a medida del alumno.');
  lines.push(
    'No eres un profesor de una materia: eres quien le entrevista para dejar su curso configurado (temario, exámenes, horas y rutina) y quien le mantiene la moral alta.'
  );
  lines.push('');
  lines.push('CÓMO ENTREVISTAS (el orden importa: es lo que convierte la app en un plan real y no en una lista de deseos):');
  lines.push(
    '1. Una cosa por turno. Haces UNA pregunta concreta, esperas la respuesta, la anotas con etiquetas y confirmas en una línea lo que has guardado. Nada de cuestionarios largos.'
  );
  lines.push(
    '2. EL ORDEN ES: (a) horas reales de estudio, (b) HORARIO COMPLETO de clases, (c) TEMARIO COMPLETO materia por materia, (d) fechas de examen, (e) cierre. No te saltes ningún paso ni cambies el orden salvo que él lo pida: sin horario, el plan no sabe cuánto tiempo libre hay; sin temario completo, el plan se queda corto.'
  );
  lines.push(
    '3. EL HORARIO ES EL DE VERDAD, CON TODAS LAS MATERIAS. Pregunta por días: «¿qué días tienes Matemáticas y a qué hora?». Una [[clase:…]] por cada clase (lunes, miércoles y viernes de Matemáticas son tres etiquetas). Incluye SIEMPRE las materias que no se estudian para la PAU (Religión, Educación Física, Tutoría, Música…): están en su horario y sus horas no están libres, así que márcalas con [[solo-horario:Materia]]. Cuando hayáis repasado los CINCO días, emite [[horario-completo]]. Si el profesor cambia una clase de sitio, [[borrar-clase:…]] y la nueva [[clase:…]].'
  );
  lines.push(
    '4. EL TEMARIO SE PIDE ENTERO, no una muestra. Antes de dictarlo, pregúntale CUÁNTAS UNIDADES tiene el temario («¿cuántas unidades entran en el curso?», «¿hasta qué tema llega el examen?»). Anota todas las que te diga y COMPARA el número: si te ha dictado 5 y él dijo 12, dile exactamente cuántas faltan y pídelas. Cuando estén todas, emite [[temario-completo:Matemáticas I]]. Si te dice que no sabe cuántas son, anota las que haya y NO cierres el temario: se completa otro día. Si te da prisa, una materia hoy y otra mañana, pero no des ninguna por completa sin confirmarlo.'
  );
  lines.push(
    '4b. SI PIDE SUSTITUIR UN TEMARIO, SE HACE EN ESE MISMO TURNO. Emite [[sustituir:Materia]] y a continuación TODAS las unidades de su lista, aunque sean menos que las que había: ha sido una orden suya y el sistema la acepta. No le pidas que las repita, no le pidas otra confirmación y dile exactamente cuántas unidades han quedado. Si la lista llega después (dice «ahora te la dicto»), deja la petición apuntada y aplícala en cuanto llegue.',
  );
  lines.push(
    '5. EXÁMENES: una fecha exacta por examen y materia (parcial, final, recuperación, simulacro). Si dice algo impreciso («a finales de mes»), pregúntale el día. Si no lo sabe, déjalo sin apuntar: mejor un hueco visible que una fecha inventada. Y SI UN EXAMEN APUNTADO NO ES REAL, QUÍTALO: arriba ves los que tienen fecha; si dice que no existe, que ya se hizo o que el profesor lo movió, arréglalo en ese turno con [[borrar-examen:Título]] o [[mover-examen:FECHA|Título]].'
  );
  lines.push(
    '6. NO INVENTES NADA. Nunca rellenes un temario, una fecha, una nota ni unas horas que él no haya dicho. Si no lo sabe, díselo con naturalidad y deja ese hueco: se puede completar otro día. Si te pide que propongas tú un temario, hazlo con [[origen:ia]] y avísale en el texto de que es una propuesta suya a revisar.'
  );
  lines.push(
    '7. CORRECCIONES: si te recuerda algo que faltaba o te corrige, aplícalo en ese mismo turno con las etiquetas (incluido borrar o renombrar) y confírmaselo con la frase exacta de lo que ha cambiado. Nunca digas que lo has hecho si no has emitido la etiqueta.'
  );
  lines.push(
    '8. HORAS Y RUTINA: cuando sepas sus horas reales, [[horas:N]] y explícale en dos líneas cómo queda su tarde. Ten en cuenta las horas de clase (no puede estudiar mientras está en clase): si sus horas declaradas son muchas pero su horario ocupa casi todo el día, díselo y propón un reparto realista. Si va agobiado, baja el ritmo a comfort; si va sobrado, súbelo.'
  );
  lines.push(
    '9. MOTIVACIÓN: cada confirmación va acompañada de una frase corta y concreta de ánimo, apoyada en datos reales (lo que ya lleva montado, lo que le falta para cerrar). Cero discursos vacíos y cero exageraciones: nada de «¡vas a arrasar!».'
  );
  lines.push(
    '10. CIERRE: no des la puesta a punto por terminada si falta el horario completo, algún temario sin confirmar o las fechas de examen. Dile qué queda exactamente y cuánto falta, sin dramatizar.'
  );
  lines.push('');
  lines.push('ESTILO: español, tuteo, frases cortas, máximo ~120 palabras por mensaje.');
  lines.push(
    'FORMATO: Markdown sencillo (negritas con **texto**, listas con «- »). No uses tablas ni bloques de código. No escribas las etiquetas dentro de negritas ni de listas.'
  );
  lines.push('');
  lines.push(...formatSnapshot(snapshot, checklist));

  // Memoria entre días: la entrevista dura varios días y el coordinador no puede
  // empezar de cero cada mañana preguntando lo que ya le contaste ayer.
  if (memory.trim().length > 0) {
    lines.push('');
    lines.push(memory.trim());
  }

  lines.push('');
  lines.push(SETUP_TAG_INSTRUCTION);
  lines.push('');
  // El coordinador es la primera IA con la que habla el alumno: tiene que poder
  // contestar cualquier duda sobre la app (dónde se carga el temario, por qué no
  // le salen retos, cómo conectar Moodle) sin inventarse pantallas.
  lines.push('PREGUNTAS SOBRE LA APP: si te pregunta por cualquier parte del sistema, contéstale con esto.');
  lines.push(buildSystemKnowledgeForAi());
  lines.push('');
  lines.push(
    'TERMINA SIEMPRE con la siguiente pregunta (una sola) para que él solo tenga que responder.'
  );

  return lines.join('\n');
}
