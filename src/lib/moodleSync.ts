/**
 * Una sola puerta para hablar con Moodle.
 *
 * Hay dos vías —la clave de Web Services y la sesión web con usuario y
 * contraseña— y quien llama (la interfaz, el vigilante, los verificadores) no
 * tiene por qué saber cuál está puesta. Aquí se mira la vía elegida y se usa esa.
 *
 * Cuando el alumno conecta con usuario y contraseña, la app **prueba primero la
 * clave** (es la vía limpia: con ella no hace falta guardar la contraseña). Si su
 * centro no deja pedirla, entra por sesión y se queda con esa. Eso lo decide
 * `connectMoodleAnyWay`, que es lo que usa la pantalla de Ajustes.
 */

import { db } from './db';
import { MoodleError, getSiteInfo, normalizeMoodleBaseUrl, requestMoodleToken } from './moodleWs';
import {
  connectMoodle,
  getMoodleConnection,
  MoodleNotConnectedError,
  syncMoodleWebServices,
  type MoodleWsSyncStats,
} from './moodleWsSync';
import { getMoodleAuthMode, getMoodleSessionAuth, saveMoodleSessionAuth, type MoodleAuthMode } from './moodleAuth';
import { loginToMoodle } from './moodleSession';
import { MoodleSessionNotConnectedError, checkMoodleSession, syncMoodleViaSession } from './moodleSessionSync';

export interface MoodleSyncOutcome {
  via: MoodleAuthMode;
  stats: MoodleWsSyncStats;
}

/** Sincroniza por la vía que esté elegida. */
export async function syncMoodleAnyWay(
  userId: string,
  options: { log?: (line: string) => void } = {}
): Promise<MoodleSyncOutcome> {
  const mode = await getMoodleAuthMode(userId);
  if (mode === 'sesion') {
    return { via: 'sesion', stats: await syncMoodleViaSession(userId, options) };
  }
  return { via: 'token', stats: await syncMoodleWebServices(userId) };
}

export interface MoodleCheckOutcome {
  via: MoodleAuthMode;
  siteName: string;
  userName: string;
  userId: number;
  /** Funciones que trae la clave (solo en la vía de la clave). */
  functionCount: number | null;
}

/**
 * Comprueba que la conexión sigue viva: entra y mira quién es. Si las
 * credenciales ya no valen, lanza un `MoodleError` con el mensaje que hay que
 * enseñarle al alumno.
 */
export async function checkMoodleAnyWay(userId: string): Promise<MoodleCheckOutcome> {
  const mode = await getMoodleAuthMode(userId);

  if (mode === 'sesion') {
    const check = await checkMoodleSession(userId);
    return {
      via: 'sesion',
      siteName: check.siteName,
      userName: check.userName,
      userId: check.userId,
      functionCount: null,
    };
  }

  const connection = await getMoodleConnection(userId);
  if (!connection) throw new MoodleNotConnectedError();
  const site = await getSiteInfo(connection.baseUrl, connection.token);
  return {
    via: 'token',
    siteName: site.siteName,
    userName: site.userName,
    userId: site.userId,
    functionCount: site.functions.length,
  };
}

export interface MoodleConnectOutcome {
  via: MoodleAuthMode;
  siteName: string;
  userName: string;
  /** Funciones de la clave, si se ha podido usar la clave. */
  functionCount: number | null;
  /**
   * Por qué no se ha podido usar la clave, cuando ha hecho falta entrar por
   * sesión. Se le enseña al alumno: si su centro le deja crear la clave, esa vía
   * es mejor (no guarda la contraseña).
   */
  tokenTrouble: string | null;
}

/**
 * Conecta con Moodle de la mejor manera posible a partir de lo que el alumno ha
 * escrito:
 *
 *   - Si trae **usuario y contraseña**: se intenta pedir la clave primero. Si el
 *     centro no la da (servicio móvil apagado, claves prohibidas al alumnado,
 *     acceso único…), se entra por sesión web con esos mismos datos y se guardan
 *     (la contraseña, cifrada, si el alumno lo ha permitido).
 *   - Si trae **solo la clave**: se conecta por Web Services, como siempre.
 */
export async function connectMoodleAnyWay(
  userId: string,
  params: {
  baseUrl: string;
  token?: string | null;
  username?: string | null;
  password?: string | null;
  /** Guardar la contraseña (cifrada) para poder reconectar solo. */
  sealPassword?: boolean;
}): Promise<MoodleConnectOutcome> {
  const baseUrl = String(params.baseUrl ?? '');
  const username = String(params.username ?? '').trim();
  const password = String(params.password ?? '');
  const token = String(params.token ?? '').trim();

  const prisma = db(userId);

  // Vía de la clave, tal cual la pide el alumno.
  if (token.length > 0 && username.length === 0) {
    const site = await connectMoodle(userId, baseUrl, token);
    await prisma.userProfile.update({
      where: { id: userId },
      data: {
        moodleAuthMode: 'token',
        moodlePasswordSealed: null,
        moodleTokenState: 'ok',
        moodleCheckedAt: new Date(),
      },
    });
    return {
      via: 'token',
      siteName: site.siteName,
      userName: site.userName,
      functionCount: site.functions.length,
      tokenTrouble: null,
    };
  }

  if (username.length === 0 || password.length === 0) {
    throw new MoodleError(
      'Hacen falta la dirección de tu Moodle, tu usuario y tu contraseña (o tu clave de seguridad).',
      'missing_credentials'
    );
  }

  // 1. La vía limpia: pedirle la clave a Moodle con el usuario y la contraseña.
  let tokenTrouble: string | null = null;
  try {
    const { token: requested } = await requestMoodleToken(baseUrl, username, password);
    const site = await connectMoodle(userId, baseUrl, requested);

    await prisma.userProfile.update({
      where: { id: userId },
      data: {
        moodleAuthMode: 'token',
        moodleUsername: username.slice(0, 120),
        // Con la clave no hace falta quedarse con la contraseña de nadie.
        moodlePasswordSealed: null,
        moodleTokenState: 'ok',
        moodleCheckedAt: new Date(),
      },
    });

    return {
      via: 'token',
      siteName: site.siteName,
      userName: site.userName,
      functionCount: site.functions.length,
      tokenTrouble: null,
    };
  } catch (error) {
    // Hay fallos que NO se arreglan probando la otra puerta, y probarla solo
    // serviría para tapar el motivo bueno con uno peor: si las credenciales son
    // las que no valen, si Moodle está en mantenimiento o si no hay red, ese es
    // el mensaje que el alumno tiene que leer.
    const fatalCodes = ['network', 'invalidlogin', 'invalidusername', 'sitemaintenance'];
    if (error instanceof MoodleError && fatalCodes.includes(error.code)) throw error;
    tokenTrouble = error instanceof Error ? error.message : String(error);
  }

  // 2. La puerta del navegador: entrar como entraría el alumno. Si tampoco se
  //    puede, el mensaje lleva LOS DOS motivos: el de la clave y el de la sesión.
  let session: Awaited<ReturnType<typeof loginToMoodle>>;
  try {
    session = await loginToMoodle({ baseUrl, username, password });
  } catch (sessionError) {
    const reason = sessionError instanceof Error ? sessionError.message : String(sessionError);
    throw new MoodleError(
      `Tu centro no deja usar la clave de Web Services (${tokenTrouble}) y entrando como el navegador con tu usuario y tu contraseña tampoco he podido: ${reason}`,
      sessionError instanceof MoodleError ? sessionError.code : 'login_failed'
    );
  }

  await saveMoodleSessionAuth(userId, {
    baseUrl: session.baseUrl,
    username,
    password,
    siteName: session.siteName,
    userId: session.userId,
    seal: params.sealPassword !== false,
  });

  return {
    via: 'sesion',
    siteName: session.siteName,
    userName: session.userName,
    functionCount: null,
    tokenTrouble,
  };
}

export { MoodleSessionNotConnectedError, normalizeMoodleBaseUrl };
