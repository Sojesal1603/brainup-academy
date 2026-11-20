import type { TenantPrisma } from './db';
import {
  baseSubjectsFor,
  buildSubjectTutorPrompt,
  resolveCourse,
  type CourseOption,
} from './courseCatalog';
import { stageConfig } from './stages';
import { normalizeTopicTitle } from './temarioImport';

export interface CourseApplyResult {
  course: CourseOption;
  /** Materias que se han creado en esta pasada (vacío si ya estaban todas). */
  created: string[];
}

/**
 * Guarda el curso en el perfil y crea las materias base que falten.
 *
 * - `modality` sigue siendo la fuente; `stage`, `gradeLevel`, `trackKey` y
 *   `degreeName` se escriben derivados en la MISMA operación para que no puedan
 *   desincronizarse (este es el único escritor, junto con el backfill).
 * - 1º ESO conserva sus nueve materias; 2º–4º ESO traen su plantilla LOMLOE y
 *   Universidad, 3–5 troncales de la rama. Bachillerato no crea ninguna: las
 *   materias dependen de la modalidad y del centro.
 * - Es idempotente: cambiar de curso dos veces no duplica materias ni agentes, y
 *   nunca borra temario, exámenes ni horas de las materias que ya existían.
 */
export async function applyCourseToProfile(
  prisma: TenantPrisma,
  userId: string,
  modality: string
): Promise<CourseApplyResult> {
  const course = resolveCourse(modality);
  const config = stageConfig(course.stage);

  await prisma.userProfile.update({
    where: { id: userId },
    data: {
      modality: course.id,
      stage: course.stage,
      gradeLevel: course.gradeLevel,
      trackKey: course.trackKey,
      degreeName: course.degreeName,
    },
  });

  const baseSubjects = baseSubjectsFor(course);
  if (baseSubjects.length === 0) return { course, created: [] };

  const existing = await prisma.subject.findMany({ select: { name: true, order: true } });
  const existingKeys = new Set(existing.map((subject) => normalizeTopicTitle(subject.name)));
  let order = existing.reduce((max, subject) => Math.max(max, subject.order), 0);

  const created: string[] = [];
  for (const base of baseSubjects) {
    const key = normalizeTopicTitle(base.name);
    if (existingKeys.has(key)) continue;

    order += 1;
    const subject = await prisma.subject.create({
      data: {
        name: base.name,
        color: base.color,
        // La ponderación PAU solo existe donde la etapa la declara.
        pauWeight: config.scale.hasPau ? 0.2 : 0,
        isPhaseGeneral: config.scale.hasPau,
        currentGrade: 7.0,
        gradeSource: 'sin_medir',
        targetGrade: 9,
        order,
        isTracked: true,
      },
    });

    await prisma.aiAgent.create({
      data: {
        subjectId: subject.id,
        name: `Catedrático de ${base.name}`,
        specialty: config.supportsEcts
          ? `${course.degreeName ?? 'Grado'} · ${course.trackLabel ?? 'Universidad'}: ${base.name}${base.credits ? ` (${base.credits} ECTS)` : ''}`
          : `Currículo ${course.curriculum}: ${base.name}`,
        systemPrompt: buildSubjectTutorPrompt(base.name, course),
      },
    });

    existingKeys.add(key);
    created.push(base.name);
  }

  return { course, created };
}
