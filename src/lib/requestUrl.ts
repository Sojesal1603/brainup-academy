/**
 * Utilidades de navegación para la puerta de entrada.
 *
 * `request.url` puede traer la dirección interna del servidor (`0.0.0.0`), que
 * el navegador no puede abrir. Estas funciones usan el host y el protocolo que
 * el navegador escribió de verdad, y solo aceptan rutas internas como destino.
 */

/** Un `Host` de verdad: nombre, IPv4 o IPv6 entre corchetes, con puerto opcional. */
const HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?$|^\[[0-9a-f:]+\](?::\d{1,5})?$/i;

function firstHeader(request: Request, name: string): string {
  return (request.headers.get(name) ?? '').split(',')[0].trim();
}

/** El host de una cabecera, si sirve para navegar (no `0.0.0.0` ni `[::]`). */
function navigableHost(value: string): string | null {
  const host = String(value ?? '').trim().toLowerCase();
  if (!host || !HOST_PATTERN.test(host)) return null;

  const name = host.replace(/:[0-9]+$/, '');
  if (name === '0.0.0.0' || name === '[::]' || name === '::') return null;
  return host;
}

/**
 * El origen por el que ha entrado el navegador de verdad.
 *
 * `sirve.js` escucha en `0.0.0.0` y Next construye `request.url` con esa
 * dirección. Devolver al navegador un `Location` ahí es un
 * `ERR_ADDRESS_INVALID`, así que se prefiere `x-forwarded-host`/`Host`.
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

/**
 * Una dirección de vuelta solo vale si es una ruta de esta misma app. Sin esto,
 * `/login?next=https://otro-sitio` convertiría el formulario en un trampolín
 * hacia un sitio ajeno después de iniciar sesión.
 */
export function safeNextPath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw.startsWith('/')) return '/';
  // `//sitio-ajeno` y `/\\sitio-ajeno` también son «fuera» para el navegador.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.startsWith('/login') || raw.startsWith('/api/auth/')) return '/';
  return raw;
}
