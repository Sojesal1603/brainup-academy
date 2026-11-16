import type { TenantPrisma } from './db';
import {
  baseSubjectsFor,
  buildSubjectTutorPrompt,
  resolveCourse,
  type CourseOption,
} from './courseCatalog';
import { normalizeTopicTitle } from './temarioImport';

export interface CourseApplyResult {
  course: CourseOption;
  /** Materias que se han creado en esta pasada (vacío si ya estaban todas). */
  created: string[];
}

/**
 * Guarda el curso en el perfil y, si ese curso trae materias base (1º ESO),
 * crea las que falten con su Catedrático IA ya configurado para LOMLOE.
 *
 * Es idempotente: cambiar de curso dos veces no duplica materias ni agentes, y
 * nunca borra las materias que el alumno ya tenía de otro curso.
 */
export async function applyCourseToProfile(
  prisma: TenantPrisma,
  userId: string,
  modality: string
): Promise<CourseApplyResult> {
  const course = resolveCourse(modality);

  await prisma.userProfile.update({
    where: { id: userId },
    data: { modality: course.id },
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
        // En ESO no hay ponderación PAU: la materia no se prepara para ella.
        pauWeight: 0,
        isPhaseGeneral: false,
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
        specialty: `Currículo LOMLOE de ${course.label}: ${base.name}`,
        systemPrompt: buildSubjectTutorPrompt(base.name, course),
      },
    });

    existingKeys.add(key);
    created.push(base.name);
  }

  return { course, created };
}
