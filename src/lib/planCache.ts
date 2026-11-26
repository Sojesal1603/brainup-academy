import { revalidateTag } from 'next/cache';

/**
 * Etiquetas de todo lo que depende del plan del día.
 *
 * `DailyBrief`, el plan del Cuartel y la revisión del planificador comparten
 * estas etiquetas: cuando cambia el estado del alumno se purgan las tres de una
 * vez, sin esperar a que caduque ningún TTL. `invalidatePlan` es el único punto
 * que necesita llamarlo; las acciones ya lo usan para marcar `PlanState`.
 */
export const PLAN_CACHE_TAGS = ['daily-brief', 'cuartel', 'plan'] as const;

/**
 * Purga las lecturas materializadas del plan.
 *
 * `revalidateTag` solo existe dentro de una petición de Next. El mismo
 * `invalidatePlan` se llama desde acciones, rutas y cierres de sesión; si
 * alguno corre en un cron o en un script, no hay caché que purgar y no debe
 * romper la escritura. El `catch` es deliberado: la fuente de verdad es
 * `PlanState`, y la caché se reconstruye sola en la siguiente apertura.
 */
export function revalidatePlanCache(): void {
  for (const tag of PLAN_CACHE_TAGS) {
    try {
      revalidateTag(tag, 'max');
    } catch {
      // Fuera de una petición (cron/CLI): no hay caché de Next que invalidar.
    }
  }
}
