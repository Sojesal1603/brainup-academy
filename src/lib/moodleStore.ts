/**
 * Escribir en la base lo que llega de Moodle. Un solo escritor para las dos vías.
 *
 * Todo lo que entra de Moodle —por Web Services (con clave) o por sesión web (con
 * usuario y contraseña)— acaba en las mismas tres tablas: `MoodleCourse`,
 * `MoodleMaterial` y `MoodleTask`. Si cada vía escribiera a su manera, el mismo
 * curso acabaría duplicado al cambiar de vía; por eso el «cómo se guarda» vive
 * aquí y las dos vías solo traen los datos.
 *
 * Dos reglas que se respetan siempre:
 *   - **Nada se inventa.** Si Moodle no da la fecha de entrega, la tarea queda sin
 *     fecha (y se ve así); no se rellena con una suposición.
 *   - **Nada del alumno se borra.** Cuando un material desaparece de Moodle se
 *     quita del índice, pero la copia local que ya tenía se queda en su disco.
 */

import { prisma } from './prisma';
import type { MoodleCourseInfo, MoodleMaterialDraft } from './moodleWs';

export interface StoreCourseResult {
  id: string;
  subjectId: string | null;
}

/**
 * Guarda (o actualiza) un curso y sus materiales, y quita del índice los
 * materiales que ya no están en Moodle.
 */
export async function storeCourseWithMaterials(params: {
  course: MoodleCourseInfo;
  subjectId: string | null;
  sections: number;
  materials: MoodleMaterialDraft[];
}): Promise<StoreCourseResult> {
  const { course, subjectId, sections, materials } = params;

  const row = await prisma.moodleCourse.upsert({
    where: { moodleId: course.moodleId },
    create: {
      moodleId: course.moodleId,
      fullName: course.fullName,
      shortName: course.shortName,
      subjectId,
      sections,
    },
    update: {
      fullName: course.fullName,
      shortName: course.shortName,
      subjectId,
      sections,
      syncedAt: new Date(),
    },
  });

  const seen: string[] = [];
  for (const material of materials) {
    seen.push(material.externalId);
    await prisma.moodleMaterial.upsert({
      where: { externalId: material.externalId },
      create: { courseId: row.id, ...material },
      update: { courseId: row.id, ...material },
    });
  }

  await prisma.moodleMaterial.deleteMany({
    where: { courseId: row.id, externalId: { notIn: seen.length > 0 ? seen : [''] } },
  });

  return { id: row.id, subjectId };
}

/**
 * Una tarea tal y como hay que escribirla. `externalId` es la marca que evita
 * duplicados en la vía de sesión (`sesion:cmid:123`); en la de Web Services el
 * que identifica es `assignmentId`.
 */
export interface MoodleTaskWrite {
  externalId: string | null;
  assignmentId: number | null;
  title: string;
  description: string | null;
  courseName: string;
  subjectId: string | null;
  /** `null` = Moodle no ha dicho la fecha. Se guarda sin fecha, no inventada. */
  dueDate: Date | null;
  moodleUrl: string | null;
  source: string;
  submitted: boolean | null;
  graded: boolean;
  grade: number | null;
}

export interface StoreTasksResult {
  /** Tareas que se han guardado (nuevas o actualizadas). */
  tasks: number;
  submitted: number;
  /** Cuántas se han adoptado en vez de duplicarlas (venían del calendario iCal). */
  adopted: number;
}

/** Fecha para la base: sin fecha = el inicio de los tiempos (así se ve en la app). */
const NO_DATE = new Date(0);

/**
 * Guarda las tareas sin duplicarlas:
 *   1. por `externalId` (la misma tarea en la misma vía) y
 *   2. por `assignmentId` (una tarea que ya entró por Web Services),
 *   3. y si no, se adopta la entrega que entró antes por el calendario iCal en vez
 *      de crear otra.
 */
export async function storeTasks(drafts: MoodleTaskWrite[]): Promise<StoreTasksResult> {
  let tasks = 0;
  let submitted = 0;
  let adopted = 0;

  for (const draft of drafts) {
    // El `externalId` va también en el update: si esta tarea se adopta desde otra
    // vía, la fila tiene que quedarse con la marca de la vía que ahora la lleva.
    // Si no, la siguiente sincronización no la reconocería y la duplicaría.
    const data = {
      title: draft.title,
      description: draft.description,
      courseName: draft.courseName,
      subjectId: draft.subjectId,
      dueDate: draft.dueDate ?? NO_DATE,
      moodleUrl: draft.moodleUrl,
      assignmentId: draft.assignmentId,
      source: draft.source,
      submitted: draft.submitted,
      graded: draft.graded,
      grade: draft.grade,
      ...(draft.externalId ? { externalId: draft.externalId } : {}),
    };

    const existing =
      (draft.externalId
        ? await prisma.moodleTask.findUnique({ where: { externalId: draft.externalId } })
        : null) ??
      (draft.assignmentId !== null
        ? await prisma.moodleTask.findUnique({ where: { assignmentId: draft.assignmentId } })
        : null);

    if (existing) {
      await prisma.moodleTask.update({ where: { id: existing.id }, data });
    } else {
      const sameTitle = await prisma.moodleTask.findFirst({
        where: {
          source: 'ical',
          title: draft.title,
          courseName: draft.courseName,
          assignmentId: null,
        },
      });

      if (sameTitle) {
        await prisma.moodleTask.update({ where: { id: sameTitle.id }, data });
        adopted++;
      } else {
        await prisma.moodleTask.create({ data });
      }
    }

    tasks++;
    if (draft.submitted) submitted++;
  }

  return { tasks, submitted, adopted };
}
