/**
 * El registro de errores de la propia app.
 *
 * Aquí está el agujero que hacía que tuvieras que avisar tú: una excepción dentro
 * de una página o de una acción del servidor se quedaba en la consola del proceso
 * y **desaparecía**. Nadie la contaba, así que nadie la arreglaba.
 *
 * Next llama a `onRequestError` cada vez que una petición revienta por un error no
 * capturado. Con esto, cada uno se escribe con su hora, su ruta y su mensaje en
 * `data/logs/errores-app.log`, y el motor de mantenimiento lee ese fichero igual
 * que lee los demás rastros: si un error se repite, sale como hallazgo en el
 * taller y se abre una incidencia sola.
 *
 * DOS COSAS QUE HAY QUE RESPETAR AQUÍ (las dos se aprendieron a golpes):
 *
 *   1. **Ni una sola API de Node en este archivo.** Next compila
 *      `instrumentation.ts` también para el Edge Runtime y avisa en la terminal
 *      de cualquier referencia estática a `process.cwd()`, `fs` o `path`
 *      («A Node.js API is used … which is not supported in the Edge Runtime»),
 *      aunque el código nunca llegue a ejecutarse allí. Todo lo que toca disco
 *      vive en `instrumentation-node.ts` y se carga con `import()` **detrás**
 *      de la comprobación de runtime: así Next no lo mete en el bundle de Edge.
 *   2. **No puede reventar ni guardar nada tuyo.** Es el último sitio al que llega
 *      un error: si el registro falla, se traga el fallo. Se escribe el tipo de
 *      error, su mensaje (recortado) y la ruta; nunca el cuerpo de la petición, ni
 *      cabeceras, ni la clave de Moodle, ni la de la IA.
 */

interface ErrorRequestInfo {
  path?: string;
  method?: string;
}

interface ErrorRequestContext {
  routePath?: string;
  routeType?: string;
  renderSource?: string;
}

export async function onRequestError(
  error: unknown,
  request: ErrorRequestInfo,
  context: ErrorRequestContext
): Promise<void> {
  // Edge (y cualquier runtime que no sea Node) no tiene disco que escribir.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    // Import dinámico y DESPUÉS del guard: es el patrón que documenta Next para
    // mantener las librerías de Node fuera del bundle de Edge.
    const { logRequestError } = await import('./instrumentation-node');
    await logRequestError(error, request, context);
  } catch {
    // El registro nunca puede ser la causa de otro fallo.
  }
}
