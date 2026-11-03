import { prisma } from './prisma';
import { sanitizeNoteContent } from './apuntesIa';
import { loadMaintenanceInput } from './maintenanceData';
import { restartAppServer, startWatchedServer } from './serverControl';
import { restoreEmptyTemarios } from './temarioRestore';
import { NEUTRAL_MASTERY_LEVEL, type MaintenanceFix, type MaintenanceOperation } from './maintenance';
import { allFixes, scanAll } from './maintenanceScan';

/**
 * Aplicar los arreglos del taller.
 *
 * Vive aparte de las acciones por una razón concreta: **el vigilante también
 * repara**, y el vigilante corre fuera de una petición de Next (no puede usar
 * `revalidatePath`). Si cada uno tuviera su propia copia del bucle, el día que se
 * arregle una operación solo se arreglaría en un sitio y el otro seguiría
 * haciendo lo de antes. Un solo camino, dos puertas: la página y el vigilante.
 *
 * Este módulo no lleva `'use server'`: no es una acción, es la operación de
 * escritura. Quien lo llame decide qué hacer después (revalidar, registrar, avisar).
 */

export interface ApplyFixesResult {
  success: boolean;
  error?: string;
  applied: Array<{ id: string; label: string; count: number }>;
  problems: string[];
  /** Cuántos hallazgos quedan después de arreglar. -1 si no se ha podido contar. */
  remaining: number;
  /** Arreglos que estaban disponibles y no se han pedido (para poder decir qué falta). */
  skipped: Array<{ id: string; label: string; safe: boolean }>;
}

/** ¿Este error dice que la fila ya no está? (Prisma P2025). */
function isMissingRecord(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'P2025') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Record to (update|delete) (not found|does not exist)/i.test(message);
}

/**
 * Borra una unidad, pero **solo si sigue vacía en el instante del borrado**.
 *
 * La decisión de borrar se toma sobre una foto del sistema: el motor ve que una
 * unidad duplicada no tiene nada colgando y propone quitarla. Entre esa foto y el
 * borrado hay una ventana real — el vigilante de fondo puede estar dando otra
 * vuelta, tú puedes escribir un apunte en esa unidad, la IA puede estar a punto
 * de fusionar las dos copias. Si algo ha llegado en ese hueco, borrarla se lleva
 * datos del alumno por delante.
 *
 * Aquí se cuentan las filas que cuelgan dentro de **la misma transacción** que el
 * borrado: si hay una sola, no se borra y se avisa. Así «nunca se borra una unidad
 * con datos» deja de depender de que la foto siga siendo cierta.
 */
async function deleteTopicIfStillEmpty(topicId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.topic.findUnique({
      where: { id: topicId },
      select: {
        _count: {
          select: { notes: true, errors: true, studyBlocks: true, sessions: true, srsReviews: true },
        },
      },
    });

    // Ya no estaba: lo que quería el arreglo (que esa copia no moleste) está hecho.
    if (!row) return false;

    const colgando =
      row._count.notes +
      row._count.errors +
      row._count.studyBlocks +
      row._count.sessions +
      row._count.srsReviews;

    if (colgando > 0) {
      console.warn(
        `[mantenimiento] no se borra la unidad ${topicId}: ha dejado de estar vacía (${colgando} dato(s) dentro).`
      );
      return false;
    }

    await tx.topic.delete({ where: { id: topicId } });
    return true;
  });
}

/** Ejecuta una operación concreta. Devuelve `true` si ha tocado algo. */
async function runOperation(operation: MaintenanceOperation): Promise<boolean> {
  switch (operation.kind) {
    case 'rename_topic':
      await prisma.topic.update({
        where: { id: operation.topicId },
        data: { title: operation.title },
      });
      return true;
    case 'renumber_topic':
      await prisma.topic.update({
        where: { id: operation.topicId },
        data: { unitNumber: operation.unitNumber },
      });
      return true;
    case 'delete_topic':
      return deleteTopicIfStillEmpty(operation.topicId);
    case 'clamp_srs':
      await prisma.topic.update({
        where: { id: operation.topicId },
        data: {
          srsIntervalDays: operation.intervalDays,
          srsEaseFactor: operation.easeFactor,
        },
      });
      return true;
    case 'clear_future_review':
      await prisma.topic.update({
        where: { id: operation.topicId },
        data: { lastReviewedAt: null },
      });
      return true;
    case 'fix_topic_status':
      await prisma.topic.update({
        where: { id: operation.topicId },
        data: { status: operation.status },
      });
      return true;
    case 'reset_mastery':
      // Al valor con el que la app dice «sin medir», que es el mismo que usa el
      // motor: un solo número para una sola idea (ver NEUTRAL_MASTERY_LEVEL).
      await prisma.topic.update({
        where: { id: operation.topicId },
        data: { masteryLevel: NEUTRAL_MASTERY_LEVEL },
      });
      return true;
    case 'delete_habit_log':
      await prisma.habitLog.delete({ where: { id: operation.logId } });
      return true;
    case 'clamp_habit_streak':
      await prisma.habit.update({
        where: { id: operation.habitId },
        data: { streak: operation.streak },
      });
      return true;
    case 'expire_challenge':
      await prisma.weeklyChallenge.update({
        where: { id: operation.challengeId },
        data: { status: 'expired' },
      });
      return true;
    case 'complete_exam':
      await prisma.exam.update({
        where: { id: operation.examId },
        data: { isCompleted: true },
      });
      return true;
    case 'clean_note_code': {
      // Se pasa por el **mismo** limpiador que se usa al escribir un apunte nuevo:
      // una sola definición de «apunte limpio» para las dos puertas, para que un
      // apunte viejo quede exactamente igual que uno recién escrito.
      const note = await prisma.note.findUnique({
        where: { id: operation.noteId },
        select: { content: true, title: true },
      });
      if (!note) return false;

      const clean = sanitizeNoteContent(note.content);

      // Si el apunte ya estaba bien (o el limpiador lo dejaría vacío, que no es
      // un apunte), no se escribe nada: contar un cambio que no ha existido sería
      // apuntarse un arreglo que nadie ha hecho.
      if (clean === note.content || clean.trim().length === 0) return false;

      await prisma.note.update({ where: { id: operation.noteId }, data: { content: clean } });
      console.log(`[mantenimiento] apunte limpio de restos de código: «${note.title}»`);
      return true;
    }
    /*
     * Reponer el temario de una materia que se ha quedado vacía.
     *
     * Es el único arreglo que **vuelve a escribir** datos en lugar de ordenarlos,
     * así que tiene dos garantías que no se negocian:
     *   1. Solo rellena materias con **cero** unidades: una que tenga su temario no
     *      se toca (lo decide `restoreEmptyTemarios`, no este interruptor).
     *   2. Antes de escribir nada, el propio módulo deja una copia de cómo estaba
     *      el sistema: si algo no cuadra, se revierte con `npm run db:restore`.
     * Devuelve `false` si no había nada que reponer, para no apuntarse un arreglo
     * que no ha hecho.
     */
    case 'restore_temario': {
      const result = await restoreEmptyTemarios('arreglo del taller de mantenimiento');
      for (const problem of result.problems) {
        console.warn(`[mantenimiento] reponer temario: ${problem}`);
      }
      for (const done of result.restored) {
        console.log(
          `[mantenimiento] temario repuesto: ${done.subject} · ${done.units} unidad(es) desde ${done.from}`
        );
      }
      return result.restored.length > 0;
    }
    // Funcionamiento: los dos únicos arreglos que no tocan datos. Devuelven si de
    // verdad había algo que hacer (si el vigilante ya lo estaba levantando, no se
    // cuenta como arreglo: sería apuntar un mérito que no es nuestro).
    case 'start_server': {
      const result = await startWatchedServer();
      console.log(`[mantenimiento] levantar la app: ${result.detail}`);
      return result.acted;
    }
    case 'restart_server': {
      const result = await restartAppServer();
      console.log(`[mantenimiento] reiniciar la app: ${result.detail}`);
      return result.acted;
    }
    default:
      return false;
  }
}

/**
 * Ejecuta un plan de arreglos ya construido, tal cual: sin recalcular nada.
 *
 * Es lo que se usa para el plan de la auditoría de IA (un plan suelto que hay que
 * aplicar como se ha leído). Para los arreglos del motor, el camino es
 * `applyMaintenanceFixes`, que sí recalcula entre plan y plan: los planes nacen de
 * la misma foto del sistema y uno que renumera puede estar hablando de la unidad
 * que otro acaba de borrar.
 */
export async function applyFixPlan(
  fixes: MaintenanceFix[],
  options: { onlySafe?: boolean } = {}
): Promise<{ applied: Array<{ id: string; label: string; count: number }>; problems: string[] }> {
  const applied: Array<{ id: string; label: string; count: number }> = [];
  const problems: string[] = [];

  for (const fix of fixes) {
    if (options.onlySafe && !fix.safe) continue;

    let done = 0;
    for (const operation of fix.operations) {
      try {
        if (await runOperation(operation)) done += 1;
      } catch (error) {
        // Que la fila ya no esté no es un fallo del arreglo: otro plan la ha
        // borrado o alguien la ha quitado mientras se reparaba. El objetivo
        // —que esa unidad deje de estar mal— ya está cumplido, así que se cuenta
        // como aviso y no se ensucia el informe con un error que no lo es.
        if (isMissingRecord(error)) {
          console.warn(`[mantenimiento] ${operation.kind}: la fila ya no estaba, no hay nada que hacer`);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        problems.push(`${fix.label}: ${message.slice(0, 160)}`);
        console.warn(`[mantenimiento] operación ${operation.kind} falló:`, message);
      }
    }

    if (done > 0) applied.push({ id: fix.id, label: fix.label, count: done });
  }

  return { applied, problems };
}

/**
 * El camino normal: revisa, elige los arreglos pedidos (todos los `safe` si no se
 * pide ninguno en concreto) y los aplica. Al terminar vuelve a contar los
 * hallazgos: eso es lo que permite decir «quedan 3» en lugar de «hecho».
 */
export async function applyMaintenanceFixes(fixIds?: string[]): Promise<ApplyFixesResult> {
  try {
    const pending = allFixes(await loadMaintenanceInput());
    const selectedIds = new Set(
      (fixIds ? pending.filter((fix) => fixIds.includes(fix.id)) : pending.filter((fix) => fix.safe)).map(
        (fix) => fix.id
      )
    );
    const skipped = pending
      .filter((fix) => !selectedIds.has(fix.id))
      .map((fix) => ({ id: fix.id, label: fix.label, safe: fix.safe }));

    const applied: Array<{ id: string; label: string; count: number }> = [];
    const problems: string[] = [];

    // Se aplica **un plan cada vez y se vuelve a mirar**.
    //
    // Todos los planes nacen de la misma foto del sistema, y algunos hablan de
    // las mismas filas por caminos distintos: el de las repetidas vacías borra
    // una unidad de la que el que renumera también habla. Aplicándolos de golpe,
    // el temario acababa con un hueco (borraba el 9 y renumeraba hasta el 9).
    // Recalculando entre plan y plan, cada arreglo ve el sistema de verdad.
    // El tope de vueltas es una red de seguridad: nunca se dan más pasos que
    // planes había.
    for (let guard = 0; selectedIds.size > 0 && guard < 20; guard += 1) {
      const fresh = allFixes(await loadMaintenanceInput());
      const next = fresh.find((fix) => selectedIds.has(fix.id));
      if (!next) break;

      const result = await applyFixPlan([next]);
      applied.push(...result.applied);
      problems.push(...result.problems);
      selectedIds.delete(next.id);
    }

    // Qué queda después de arreglar: sirve para saber si el sistema ha quedado limpio.
    const remaining = scanAll(await loadMaintenanceInput()).length;

    if (applied.length > 0) {
      console.log(`[mantenimiento] aplicado: ${applied.map((item) => item.label).join(' | ')}`);
    }

    return { success: true, applied, problems, remaining, skipped };
  } catch (error) {
    console.error('[mantenimiento] error al reparar:', error);
    return {
      success: false,
      error: 'No se han podido aplicar los arreglos. Revisa la consola del servidor.',
      applied: [],
      problems: [],
      remaining: -1,
      skipped: [],
    };
  }
}
