import { db } from './db';
import { MoodleError } from './moodleWs';
import { checkMoodleAnyWay, syncMoodleAnyWay } from './moodleSync';
import { MoodleSessionNotConnectedError } from './moodleSessionSync';
import { MoodleNotConnectedError } from './moodleWsSync';
import type { MoodleAuthMode } from './moodleAuth';

/**
 * Cuidar la conexión de Moodle: comprobar las credenciales y volver a sincronizar.
 *
 * Los dos fallos que de verdad le pasan al alumno aquí son silenciosos:
 *
 *   1. **Las credenciales han dejado de valer.** La clave de Web Services caduca
 *      (y el centro puede revocarla); en la vía de sesión, la contraseña del
 *      alumno puede haber cambiado o el centro puede haber cerrado el paso. Hasta
 *      ahora la app seguía enseñando los cursos y las tareas de la última vez como
 *      si fueran de hoy, sin decir nada.
 *   2. **La sincronización se ha quedado vieja.** Nadie vuelve a llamar a Moodle
 *      y las tareas de la semana pasada no aparecen.
 *
 * Aquí se comprueban las dos cosas y se actúa, **por la vía que esté puesta**
 * (clave o sesión web: de eso se encarga `moodleSync`):
 *
 *   - Si las credenciales siguen valiendo y los datos son viejos → **se sincroniza
 *     solo**, sin molestar a nadie.
 *   - Si ya no valen → se marca (`moodleTokenState`) para que Ajustes lo diga con
 *     todas las letras, y se abre un aviso en el taller. Esto no se puede arreglar
 *     sin el alumno: su contraseña nueva (o su clave) solo la tiene él.
 *
 * La comprobación tiene enfriamiento (`MOODLE_CHECK_EVERY_MS`) porque la hace el
 * vigilante en cada ronda: no se puede estar entrando en Moodle cada cinco minutos.
 */

/** Días sin sincronizar a partir de los cuales los datos se consideran viejos. */
export const MOODLE_STALE_DAYS = 7;
/** Enfriamiento entre comprobaciones de la clave (el vigilante pasa cada pocos minutos). */
export const MOODLE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Título del aviso del taller: uno solo, y se cierra solo cuando vuelve a valer. */
export const MOODLE_TOKEN_ISSUE_TITLE = '[auto] La clave de Moodle ha caducado';
/** El mismo aviso cuando la vía es la sesión web (no hay clave que caduque). */
export const MOODLE_SESSION_ISSUE_TITLE = '[auto] La conexión con Moodle ha dejado de valer';

/** Título del aviso que toca según la vía de acceso. */
export function moodleIssueTitle(mode: MoodleAuthMode): string {
  return mode === 'sesion' ? MOODLE_SESSION_ISSUE_TITLE : MOODLE_TOKEN_ISSUE_TITLE;
}

export type MoodleTokenState = 'sin_conectar' | 'ok' | 'caducado' | 'sin_comprobar';

export interface MoodleHealth {
  connected: boolean;
  /** Vía de acceso: «token» (clave de Web Services) o «sesion» (usuario y contraseña). */
  mode: MoodleAuthMode;
  siteName: string | null;
  baseUrl: string | null;
  tokenState: MoodleTokenState;
  checkedAt: string | null;
  lastSyncAt: string | null;
  daysSinceSync: number | null;
  /** Los datos son más viejos de lo que se considera aceptable. */
  stale: boolean;
  /** Frase lista para enseñar (o registrar en el log del vigilante). */
  detail: string;
}

export interface MoodleHealResult extends MoodleHealth {
  /** Se ha comprobado la clave contra Moodle en esta pasada. */
  checked: boolean;
  /** Se ha vuelto a sincronizar en esta pasada. */
  synced: boolean;
  /** Qué ha pasado, en una frase. */
  note: string;
}

function daysBetween(from: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - from.getTime()) / 86400000));
}

function tokenStateOf(value: string | null | undefined, connected: boolean): MoodleTokenState {
  if (!connected) return 'sin_conectar';
  if (value === 'ok' || value === 'caducado') return value;
  return 'sin_comprobar';
}

/**
 * ¿Este error dice que las credenciales ya no sirven? (No es red ni permisos
 * sueltos.) En la vía de la clave es `invalidtoken`; en la de sesión, el usuario o
 * la contraseña rechazados, la sesión que no se abre o un Moodle que ha dejado de
 * enseñar su formulario de acceso.
 */
export function isDeadToken(error: unknown): boolean {
  if (!(error instanceof MoodleError)) return false;
  return ['invalidtoken', 'invalidlogin', 'login_failed', 'no_login_form'].includes(error.code);
}

/** ¿El error dice que no hay credenciales guardadas (y no que estén malas)? */
export function isNotConnectedError(error: unknown): boolean {
  return error instanceof MoodleNotConnectedError || error instanceof MoodleSessionNotConnectedError;
}

/**
 * Cómo está la conexión, **sin llamar a Moodle**: lo que dice la base.
 * Sirve para pintarlo en Ajustes y para decidir si toca comprobar.
 */
export async function readMoodleHealth(userId: string, now: Date = new Date()): Promise<MoodleHealth> {
  const prisma = db(userId);
  const [user, lastCourse] = await Promise.all([
    prisma.userProfile.findUnique({
      where: { id: userId },
      select: {
        moodleBaseUrl: true,
        moodleToken: true,
        moodleAuthMode: true,
        moodleUsername: true,
        moodlePasswordSealed: true,
        moodleSiteName: true,
        moodleTokenState: true,
        moodleCheckedAt: true,
        lastMoodleSync: true,
      },
    }),
    prisma.moodleCourse.findFirst({
      orderBy: { syncedAt: 'desc' },
      select: { syncedAt: true },
    }),
  ]);

  const mode: MoodleAuthMode = user?.moodleAuthMode === 'sesion' ? 'sesion' : 'token';
  const baseUrl = (user?.moodleBaseUrl ?? '').trim() || null;
  const byToken = Boolean((user?.moodleToken ?? '').trim());
  // Por sesión hace falta el usuario **y** la contraseña guardada: es lo que
  // permite entrar solo. Sin contraseña guardada, la app no puede comprobar nada
  // sin el alumno, y decir «conectado» sería mentira.
  const bySession = Boolean((user?.moodleUsername ?? '').trim() && user?.moodlePasswordSealed);
  const connected = Boolean(baseUrl) && (mode === 'sesion' ? bySession : byToken);
  const tokenState = tokenStateOf(user?.moodleTokenState, connected);

  // La sincronización más reciente, venga de Web Services o del calendario iCal.
  const syncDates = [user?.lastMoodleSync ?? null, lastCourse?.syncedAt ?? null].filter(
    (date): date is Date => date instanceof Date
  );
  const lastSyncAt = syncDates.length > 0 ? new Date(Math.max(...syncDates.map((d) => d.getTime()))) : null;
  const daysSinceSync = lastSyncAt ? daysBetween(lastSyncAt, now) : null;
  const stale = connected && (daysSinceSync === null || daysSinceSync >= MOODLE_STALE_DAYS);

  let detail: string;
  if (!connected) {
    detail =
      mode === 'sesion'
        ? 'Moodle no está conectado: faltan tu usuario o tu contraseña guardada, así que no hay nada que comprobar.'
        : 'Moodle no está conectado: no hay clave que comprobar.';
  } else if (tokenState === 'caducado') {
    detail =
      mode === 'sesion'
        ? 'Moodle ha dejado de aceptar tu usuario o tu contraseña (o el centro ha cambiado la forma de entrar). Vuelve a conectarlo en Ajustes → Moodle y se arregla en un minuto; lo que ya tienes descargado no se toca.'
        : 'La clave de Moodle ha dejado de valer (Moodle caduca las claves). Vuelve a entrar con tu usuario y contraseña en Ajustes y se arregla en un minuto.';
  } else if (tokenState === 'sin_comprobar') {
    detail =
      mode === 'sesion'
        ? 'Todavía no se ha comprobado que tu usuario y tu contraseña sigan valiendo en Moodle.'
        : 'Todavía no se ha comprobado la clave contra Moodle.';
  } else if (stale) {
    detail =
      daysSinceSync === null
        ? 'La conexión vale, pero no hay ninguna sincronización hecha todavía.'
        : `La conexión vale, pero los datos son de hace ${daysSinceSync} día(s).`;
  } else {
    detail = `Todo al día: la conexión vale y los datos son de hace ${daysSinceSync} día(s).`;
  }

  return {
    connected,
    mode,
    siteName: user?.moodleSiteName ?? null,
    baseUrl,
    tokenState,
    checkedAt: user?.moodleCheckedAt ? user.moodleCheckedAt.toISOString() : null,
    lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
    daysSinceSync,
    stale,
    detail,
  };
}

async function openTokenIssue(
  userId: string,
  detail: string,
  mode: MoodleAuthMode = 'token'
): Promise<boolean> {
  const prisma = db(userId);
  const title = moodleIssueTitle(mode);
  try {
    const existing = await prisma.systemIssue.findFirst({
      where: { title, status: { not: 'resuelto' } },
      select: { id: true },
    });
    if (existing) return false;

    await prisma.systemIssue.create({
      data: {
        title,
        detail: detail.slice(0, 4000),
        contextJson: JSON.stringify({
          kind: mode === 'sesion' ? 'moodle_sesion' : 'moodle_token',
          at: new Date().toISOString(),
        }).slice(0, 4000),
        source: 'vigilante',
        status: 'abierto',
      },
    });
    return true;
  } catch (error) {
    console.error('[moodle] no se ha podido abrir el aviso de la conexión:', error);
    return false;
  }
}

/** Cierra el aviso de Moodle: cualquiera de los dos, porque solo hay uno vivo. */
async function closeTokenIssue(userId: string, resolution: string): Promise<boolean> {
  const prisma = db(userId);
  try {
    const result = await prisma.systemIssue.updateMany({
      where: {
        title: { in: [MOODLE_TOKEN_ISSUE_TITLE, MOODLE_SESSION_ISSUE_TITLE] },
        status: { not: 'resuelto' },
      },
      data: { status: 'resuelto', resolution: resolution.slice(0, 1000) },
    });
    return result.count > 0;
  } catch (error) {
    console.error('[moodle] no se ha podido cerrar el aviso de la conexión:', error);
    return false;
  }
}

/**
 * La pasada de cuidado: comprueba la clave (si toca) y sincroniza (si hace falta).
 *
 * Nunca lanza: devuelve el estado y una frase con lo que ha pasado. Un fallo de
 * red no deja la conexión marcada como caducada —eso sería mentir— y no gasta el
 * enfriamiento, así que la ronda siguiente lo vuelve a intentar.
 */
export async function healMoodleConnection(
  userId: string,
  options: { force?: boolean; log?: (line: string) => void; now?: Date } = {}
): Promise<MoodleHealResult> {
  const prisma = db(userId);
  const log = options.log ?? (() => {});
  const now = options.now ?? new Date();
  const before = await readMoodleHealth(userId, now);

  if (!before.connected) {
    return { ...before, checked: false, synced: false, note: before.detail };
  }

  const lastCheck = before.checkedAt ? new Date(before.checkedAt).getTime() : 0;
  const dueForCheck = options.force === true || now.getTime() - lastCheck >= MOODLE_CHECK_EVERY_MS;

  // Nada que hacer: comprobado hace poco y sin datos viejos.
  if (!dueForCheck && !before.stale) {
    return { ...before, checked: false, synced: false, note: 'Comprobado hace poco: no toca.' };
  }

  let checked = false;

  // 1. ¿Siguen valiendo las credenciales? Se comprueba entrando de verdad en
  //    Moodle por la vía que esté puesta (clave o sesión web).
  if (dueForCheck) {
    try {
      const check = await checkMoodleAnyWay(userId);
      checked = true;

      await prisma.userProfile.update({
        where: { id: userId },
        data: {
          moodleTokenState: 'ok',
          moodleCheckedAt: now,
          moodleSiteName: check.siteName,
          ...(check.userId > 0 ? { moodleUserId: check.userId } : {}),
        },
      });

      // Si había un aviso de conexión caída, ya no aplica.
      const closed = await closeTokenIssue(userId, 'Resuelto solo: la conexión con Moodle vuelve a funcionar.');
      if (closed) log('la conexión con Moodle vuelve a funcionar: aviso cerrado');
    } catch (error) {
      // Sin credenciales guardadas no hay nada que comprobar (y no es un fallo).
      if (isNotConnectedError(error)) {
        return { ...before, checked: false, synced: false, note: before.detail };
      }

      if (isDeadToken(error)) {
        await prisma.userProfile.update({
          where: { id: userId },
          data: { moodleTokenState: 'caducado', moodleCheckedAt: now },
        });

        const bySession = before.mode === 'sesion';
        const detail = bySession
          ? 'Moodle ha dejado de aceptar el usuario o la contraseña guardados. Puede que hayas cambiado la contraseña en el instituto, ' +
            'o que el centro haya cambiado la forma de entrar. La app no puede adivinar la nueva: ' +
            'entra en Ajustes → Moodle, elige «Usuario y contraseña» y vuelve a conectarlo. Tus apuntes y tareas ya descargados no se tocan.'
          : 'Moodle ha rechazado la clave guardada (invalidtoken): ha caducado o el centro la ha revocado. ' +
            'La app no puede pedir otra sin ti, porque necesita tu usuario y tu contraseña. ' +
            'Entra en Ajustes → Moodle y vuelve a conectarlo; tus apuntes y tareas ya descargados no se tocan.';
        const opened = await openTokenIssue(userId, detail, before.mode);
        log(
          `${bySession ? 'Moodle ha dejado de aceptar las credenciales' : 'la clave de Moodle ha caducado'}${opened ? ' (aviso abierto en el taller)' : ''}`
        );

        return {
          ...(await readMoodleHealth(userId, now)),
          checked: true,
          synced: false,
          note: bySession
            ? 'La conexión con Moodle ha dejado de valer: hay que volver a conectarlo desde Ajustes.'
            : 'La clave de Moodle ha caducado: hay que volver a conectarlo desde Ajustes.',
        };
      }

      // Red caída, Moodle en mantenimiento… No se sabe nada de las credenciales,
      // así que no se marca nada y no se consume el enfriamiento (se reintenta).
      log(
        `no se ha podido comprobar la conexión con Moodle: ${
          error instanceof Error ? error.message.slice(0, 120) : String(error)
        }`
      );
      return {
        ...before,
        checked: false,
        synced: false,
        note: 'Moodle no ha contestado a la comprobación: se vuelve a intentar en la próxima ronda.',
      };
    }
  }

  // 2. ¿Los datos son viejos? Entonces se sincroniza sola.
  if (!before.stale && options.force !== true) {
    const after = await readMoodleHealth(userId, now);
    return { ...after, checked, synced: false, note: after.detail };
  }

  try {
    const { stats } = await syncMoodleAnyWay(userId, { log });
    await prisma.userProfile.update({
      where: { id: userId },
      data: { lastMoodleSync: now, moodleTokenState: 'ok', moodleCheckedAt: now },
    });

    log(
      `Moodle sincronizado solo: ${stats.courses} curso(s), ${stats.tasks} tarea(s), ${stats.materials} apunte(s)`
    );

    return {
      ...(await readMoodleHealth(userId, now)),
      checked,
      synced: true,
      note: `Sincronizado: ${stats.courses} curso(s), ${stats.tasks} tarea(s) y ${stats.materials} apunte(s).`,
    };
  } catch (error) {
    if (isDeadToken(error)) {
      await prisma.userProfile.update({
        where: { id: userId },
        data: { moodleTokenState: 'caducado', moodleCheckedAt: now },
      });
      await openTokenIssue(
        userId,
        before.mode === 'sesion'
          ? 'Moodle ha dejado de aceptar las credenciales guardadas al sincronizar. ' +
              'Vuelve a conectarlo desde Ajustes → Moodle con tu usuario y contraseña de siempre.'
          : 'Moodle ha rechazado la clave guardada al sincronizar (invalidtoken): ha caducado. ' +
              'Vuelve a conectarlo desde Ajustes → Moodle con tu usuario y contraseña.',
        before.mode
      );
      log('la conexión con Moodle ha dejado de valer al intentar sincronizar');
      return {
        ...(await readMoodleHealth(userId, now)),
        checked,
        synced: false,
        note: 'La conexión con Moodle ha dejado de valer: hay que volver a conectarlo desde Ajustes.',
      };
    }

    const message = isNotConnectedError(error)
      ? 'Moodle ya no está conectado.'
      : error instanceof Error
        ? error.message.slice(0, 200)
        : String(error);

    log(`no se ha podido sincronizar con Moodle: ${message}`);
    return {
      ...before,
      checked,
      synced: false,
      note: `No se ha podido sincronizar con Moodle: ${message}`,
    };
  }
}
