import { prisma } from './prisma';
import { regenerateWeeklyPlan } from './planner';
import { normalizeTopicTitle } from './temarioImport';
import { writeTemarioBackup } from './temarioBackup';
import { StudyMode } from './types';
import {
  buildSetupChecklist,
  type SetupAction,
  type SetupChecklist,
  type SetupSnapshot,
  type SetupUnitSource,
} from './setup';
import { consumePendingReplace, hasPendingReplace } from './setupReplaceIntent';

/** Opciones de aplicación de un turno. */
export interface SetupApplyOptions {
  /**
   * El alumno ha pedido EXPRESAMENTE reemplazar el temario en este turno. Con
   * esto, un reemplazo más corto sí se aplica (es lo que ha pedido); sin esto,
   * sigue bloqueado para no borrar datos por iniciativa del modelo.
   */
  allowReplace?: boolean;
  /** Materia concreta a la que se refiere la petición (si la ha nombrado). */
  allowReplaceSubject?: string | null;
}

/**
 * Aplica lo que el entrevistador ha anotado durante la conversación.
 *
 * Nada entra aquí sin haberlo dicho el alumno: cada acción escribe un dato real
 * en su sistema (temario, exámenes, horas, ritmo) y se devuelve la frase que ve
 * en el chat. Si una acción no se puede aplicar, se dice por qué en vez de
 * inventarse el dato o dejarlo a medias en silencio.
 */

const DAY_INITIALS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

/** Nombre del día para las frases que se le enseñan al alumno. */
const DAY_NAMES: Record<number, string> = { 1: 'lunes', 2: 'martes', 3: 'miércoles', 4: 'jueves', 5: 'viernes' };

/** Fila de asignatura tal y como la devuelve Prisma (sin temas ni exámenes). */
type SubjectRow = Awaited<ReturnType<typeof prisma.subject.findMany>>[number];

export interface SetupApplyResult {
  applied: string[];
  problems: string[];
  changed: boolean;
  blocks: number;
  snapshot: SetupSnapshot;
  checklist: SetupChecklist;
}

function todayLabel(): string {
  return new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Estado real del sistema: lo único que el entrevistador puede dar por sabido. */
export async function getSetupSnapshot(): Promise<SetupSnapshot> {
  const now = new Date();
  const [user, subjects, periods] = await Promise.all([
    prisma.userProfile.findUnique({ where: { id: 'user_default' } }),
    prisma.subject.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: {
        topics: { orderBy: [{ unitNumber: 'asc' }] },
        exams: { where: { examDate: { gte: now } }, orderBy: { examDate: 'asc' } },
      },
    }),
    prisma.classPeriod.findMany({
      select: { dayOfWeek: true, startTime: true, endTime: true, subjectId: true },
    }),
  ]);

  const periodsBySubject = new Map<string, typeof periods>();
  for (const period of periods) {
    if (!periodsBySubject.has(period.subjectId)) periodsBySubject.set(period.subjectId, []);
    periodsBySubject.get(period.subjectId)!.push(period);
  }

  // El horario se enseña con DÍA Y HORA, no solo con los días: «Matemáticas los
  // lunes» no dice si es a primera ni cuánto tiempo ocupa. Con las horas, el
  // coordinador puede cuadrar las horas libres reales del alumno.
  const timetable = subjects
    .filter((subject) => (periodsBySubject.get(subject.id)?.length ?? 0) > 0)
    .map((subject) => {
      const slots = [...(periodsBySubject.get(subject.id) ?? [])]
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime))
        .map((period) => `${DAY_INITIALS[period.dayOfWeek]} ${period.startTime}-${period.endTime}`)
        .join(', ');
      return `${subject.name}: ${slots}`;
    });

  /** Minutos entre dos horas «HH:MM» (0 si alguna no se entiende). */
  const minutesBetween = (start: string, end: string): number => {
    const parse = (value: string): number | null => {
      const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return null;
      return Number(match[1]) * 60 + Number(match[2]);
    };
    const from = parse(start);
    const to = parse(end);
    if (from === null || to === null || to <= from) return 0;
    return to - from;
  };

  const weeklyMinutesOfClass = periods.reduce(
    (total, period) => total + minutesBetween(period.startTime, period.endTime),
    0
  );

  return {
    today: todayLabel(),
    studentName: user?.name ?? 'Estudiante',
    modality: user?.modality ?? '1º de Bachillerato',
    targetPau: user?.targetGradePau ?? 13.5,
    weeklyHoursCap: user?.weeklyHoursCap ?? 25,
    weeklyHoursDeclared: user?.weeklyHoursDeclared ?? false,
    studyMode: (user?.studyMode as StudyMode) === 'comfort' ? 'comfort' : 'athlete',
    timetable,
    classCount: periods.length,
    weeklyClassHours: Math.round((weeklyMinutesOfClass / 60) * 10) / 10,
    timetableComplete: user?.timetableComplete ?? false,
    untracked: subjects.filter((subject) => !subject.isTracked).map((subject) => subject.name),
    subjects: subjects.map((subject) => {
      const upcoming = subject.exams;
      const inClass =
        [...subject.topics].reverse().find((topic) => topic.status === 'en_curso') ??
        [...subject.topics].reverse().find((topic) => topic.status === 'visto' || topic.status === 'repasado') ??
        null;

      return {
        id: subject.id,
        name: subject.name,
        units: subject.topics.length,
        tracked: subject.isTracked,
        syllabusComplete: subject.syllabusComplete,
        classCount: periodsBySubject.get(subject.id)?.length ?? 0,
        upcomingExams: upcoming.length,
        nextExam: upcoming[0]
          ? { title: upcoming[0].title, date: isoDay(new Date(upcoming[0].examDate)) }
          : null,
        exams: upcoming.map((exam) => ({
          title: exam.title,
          date: isoDay(new Date(exam.examDate)),
        })),
        currentUnit: inClass ? inClass.title : null,
      };
    }),
    setupCompletedAt: user?.setupCompletedAt ? isoDay(user.setupCompletedAt) : null,
  };
}

export async function getSetupState(): Promise<{ snapshot: SetupSnapshot; checklist: SetupChecklist }> {
  const snapshot = await getSetupSnapshot();
  return { snapshot, checklist: buildSetupChecklist(snapshot) };
}

function guessExamType(title: string): string {
  const text = normalizeTopicTitle(title);
  if (/simulacro|selectividad|pau|evau/.test(text)) return 'simulacro_pau';
  if (/final|global|ordinaria|extraordinaria/.test(text)) return 'final';
  return 'parcial';
}

/**
 * Aplica las acciones en orden. Devuelve también el estado nuevo, para que el
 * chat pueda enseñar el progreso y el siguiente paso sin recargar nada.
 */
export async function applySetupActions(
  actions: SetupAction[],
  options: SetupApplyOptions = {}
): Promise<SetupApplyResult> {
  const applied: string[] = [];
  const problems: string[] = [];
  let changed = false;

  let subjects: SubjectRow[] = await prisma.subject.findMany({ orderBy: [{ order: 'asc' }] });

  let focus: SubjectRow | null = null;
  let source: SetupUnitSource = 'entrevista';
  /** Número con el que sigue la siguiente unidad dentro de cada materia. */
  const cursors = new Map<string, number>();
  const unitTally = new Map<string, number>();
  const replaceArmed = new Set<string>();
  /**
   * Materias cuyo reemplazo se ha rechazado en este turno porque la lista nueva
   * era MÁS CORTA que la que ya había. Sus unidades se descartan (sin borrar
   * nada): es la red que impide que un «sustituir» mal puesto se lleve por
   * delante medio temario sin que el alumno lo haya pedido.
   */
  const replaceBlocked = new Set<string>();
  let playlistDirty = false;

  /**
   * Cuántas unidades vienen detrás de cada `[[sustituir:…]]` en este mismo
   * turno. Se cuenta antes de aplicar nada: sin saber el tamaño de la lista
   * nueva no se puede decidir si el reemplazo destruye datos o solo corrige.
   */
  const unitsAfterReplace = new Map<number, number>();
  actions.forEach((action, index) => {
    if (action.kind !== 'replace') return;
    let count = 0;
    for (let next = index + 1; next < actions.length; next++) {
      const following = actions[next];
      if (following.kind === 'unit') count++;
      else if (following.kind === 'focus' || following.kind === 'replace') break;
    }
    unitsAfterReplace.set(index, count);
  });

  const cursorFor = async (subjectId: string): Promise<number> => {
    if (cursors.has(subjectId)) return cursors.get(subjectId)!;
    const last = await prisma.topic.findFirst({
      where: { subjectId },
      orderBy: { unitNumber: 'desc' },
      select: { unitNumber: true },
    });
    const value = last?.unitNumber ?? 0;
    cursors.set(subjectId, value);
    return value;
  };

  const findSubject = async (name: string): Promise<SubjectRow | null> => {
    const key = normalizeTopicTitle(name);
    const exact = subjects.find((subject) => normalizeTopicTitle(subject.name) === key);
    if (exact) return exact;
    const partial = subjects.find((subject) => {
      const other = normalizeTopicTitle(subject.name);
      return other.startsWith(key) || key.startsWith(other);
    });
    return partial ?? null;
  };

  /**
   * Materias que están en cualquier horario de instituto y no se preparan para
   * la PAU. Si aparecen por primera vez dictando el horario, se crean como «solo
   * horario»: así el alumno ve su semana entera sin que la app le pida un temario
   * que no existe. Si luego resulta que sí se trabaja, se marca con
   * [[estudiar:…]] y no se pierde nada.
   */
  const TIMETABLE_ONLY = /^(religion|tutoria|educacion fisica|recreo)$/;

  const createSubject = async (
    name: string,
    options: { tracked?: boolean } = {}
  ): Promise<SubjectRow> => {
    const tracked =
      options.tracked ?? !TIMETABLE_ONLY.test(normalizeTopicTitle(name));
    const created = await prisma.subject.create({
      data: {
        name,
        color: '#64748b',
        pauWeight: 0,
        isPhaseGeneral: false,
        isTracked: tracked,
        order: subjects.length + 1,
      },
    });
    await prisma.aiAgent.create({
      data: {
        subjectId: created.id,
        name: `Catedrático de ${name}`,
        specialty: `Dominio curricular y preparación estratégica de ${name}`,
        systemPrompt: `Eres el Catedrático especializado en ${name} para 1º de Bachillerato. Explicas con rigor, preguntas socráticas y enfoque de preparación pre-PAU.`,
      },
    });
    subjects = [...subjects, created];
    applied.push(
      tracked
        ? `Materia nueva creada: ${name} (sin ponderación PAU; ajustable en Ajustes)`
        : `Materia nueva en el horario: ${name} (no se le pide temario ni exámenes; si sí se estudia, dímelo)`
    );
    changed = true;
    return created;
  };

  for (const [actionIndex, action] of actions.entries()) {
    switch (action.kind) {
      case 'focus': {
        const subject = (await findSubject(action.subject)) ?? (await createSubject(action.subject));
        focus = subject;
        break;
      }

      case 'source': {
        source = action.source;
        break;
      }

      case 'replace': {
        let target: SubjectRow | null = focus;
        if (action.subject) {
          target = (await findSubject(action.subject)) ?? (await createSubject(action.subject));
        }
        if (!target) {
          problems.push('Me has pedido sustituir un temario pero no sé de qué materia.');
          break;
        }

        // NUNCA SE BORRA MÁS DE LO QUE SE TRAE… SALVO QUE LO HAYA PEDIDO ÉL.
        //
        // Un «sustituir» mal puesto (el modelo lo emite a veces al contestar una
        // duda, no al recibir una lista) borraba el temario entero de la materia
        // y lo dejaba con las cuatro unidades que venían detrás. Ahora, si la
        // lista nueva es más corta que la que ya hay, no se toca nada y se pide
        // confirmación explícita.
        //
        // La excepción es la petición explícita del alumno («sustituye el
        // temario de Lengua por este»): entonces manda él, aunque la lista sea
        // más corta. Se acepta la autorización de este turno o la que quedó
        // apuntada desde el turno anterior (la lista puede llegar después).
        const planned = unitsAfterReplace.get(actionIndex) ?? 0;
        const existing = await prisma.topic.count({ where: { subjectId: target.id } });
        const sameSubjectAsAsked =
          !options.allowReplaceSubject ||
          normalizeTopicTitle(options.allowReplaceSubject) === normalizeTopicTitle(target.name);
        const askedNow = options.allowReplace === true && sameSubjectAsAsked;
        const askedBefore = hasPendingReplace(target.id);
        const authorized = askedNow || askedBefore;

        if (authorized && planned > 0) consumePendingReplace(target.id);

        if (!authorized && existing > 0 && planned > 0 && planned < existing) {
          problems.push(
            `No he sustituido el temario de ${target.name}: me has dado ${planned} ${planned === 1 ? 'unidad' : 'unidades'} y ya había ${existing}. No he borrado nada, para no perder lo que ya estaba. Si de verdad quieres reemplazarlo, dímelo con esas palabras («sustituye el temario de ${target.name}») y lo cambio.`
          );
          replaceArmed.delete(target.id);
          replaceBlocked.add(target.id);
          break;
        }

        focus = target;
        replaceArmed.add(target.id);
        // El cursor vuelve a cero: las unidades siguientes son el temario nuevo.
        cursors.set(target.id, 0);
        break;
      }

      case 'unit': {
        if (!focus) {
          problems.push(`No he podido anotar «${action.title}»: no sé de qué materia es todavía.`);
          break;
        }

        // La lista venía detrás de un reemplazo rechazado: se descarta sin
        // tocar lo que ya había (el motivo se ha dicho una sola vez).
        if (replaceBlocked.has(focus.id)) break;

        if (replaceArmed.has(focus.id)) {
          const backup = await writeTemarioBackup(
            focus.id,
            focus.name,
            'Copia previa a sustituir tu temario durante la puesta a punto'
          ).catch((error: Error) => {
            problems.push(`No he podido guardar la copia de «${focus!.name}», así que no he borrado nada: ${error.message}`);
            return undefined;
          });
          if (backup === undefined) {
            replaceArmed.delete(focus.id);
            break;
          }

          const previous = await prisma.topic.count({ where: { subjectId: focus.id } });
          if (previous > 0) {
            await prisma.topic.deleteMany({ where: { subjectId: focus.id } });
            applied.push(
            `Temario de ${focus.name} sustituido: ${previous} unidades anteriores fuera (copia en data/backups/)`
          );
            changed = true;
            playlistDirty = true;
          }
          // Un temario nuevo nunca está confirmado como completo hasta que el
          // alumno lo diga con [[temario-completo:…]].
          await prisma.subject.update({ where: { id: focus.id }, data: { syllabusComplete: false } });
          focus.syllabusComplete = false;
          replaceArmed.delete(focus.id);
        }

        const title = action.title.trim();
        const siblings = await prisma.topic.findMany({ where: { subjectId: focus.id }, select: { title: true } });
        const duplicate = siblings.some((topic) => normalizeTopicTitle(topic.title) === normalizeTopicTitle(title));
        if (duplicate) {
          problems.push(`«${title}» ya estaba en ${focus.name}: no lo repito.`);
          break;
        }

        const next = (await cursorFor(focus.id)) + 1;
        cursors.set(focus.id, next);
        // Si el temario estaba confirmado como completo y se añade una unidad,
        // deja de estarlo: hay que volver a confirmar que no falta ninguna más.
        if (focus.syllabusComplete) {
          await prisma.subject.update({ where: { id: focus.id }, data: { syllabusComplete: false } });
          focus.syllabusComplete = false;
        }
        await prisma.topic.create({
          data: {
            subjectId: focus.id,
            title,
            unitNumber: next,
            term: action.term,
            difficulty: action.difficulty ?? 3,
            source,
            status: 'pendiente',
            // Sin medir: apuntar el temario no es saberlo.
            masteryLevel: 0,
            masterySource: 'sin_medir',
          },
        });
        unitTally.set(focus.name, (unitTally.get(focus.name) ?? 0) + 1);
        changed = true;
        playlistDirty = true;
        break;
      }

      case 'rename': {
        if (!focus) {
          problems.push(`No he podido renombrar «${action.from}»: no sé de qué materia es.`);
          break;
        }
        const key = normalizeTopicTitle(action.from);
        const matches = await prisma.topic.findMany({ where: { subjectId: focus.id } });
        const hits = matches.filter((topic) => normalizeTopicTitle(topic.title) === key);
        if (hits.length === 0) {
          problems.push(`En ${focus.name} no encuentro «${action.from}», así que no he renombrado nada.`);
          break;
        }
        await prisma.topic.update({ where: { id: hits[0].id }, data: { title: action.to } });
        applied.push(`Renombrada en ${focus.name}: «${action.from}» → «${action.to}»`);
        changed = true;
        break;
      }

      case 'drop-unit': {
        if (!focus) {
          problems.push(`No he podido borrar «${action.title}»: no sé de qué materia es.`);
          break;
        }
        const key = normalizeTopicTitle(action.title);
        const matches = await prisma.topic.findMany({ where: { subjectId: focus.id } });
        const hits = matches.filter((topic) => normalizeTopicTitle(topic.title) === key);
        if (hits.length === 0) {
          problems.push(`En ${focus.name} no encuentro «${action.title}»: no he borrado nada.`);
          break;
        }
        await prisma.topic.delete({ where: { id: hits[0].id } });
        if (focus.syllabusComplete) {
          await prisma.subject.update({ where: { id: focus.id }, data: { syllabusComplete: false } });
          focus.syllabusComplete = false;
        }
        applied.push(`Borrada de ${focus.name}: «${hits[0].title}»`);
        changed = true;
        playlistDirty = true;
        break;
      }

      case 'exam': {
        const subject = action.subject
          ? (await findSubject(action.subject)) ?? (await createSubject(action.subject))
          : focus;
        if (!subject) {
          problems.push(`No he podido anotar el examen «${action.title}»: no sé de qué materia es.`);
          break;
        }

        const examDate = new Date(`${action.date}T09:00:00`);
        if (Number.isNaN(examDate.getTime())) {
          problems.push(`La fecha del examen «${action.title}» no me cuadra: no lo he anotado.`);
          break;
        }

        const existing = await prisma.exam.findMany({ where: { subjectId: subject.id } });
        const match = existing.find(
          (exam) => normalizeTopicTitle(exam.title) === normalizeTopicTitle(action.title)
        );

        if (match) {
          if (isoDay(new Date(match.examDate)) === action.date) {
            problems.push(`El examen «${match.title}» ya estaba apuntado en esa fecha.`);
            break;
          }
          await prisma.exam.update({
            where: { id: match.id },
            data: {
              examDate,
              ...(action.weight !== null ? { weightPercent: action.weight } : {}),
              ...(action.target !== null ? { targetGrade: action.target } : {}),
            },
          });
          applied.push(`Examen corregido: «${match.title}» pasa al ${action.date}`);
        } else {
          await prisma.exam.create({
            data: {
              subjectId: subject.id,
              title: action.title,
              examDate,
              weightPercent: action.weight ?? 30,
              examType: guessExamType(action.title),
              targetGrade: action.target ?? 9,
            },
          });
          applied.push(`Examen anotado el ${action.date}: ${action.title} (${subject.name})`);
        }
        changed = true;
        break;
      }

      /**
       * Quitar un examen ya apuntado.
       *
       * Es lo que el coordinador no sabía hacer: el alumno le pidió dos días
       * seguidos que quitara un examen que no existía y la etiqueta se quedaba
       * en «no aplicada», así que el examen seguía ahí metiendo prisa falsa en
       * el plan y en la cuenta atrás.
       *
       * Se busca en la materia en la que estamos y, si no está ahí, en todas: el
       * alumno dice «quita el de Química Orgánica» sin repetir la asignatura.
       */
      case 'drop-exam': {
        const all = await prisma.exam.findMany({
          include: { subject: { select: { name: true } } },
          orderBy: { examDate: 'asc' },
        });
        const inFocus = focus ? all.filter((exam) => exam.subjectId === focus!.id) : [];

        const key = normalizeTopicTitle(action.title);
        const exact = (list: typeof all) =>
          list.find((exam) => normalizeTopicTitle(exam.title) === key) ?? null;
        const loose = (list: typeof all) =>
          list.find((exam) => {
            const other = normalizeTopicTitle(exam.title);
            return other.includes(key) || key.includes(other);
          }) ?? null;

        const match = exact(inFocus) ?? loose(inFocus) ?? exact(all) ?? loose(all);

        if (!match) {
          problems.push(
            `No encuentro ningún examen apuntado que se llame «${action.title}», así que no he quitado nada. Dime el título tal y como te lo enseñé antes.`
          );
          break;
        }

        await prisma.exam.delete({ where: { id: match.id } });
        applied.push(`Examen quitado: «${match.title}» (${match.subject.name})`);
        changed = true;
        playlistDirty = true;
        break;
      }

      /** Mover un examen que ya estaba apuntado a la fecha nueva. */
      case 'move-exam': {
        const all = await prisma.exam.findMany({
          include: { subject: { select: { name: true } } },
          orderBy: { examDate: 'asc' },
        });
        const inFocus = focus ? all.filter((exam) => exam.subjectId === focus!.id) : [];

        const key = normalizeTopicTitle(action.title);
        const exact = (list: typeof all) =>
          list.find((exam) => normalizeTopicTitle(exam.title) === key) ?? null;
        const loose = (list: typeof all) =>
          list.find((exam) => {
            const other = normalizeTopicTitle(exam.title);
            return other.includes(key) || key.includes(other);
          }) ?? null;

        const match = exact(inFocus) ?? loose(inFocus) ?? exact(all) ?? loose(all);

        if (!match) {
          problems.push(
            `No encuentro ningún examen apuntado que se llame «${action.title}»: si es uno nuevo, apúntamelo con su fecha.`
          );
          break;
        }

        const newDate = new Date(`${action.date}T09:00:00`);
        if (Number.isNaN(newDate.getTime())) {
          problems.push(`La fecha nueva de «${match.title}» no me cuadra: no lo he movido.`);
          break;
        }

        const before = isoDay(new Date(match.examDate));
        if (before === action.date) {
          problems.push(`«${match.title}» ya estaba en esa fecha.`);
          break;
        }

        await prisma.exam.update({ where: { id: match.id }, data: { examDate: newDate } });
        applied.push(
          `Examen movido: «${match.title}» (${match.subject.name}) del ${before} al ${action.date}`
        );
        changed = true;
        playlistDirty = true;
        break;
      }

      /**
       * Una clase del horario.
       *
       * El horario es lo que hace que el plan de la tarde no sea arbitrario: con
       * él, la app sabe qué se da hoy y qué toca mañana, y coloca el bloque de
       * estudio la tarde antes de la clase de esa asignatura. Antes esto solo se
       * podía importar desde un archivo: si el alumno lo dictaba en la entrevista,
       * se perdía.
       *
       * Si en esa hora ya había otra materia, se entiende como una CORRECCIÓN
       * (el profesor ha cambiado la clase de sitio) y se sustituye en vez de
       * duplicar. Si la misma clase ya estaba puesta, se dice y no se repite.
       */
      case 'class': {
        const subject = action.subject
          ? (await findSubject(action.subject)) ??
            // Una materia que solo aparece al dictar el horario entra como
            // «solo horario» si es de las que no se estudian (Religión, Tutoría,
            // Educación Física). Las demás, como materia normal.
            (await createSubject(action.subject))
          : focus;
        if (!subject) {
          problems.push('No he podido apuntar esa clase: no sé de qué materia es todavía.');
          break;
        }

        const sameSlot = await prisma.classPeriod.findFirst({
          where: { dayOfWeek: action.day, startTime: action.start },
          include: { subject: { select: { name: true } } },
        });

        if (sameSlot && sameSlot.subjectId === subject.id) {
          problems.push(
            `Esa clase ya estaba en el horario: el ${DAY_NAMES[action.day] ?? action.day} a las ${action.start} tienes ${subject.name}.`
          );
          break;
        }

        if (sameSlot) {
          await prisma.classPeriod.update({
            where: { id: sameSlot.id },
            data: {
              subjectId: subject.id,
              endTime: action.end,
              period: action.period,
              ...(action.room ? { classroom: action.room } : {}),
            },
          });
          applied.push(
            `Horario corregido: el ${DAY_NAMES[action.day] ?? action.day} a las ${action.start} pasa de ${sameSlot.subject.name} a ${subject.name}`
          );
        } else {
          await prisma.classPeriod.create({
            data: {
              dayOfWeek: action.day,
              period: action.period,
              startTime: action.start,
              endTime: action.end,
              subjectId: subject.id,
              classroom: action.room,
            },
          });
          applied.push(
            `Clase apuntada: ${DAY_NAMES[action.day] ?? action.day} de ${action.start} a ${action.end}, ${subject.name}${action.room ? ` (${action.room})` : ''}`
          );
        }
        // Cualquier cambio en el horario reabre su confirmación: si se añade
        // una clase después de haberlo dado por cerrado, el «completo» deja de
        // ser cierto y el coordinador tiene que volver a repasarlo.
        await prisma.userProfile.update({
          where: { id: 'user_default' },
          data: { timetableComplete: false },
        });
        changed = true;
        playlistDirty = true;
        break;
      }

      /** Quitar clases del horario (toda la materia o solo un día). */
      case 'drop-class': {
        const subject = await findSubject(action.subject);
        if (!subject) {
          problems.push(`No encuentro «${action.subject}» entre tus materias: no he tocado el horario.`);
          break;
        }

        const doomed = await prisma.classPeriod.findMany({
          where: {
            subjectId: subject.id,
            ...(action.day === null ? {} : { dayOfWeek: action.day }),
          },
        });

        if (doomed.length === 0) {
          problems.push(
            action.day === null
              ? `${subject.name} no estaba en el horario: no he quitado nada.`
              : `${subject.name} no tenía clase ese día: no he quitado nada.`
          );
          break;
        }

        await prisma.classPeriod.deleteMany({
          where: { id: { in: doomed.map((period) => period.id) } },
        });
        // El horario ha cambiado: la confirmación de «está completo» ya no vale.
        await prisma.userProfile.update({
          where: { id: 'user_default' },
          data: { timetableComplete: false },
        });
        applied.push(
          action.day === null
            ? `Fuera del horario: ${subject.name} (${doomed.length} ${doomed.length === 1 ? 'clase' : 'clases'})`
            : `Fuera del horario: ${subject.name} los ${DAY_NAMES[action.day] ?? action.day}`
        );
        changed = true;
        playlistDirty = true;
        break;
      }

      /**
       * Marcar una materia como «solo horario» o como materia que sí se trabaja.
       *
       * El horario de un instituto tiene Religión, Educación Física y Tutoría.
       * Son horas reales que no puede usar para estudiar, así que tienen que
       * salir en el horario; pero pedirles temario y exámenes es pedirle al
       * alumno datos que no existen. Con esto, el horario es completo y la lista
       * de trabajo sigue siendo honesta.
       */
      case 'track': {
        const subject = (await findSubject(action.subject)) ?? (await createSubject(action.subject));
        if (subject.isTracked === action.tracked) {
          problems.push(
            action.tracked
              ? `${subject.name} ya se estaba trabajando en la app.`
              : `${subject.name} ya estaba solo en el horario.`
          );
          break;
        }
        await prisma.subject.update({
          where: { id: subject.id },
          data: {
            isTracked: action.tracked,
            // Al volver a trabajarla hay que reconfirmar el temario: puede que
            // se haya quedado a medias mientras estaba fuera.
            ...(action.tracked ? {} : { syllabusComplete: false }),
          },
        });
        subject.isTracked = action.tracked;
        if (!action.tracked) subject.syllabusComplete = false;
        applied.push(
          action.tracked
            ? `${subject.name} se trabaja en la app (temario y exámenes).`
            : `${subject.name} queda solo en el horario: no se le piden temario ni exámenes.`
        );
        changed = true;
        playlistDirty = true;
        break;
      }

      /** El alumno confirma que el temario de una materia está entero. */
      case 'syllabus-complete': {
        const subject = action.subject
          ? (await findSubject(action.subject)) ?? (await createSubject(action.subject))
          : focus;
        if (!subject) {
          problems.push('No sé de qué materia es ese temario completo.');
          break;
        }
        const units = await prisma.topic.count({ where: { subjectId: subject.id } });
        if (units === 0) {
          problems.push(
            `No puedo dar el temario de ${subject.name} por completo porque no hay ninguna unidad anotada. Dímelo primero y luego lo confirmo.`
          );
          break;
        }
        await prisma.subject.update({
          where: { id: subject.id },
          data: { syllabusComplete: true },
        });
        subject.syllabusComplete = true;
        applied.push(`Temario de ${subject.name} confirmado como completo (${units} unidades)`);
        changed = true;
        break;
      }

      /** El alumno confirma que el horario de los cinco días está repasado. */
      case 'timetable-complete': {
        await prisma.userProfile.update({
          where: { id: 'user_default' },
          data: { timetableComplete: true },
        });
        applied.push('Horario de clases repasado: completo');
        changed = true;
        break;
      }

      case 'hours': {
        await prisma.userProfile.update({
          where: { id: 'user_default' },
          data: { weeklyHoursCap: action.weekly, weeklyHoursDeclared: true },
        });
        applied.push(`Horas disponibles: ${action.weekly} h/semana`);
        changed = true;
        playlistDirty = true;
        break;
      }

      case 'mode': {
        await prisma.userProfile.update({
          where: { id: 'user_default' },
          data: { studyMode: action.mode },
        });
        applied.push(action.mode === 'athlete' ? 'Ritmo: Modo Atleta' : 'Ritmo: Zona de Consuelo');
        changed = true;
        playlistDirty = true;
        break;
      }

      case 'pau-target': {
        await prisma.userProfile.update({
          where: { id: 'user_default' },
          data: { targetGradePau: action.value },
        });
        applied.push(`Nota PAU objetivo: ${action.value}/14`);
        changed = true;
        break;
      }
    }
  }

  // Resumen por materia: es lo que se le enseña en el chat.
  for (const [name, count] of unitTally) {
    applied.unshift(`${count} ${count === 1 ? 'unidad anotada' : 'unidades anotadas'} en ${name}`);
  }

  let blocks = 0;
  if (playlistDirty) {
    const user = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });
    const plan = await regenerateWeeklyPlan((user?.studyMode as StudyMode) || 'athlete');
    blocks = plan.count ?? 0;
  }

  const { snapshot, checklist } = await getSetupState();

  return { applied, problems, changed, blocks, snapshot, checklist };
}

/** Cierra la puesta a punto (la marca como terminada). */
export async function markSetupCompleted(at: Date = new Date()) {
  await prisma.userProfile.update({
    where: { id: 'user_default' },
    data: { setupCompletedAt: at },
  });
}

/** Reabre la puesta a punto para seguir añadiendo datos. */
export async function reopenSetup() {
  await prisma.userProfile.update({
    where: { id: 'user_default' },
    data: { setupCompletedAt: null },
  });
}
