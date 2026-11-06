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
/* Origen real de la petición                                          */
/* ------------------------------------------------------------------ */

/**
 * Un `Host` de verdad: nombre, IPv4 o IPv6 entre corchetes, con puerto opcional.
 * Se valida porque `Host` lo pone el cliente: no puede acabar dentro de un
 * `Location` que la app devuelva.
 */
const HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?$|^\[[0-9a-f:]+\](?::\d{1,5})?$/i;

function firstHeader(request: Request, name: string): string {
  return (request.headers.get(name) ?? '').split(',')[0].trim();
}

/** El host de una cabecera, si sirve para navegar (no `0.0.0.0` ni `[::]`). */
function navigableHost(value: string): string | null {
  const host = String(value ?? '').trim().toLowerCase();
  if (!host || !HOST_PATTERN.test(host)) return null;

  const name = host.replace(/:\d+$/, '');
  if (name === '0.0.0.0' || name === '[::]' || name === '::') return null;
  return host;
}

/**
 * El origen por el que ha entrado el navegador de verdad.
 *
 * `sirve.js` escucha en `0.0.0.0` y Next construye `request.url` con esa
 * dirección: `http://0.0.0.0:3000`. Devolver al navegador un `Location` ahí es
 * un `ERR_ADDRESS_INVALID` (0.0.0.0 no es una dirección a la que se pueda
 * navegar), y ese era el fallo del login. Aquí se usa:
 *   1. `x-forwarded-host` / `Host`, que es la dirección que el navegador escribió
 *      (localhost, la IP de la Wi-Fi o el dominio de la nube);
 *   2. `x-forwarded-proto` para el protocolo que pone el proxy de delante
 *      (Netlify, Render…), o el de `request.url` si no lo hay;
 *   3. y, solo si no hay nada usable, `localhost` con el puerto del servidor.
 *
 * Así el login funciona igual desde el ordenador, desde el móvil en la misma red
 * y en producción, sin dirección fija en el código.
 */
export function requestOrigin(request: Request): string {
  let parsed: URL | null = null;
  try {
    parsed = new URL(request.url);
  } catch {
    parsed = null;
  }

  const protoHeader = firstHeader(request, 'x-forwarded-proto').toLowerCase();
  const proto =
    protoHeader === 'https'
      ? 'https'
      : protoHeader === 'http'
        ? 'http'
        : parsed?.protocol === 'https:'
          ? 'https'
          : 'http';

  const host =
    navigableHost(firstHeader(request, 'x-forwarded-host')) ??
    navigableHost(firstHeader(request, 'host')) ??
    navigableHost(parsed?.host ?? '');

  if (host) return `${proto}://${host}`;

  return `${proto}://localhost:${parsed?.port || '3000'}`;
}

/** URL absoluta de una ruta de esta app, con el origen real del navegador. */
export function appUrl(request: Request, path: string): URL {
  return new URL(path, requestOrigin(request));
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
