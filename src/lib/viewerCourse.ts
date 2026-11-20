import { cache } from 'react';
import { getOptionalUser } from './auth';
import { safeDb } from './dbTimeout';
import { ensureUserProfile, getCachedProfileSummary } from './userProfile';
import { resolveCourse } from './courseCatalog';
import { getStageConfig, type EducationStage } from './stages';

export interface ViewerCourse {
  modality: string | null;
  label: string;
  curriculum: string;
  stage: EducationStage;
  /** Etiqueta de la marca en la barra lateral. */
  badge: string;
  /** Rutas que no deben pintarse en la navegación (p. ej. Examinador PAU). */
  hiddenHrefs: readonly string[];
}

const FALLBACK: ViewerCourse = {
  modality: null,
  label: 'Bachillerato',
  curriculum: 'Bachillerato (LOMLOE)',
  stage: 'BACHILLERATO',
  badge: 'Bachillerato & PAU',
  hiddenHrefs: [],
};

/**
 * Curso del alumno para la barra lateral.
 *
 * La Sidebar se monta en TODAS las rutas, así que esta lectura nunca puede
 * tumbar el layout: si no hay sesión, base o perfil, se cae a los valores por
 * defecto y la navegación sigue funcionando.
 */
export const getViewerCourse = cache(async (): Promise<ViewerCourse> => {
  try {
    if (!process.env.DATABASE_URL?.trim()) return FALLBACK;
    const authUser = await getOptionalUser();
    if (!authUser) return FALLBACK;

    const profile = await safeDb(
      'sidebar.curso',
      async () =>
        (await getCachedProfileSummary(authUser.id)) ?? (await ensureUserProfile(authUser.id)),
      null,
      1_200
    );
    if (!profile) return FALLBACK;

    const course = resolveCourse(profile.modality);
    const config = getStageConfig({ stage: profile.stage, modality: profile.modality });
    return {
      modality: profile.modality,
      label: course.label,
      curriculum: course.curriculum,
      stage: course.stage,
      badge: config.tools.navBadge,
      hiddenHrefs: config.tools.hiddenHrefs,
    };
  } catch (error) {
    console.error(
      '[sidebar] no se ha podido leer el curso:',
      error instanceof Error ? error.message : error
    );
    return FALLBACK;
  }
});
