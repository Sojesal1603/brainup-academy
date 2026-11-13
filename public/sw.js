/**
 * Service Worker de BrainUp Academy (PWA).
 *
 * Regla de oro: **por aquí no pasa nada que no sea estático e inmutable**.
 *
 * Historial de por qué está así:
 *
 *   - Antes interceptaba todas las peticiones y, si la red fallaba, buscaba en
 *     una caché que nadie rellenaba. Eso no da soporte offline: añade una capa
 *     más que fallar justo cuando el servidor recompila.
 *   - Después se cacheaban los archivos de `/_next/static/`. En producción los
 *     chunks llevan hash y son inmutables, pero en desarrollo Turbopack usa
 *     URLs estables cuyo contenido cambia en cada compilación. El SW servía el
 *     JavaScript viejo junto al HTML nuevo: hidratación rota, pantallas que se
 *     quedan «cargando» y bucles de recarga. Ese es el bloqueo que había.
 *
 * Ahora:
 *   - **Nada de `/_next/`**: ni chunks, ni CSS, ni HMR. Next ya los sirve con
 *     caché propia y nombres con hash cuando toca; el SW no puede mejorarlo y
 *     sí puede romperlo.
 *   - Las peticiones de datos (`/api/*`), las de React Server Components
 *     (`?_rsc=`, cabecera `RSC`) y cualquier cosa que no sea GET van **directas
 *     a la red**, sin tocarlas.
 *   - **Las páginas no se tocan.** El navegador las pide y punto; un fallo de
 *     red puntual no se convierte en «No se puede acceder a este sitio web».
 *   - Solo se guardan iconos, imágenes y fuentes: recursos que no cambian de
 *     contenido bajo la misma URL.
 */
// v5: se dejan de cachear los chunks de Next. Al cambiar el nombre se borran
// las cachés viejas en `activate`, que son las que podían servir código rancio.
// v6: cambia el logo, así que hay que soltar los iconos cacheados con la marca
// anterior.
const CACHE_NAME = 'brainup-v6';

/** Lo que sí se guarda: recursos propios que no cambian de contenido. */
function isStaticAsset(url) {
  // Los chunks de Next/Turbopack quedan fuera a propósito (ver cabecera).
  if (url.pathname.startsWith('/_next/')) return false;
  // El propio SW nunca se cachea: se pide siempre a la red.
  if (url.pathname === '/sw.js') return false;
  // Nada de JavaScript ni CSS: su contenido puede cambiar bajo la misma URL.
  if (/\.(?:js|mjs|css)$/i.test(url.pathname)) return false;

  return /\.(?:png|jpe?g|svg|ico|webp|woff2?|ttf|json|webmanifest)$/i.test(url.pathname);
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Fuera las cachés viejas: si quedara una, podría servir código antiguo.
      const nombres = await caches.keys();
      await Promise.all(
        nombres.filter((nombre) => nombre !== CACHE_NAME).map((nombre) => caches.delete(nombre))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Solo se toca lo propio, en GET, y nunca los datos ni las peticiones de RSC.
  const esPropio = url.origin === self.location.origin;
  const esRsc = url.searchParams.has('_rsc') || request.headers.get('RSC') === '1';
  const esDatos = url.pathname.startsWith('/api/') || url.pathname.startsWith('/_next/data/');
  // Navegar es del navegador: aquí no se mete nadie.
  const esPagina = request.mode === 'navigate';

  if (request.method !== 'GET' || !esPropio || esRsc || esDatos || esPagina) {
    return; // la red hace su trabajo, sin intermediarios
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const guardado = await cache.match(request);
        if (guardado) {
          // Se sirve la copia y se refresca por detrás (si falla, no pasa nada).
          event.waitUntil(
            fetch(request)
              .then((respuesta) =>
                respuesta && respuesta.ok ? cache.put(request, respuesta.clone()) : null
              )
              .catch(() => null)
          );
          return guardado;
        }
        const respuesta = await fetch(request);
        if (respuesta && respuesta.ok) cache.put(request, respuesta.clone());
        return respuesta;
      })()
    );
    return;
  }

  // Lo que queda son recursos propios que no son páginas ni datos: red directa.
  // (Las navegaciones ya han salido arriba sin tocarse.)
});
