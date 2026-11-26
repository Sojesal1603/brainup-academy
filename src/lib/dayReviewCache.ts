import { unstable_cache } from 'next/cache';
import { reviewDayProgress, type DayReview } from './dayPlan';
import { PLAN_CACHE_TAGS } from './planCache';

const BUCKET_MS = 60_000;

/**
 * Foto del avance del día para `/planificador`.
 *
 * `reviewDayProgress` vuelve a cargar todo el contexto del plan (siete
 * consultas). Al entrar y salir de la sección se paga una vez por minuto y
 * usuario; cualquier cambio real invalida las etiquetas del plan y la próxima
 * apertura vuelve a leer la verdad.
 */
const loadDayReview = unstable_cache(
  async (userId: string, bucket: number): Promise<DayReview> => {
    return reviewDayProgress(userId, new Date(bucket * BUCKET_MS));
  },
  ['day-review-v1'],
  { revalidate: 60, tags: [...PLAN_CACHE_TAGS] }
);

export function getCachedDayReview(userId: string, now: Date = new Date()): Promise<DayReview> {
  return loadDayReview(userId, Math.floor(now.getTime() / BUCKET_MS));
}
