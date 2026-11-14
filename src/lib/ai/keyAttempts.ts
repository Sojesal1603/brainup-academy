import { db } from '../db';
import { prisma } from '../prisma';

/**
 * Límite de intentos al pegar o comprobar una clave de IA.
 *
 * Es una defensa contra el sondeo de claves desde una cuenta con sesión: no se
 * puede probar un diccionario de claves a base de POST. La ventana es corta (5
 * intentos cada 10 minutos).
 *
 * El contador vive en `AiKeyAttempt`, no en memoria: una tabla con RLS vale
 * igual en todas las instancias serverless y sobrevive a un reinicio. Cada fila
 * es un intento; la ventana se limpia al contar y no hay un contador que pueda
 * desincronizarse.
 */

export const AI_KEY_ATTEMPT_WINDOW_MS = 10 * 60_000;
export const AI_KEY_ATTEMPT_MAX = 5;

/**
 * Cuánto se guardan los intentos: 24 h.
 *
 * La ventana de 10 minutos ya los cuenta, así que un intento más viejo no sirve
 * para nada. Sin este barrido, la tabla solo se limpiaba cuando el MISMO usuario
 * volvía a intentarlo: las cuentas que probaron una vez y no volvieron dejaban
 * sus filas para siempre, y la tabla crecía sin fin.
 */
export const AI_KEY_ATTEMPT_RETENTION_MS = 24 * 60 * 60_000;

/** No se barre en cada intento: una vez por hora basta. */
const SWEEP_EVERY_MS = 60 * 60_000;
let lastSweepAt = 0;

/**
 * Borra los intentos de más de 24 h de TODAS las cuentas.
 *
 * Usa el cliente crudo a propósito: `db(userId)` añadiría el dueño de la
 * petición y dejaría fuera justo a las cuentas dormidas, que son las que
 * acumulan. No lee ni devuelve datos de nadie: solo borra filas caducadas.
 */
export async function pruneOldAiKeyAttempts(now: Date = new Date()): Promise<number> {
  if (now.getTime() - lastSweepAt < SWEEP_EVERY_MS) return 0;
  lastSweepAt = now.getTime();
  const cutoff = new Date(now.getTime() - AI_KEY_ATTEMPT_RETENTION_MS);
  const result = await prisma.aiKeyAttempt.deleteMany({ where: { attemptedAt: { lt: cutoff } } });
  return result.count;
}

export interface AttemptResult {
  ok: boolean;
  /** Segundos que faltan para poder volver a intentarlo (solo si `ok=false`). */
  retryAfterSeconds: number;
}

/**
 * Cuenta un intento y dice si se permite.
 *
 * La transacción bloquea la fila del perfil (`FOR UPDATE`) para que dos
 * peticiones simultáneas de la misma cuenta no puedan leer el mismo recuento y
 * colarse las dos. Es un lock por usuario, no global: no frena a los demás.
 */
export async function consumeAiKeyAttempt(
  userId: string,
  now: Date = new Date()
): Promise<AttemptResult> {
  // Limpieza de fondo: si falla (permisos, base caída), el intento sigue su
  // curso; no se convierte un problema de mantenimiento en un 500 para el alumno.
  await pruneOldAiKeyAttempts(now).catch((error) => {
    console.warn(
      '[ia] no se han podido borrar los intentos de más de 24 h:',
      error instanceof Error ? error.message : String(error)
    );
  });
  const cutoff = new Date(now.getTime() - AI_KEY_ATTEMPT_WINDOW_MS);

  return db(userId).$transaction(async (tx) => {
    // Serializa los intentos de ESTA cuenta. El perfil siempre existe: la
    // sesión ya ha pasado por ensureUserProfile antes de llegar aquí.
    await tx.$queryRaw`SELECT id FROM "UserProfile" WHERE id = ${userId} FOR UPDATE`;

    await tx.aiKeyAttempt.deleteMany({ where: { attemptedAt: { lt: cutoff } } });

    const recent = await tx.aiKeyAttempt.findMany({
      where: { attemptedAt: { gte: cutoff } },
      orderBy: { attemptedAt: 'asc' },
      select: { attemptedAt: true },
    });

    if (recent.length >= AI_KEY_ATTEMPT_MAX) {
      const oldest = recent[0]?.attemptedAt ?? now;
      return {
        ok: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((oldest.getTime() + AI_KEY_ATTEMPT_WINDOW_MS - now.getTime()) / 1000)
        ),
      };
    }

    await tx.aiKeyAttempt.create({ data: { userId, attemptedAt: now } });
    return { ok: true, retryAfterSeconds: 0 };
  });
}

/** Limpia el contador tras una comprobación correcta. */
export async function resetAiKeyAttempts(userId: string): Promise<void> {
  await db(userId).aiKeyAttempt.deleteMany({});
}
