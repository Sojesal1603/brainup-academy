/**
 * La puerta de entrada de la app: usuario y contraseña, sin servicios de pago.
 *
 * Netlify cobra por la protección con contraseña del sitio, así que la puerta se
 * pone aquí dentro: un `proxy.ts` que corta cada petición y un formulario que, si
 * las credenciales son correctas, deja una cookie firmada. Lo único que hace
 * falta es definir `AUTH_USER` y `AUTH_PASSWORD` en el entorno.
 *
 * Cómo se guarda la sesión, y por qué así:
 *   - La cookie **no lleva la contraseña** ni nada que se pueda reutilizar para
 *     adivinarla: lleva `v1.<caducidad>.<firma>`, donde la firma es un
 *     HMAC-SHA256 con `AUTH_SECRET`. Si alguien cambia la caducidad a mano, la
 *     firma deja de cuadrar y la puerta vuelve a pedir la contraseña.
 *   - Es `httpOnly` (el JavaScript de la página no puede leerla) y `SameSite=Lax`
 *     (un formulario de otro sitio no puede usarla para entrar).
 *   - Dura 30 días: es lo que hace que en el móvil se pida una vez y no en cada
 *     visita. Se cambia con `AUTH_SESSION_DAYS`.
 *   - Si cambias la contraseña, las sesiones abiertas dejan de valer solas (la
 *     firma se deriva de ella cuando no hay `AUTH_SECRET`).
 *
 * Todo se hace con Web Crypto (`crypto.subtle`), que existe tanto en Node como en
 * el runtime de Netlify: este módulo no importa `node:crypto`, `fs` ni nada que
 * ate la puerta a un runtime concreto.
 */

const encoder = new TextEncoder();

/** Nombre de la cookie de sesión. */
export const AUTH_COOKIE = 'brainup_sesion';

const TOKEN_VERSION = 'v1';
const DEFAULT_SESSION_DAYS = 30;

export interface AuthConfig {
  user: string;
  password: string;
  /** Clave con la que se firma la cookie (`AUTH_SECRET`, o la contraseña si falta). */
  secret: string;
  /** Cuánto dura la sesión, en milisegundos. */
  sessionMs: number;
}

/**
 * Lee las credenciales del entorno. Devuelve `null` si no están puestas, que es
 * el caso de una instalación recién clonada: entonces no hay puerta que abrir.
 */
export function readAuthConfig(): AuthConfig | null {
  const user = (process.env.AUTH_USER ?? '').trim();
  const password = process.env.AUTH_PASSWORD ?? '';
  if (!user || !password) return null;

  const secret = (process.env.AUTH_SECRET ?? '').trim() || password;

  const rawDays = Number(process.env.AUTH_SESSION_DAYS);
  const days =
    Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : DEFAULT_SESSION_DAYS;

  return { user, password, secret, sessionMs: days * 24 * 60 * 60 * 1000 };
}

/**
 * Escape para las comprobaciones locales que hablan con la app por HTTP
 * (`npm run verify:*`, el vigilante…): con `AUTH_DISABLED=1` la puerta se abre.
 * Nunca se activa sola y no está pensada para el despliegue.
 */
export function isAuthDisabled(): boolean {
  return /^(1|true|si|sí|yes)$/i.test((process.env.AUTH_DISABLED ?? '').trim());
}

export function sessionMaxAgeSeconds(config: AuthConfig): number {
  return Math.floor(config.sessionMs / 1000);
}

/**
 * Una dirección de vuelta solo vale si es una ruta de esta misma app. Sin esto,
 * `/login?next=https://otro-sitio` convertiría el formulario en un trampolín
 * hacia un sitio ajeno después de escribir la contraseña.
 */
export function safeNextPath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw.startsWith('/')) return '/';
  // `//sitio-ajeno` y `/\sitio-ajeno` también son «fuera» para el navegador.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.startsWith('/login')) return '/';
  return raw;
}

/* ------------------------------------------------------------------ */
/* Utilidades de firma                                                 */
/* ------------------------------------------------------------------ */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

/** Comparación de igual a igual: nunca termina antes por el primer byte distinto. */
function equalsConstantTime(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

/* ------------------------------------------------------------------ */
/* Sesión                                                              */
/* ------------------------------------------------------------------ */

/** Crea la cookie de sesión: versión, caducidad y firma. */
export async function createSessionToken(
  config: AuthConfig,
  now: number = Date.now()
): Promise<string> {
  const payload = `${TOKEN_VERSION}.${now + config.sessionMs}`;
  return `${payload}.${await sign(config.secret, payload)}`;
}

/** ¿La cookie que trae el navegador está firmada y sigue en vigor? */
export async function verifySessionToken(
  token: string | null | undefined,
  config: AuthConfig,
  now: number = Date.now()
): Promise<boolean> {
  const raw = String(token ?? '');
  const parts = raw.split('.');
  if (parts.length !== 3) return false;

  const [version, expiresRaw, signature] = parts;
  if (version !== TOKEN_VERSION) return false;

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const expected = await sign(config.secret, `${version}.${expiresRaw}`);
  return equalsConstantTime(expected, signature);
}

/**
 * ¿Son estas las credenciales del `.env`? Se comparan los resúmenes (no el texto)
 * para que el tiempo de respuesta no delate cuántos caracteres acertaba.
 */
export async function verifyCredentials(
  config: AuthConfig,
  user: string,
  password: string
): Promise<boolean> {
  const [expectedUser, givenUser, expectedPassword, givenPassword] = await Promise.all([
    sha256(config.user),
    sha256(user),
    sha256(config.password),
    sha256(password),
  ]);
  const userOk = equalsConstantTime(expectedUser, givenUser);
  const passwordOk = equalsConstantTime(expectedPassword, givenPassword);
  return userOk && passwordOk;
}
