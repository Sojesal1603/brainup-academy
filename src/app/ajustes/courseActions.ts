'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { currentTenant } from '@/lib/tenantContext';
import { resolveCourse } from '@/lib/courseCatalog';
import { applyCourseToProfile } from '@/lib/courseApply';
import { normalizeStageSelection } from '@/lib/stages';

/**
 * Cambia el curso del alumno desde Ajustes (camino histórico de ESO y
 * Bachillerato: recibe una modalidad ya construida).
 *
 * Si el curso trae materias base, se crean las que falten. No se borra ninguna
 * materia anterior: cambiar de curso no puede destruir temario, exámenes ni
 * horas ya trabajadas.
 */
export async function setStudentCourse(formData: FormData): Promise<void> {
  const { userId, tenant } = await currentTenant();
  const requested = String(formData.get('course') ?? '').trim();
  if (!requested) return;

  const course = resolveCourse(requested);
  await applyCourseToProfile(tenant, userId, course.id);

  updateTag('perfil');
  updateTag('setup');
  updateTag('cuartel');
  updateTag('temario');
  revalidatePath('/ajustes');
  revalidatePath('/');
  revalidatePath('/planificador');
  revalidatePath('/horario');
  revalidatePath('/temario');
}

/**
 * Cambia etapa, curso, modalidad/rama y titulación desde el selector de Ajustes.
 *
 * El servidor normaliza con el catálogo de etapas: una etapa o un curso que no
 * existan caen al primer valor válido en vez de guardarse tal cual. La escritura
 * sigue siendo `applyCourseToProfile`, el único sitio que mantiene sincronizados
 * `modality`, `stage`, `gradeLevel`, `trackKey` y `degreeName`.
 */
export async function setStudentStage(formData: FormData): Promise<void> {
  const { userId, tenant } = await currentTenant();
  const selection = normalizeStageSelection({
    stage: String(formData.get('stage') ?? ''),
    gradeLevel: String(formData.get('gradeLevel') ?? ''),
    trackKey: String(formData.get('trackKey') ?? ''),
    degreeName: String(formData.get('degreeName') ?? ''),
  });

  await applyCourseToProfile(tenant, userId, selection.modality);

  updateTag('perfil');
  updateTag('setup');
  updateTag('cuartel');
  updateTag('temario');
  revalidatePath('/ajustes');
  revalidatePath('/');
  revalidatePath('/planificador');
  revalidatePath('/horario');
  revalidatePath('/temario');
  revalidatePath('/estadisticas');
}
