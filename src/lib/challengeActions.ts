'use server';

import { revalidatePath } from 'next/cache';
import { currentTenant } from './tenantContext';
import {
  refreshWeeklyChallenges as runRefresh,
  type RefreshChallengesResult,
} from './challengeRefresh';

/**
 * La acción de servidor de los retos.
 *
 * Aquí no hay lógica: el trabajo (generar, medir, cerrar y pagar XP) vive en
 * `challengeRefresh.ts`, que se puede ejecutar desde fuera de una petición. Esta
 * capa solo se ocupa de lo que es exclusivo de Next: decirle qué vistas han
 * cambiado para que se vuelvan a pintar.
 */

export async function refreshWeeklyChallenges(): Promise<RefreshChallengesResult> {
  const { user } = await currentTenant();
  return runRefresh(user.id, {
    onChanged: () => {
      revalidatePath('/retos');
      revalidatePath('/');
      revalidatePath('/estadisticas');
    },
  });
}
