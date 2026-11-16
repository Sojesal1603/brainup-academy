'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { currentTenant } from '@/lib/tenantContext';
import { resolveCourse } from '@/lib/courseCatalog';
import { applyCourseToProfile } from '@/lib/courseApply';

/**
 * Cambia el curso del alumno desde Ajustes.
 *
 * Si el curso trae materias base (1º ESO), se crean las que falten. No se borra
 * ninguna materia anterior: cambiar de curso no puede destruir temario, exámenes
 * ni horas ya trabajadas.
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
