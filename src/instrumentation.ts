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
 *   1. **Ni un solo import de Node.** Este fichero lo compila Next también para el
 *      navegador: con `import('node:fs')` el compilador revienta
 *      («UnhandledSchemeError») y con `import('fs')` deja avisos de módulo no
 *      encontrado. Los módulos se piden al runtime de Node en marcha
 *      (`process.getBuiltinModule`), así que el compilador no los ve siquiera.
 *   2. **No puede reventar ni guardar nada tuyo.** Es el último sitio al que llega
 *      un error: si el registro falla, se traga el fallo. Se escribe el tipo de
 *      error, su mensaje (recortado) y la ruta; nunca el cuerpo de la petición, ni
 *      cabeceras, ni la clave de Moodle, ni la de la IA.
 */

const LOG_DIR = 'data/logs';
const LOG_FILE = 'errores-app.log';
/** Para que un error enorme no deje el log ilegible. */
const MAX_MESSAGE = 300;
/** Tope del fichero: si crece demasiado, se empieza de cero (es un rastro, no un archivo). */
const MAX_BYTES = 512 * 1024;

type NodeFs = typeof import('fs');
type NodePath = typeof import('path');

/**
 * Un módulo del runtime de Node, pedido directamente al proceso.
 *
 * Devuelve `null` si ese runtime no los tiene (por ejemplo, en el borde): en ese
 * caso el registro no se hace y ya está — el vigilante sigue viendo las caídas
 * desde fuera, que es la red que nunca falta.
 */
function nodeModule<T>(name: string): T | null {
  const get = (process as unknown as { getBuiltinModule?: (moduleName: string) => unknown })
    .getBuiltinModule;
  if (typeof get !== 'function') return null;

  try {
    return (get(name) as T) ?? null;
  } catch {
    return null;
  }
}

function safeText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : '';
  return text.replace(/\s+/g, ' ').slice(0, max);
}

export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context: { routePath?: string; routeType?: string; renderSource?: string }
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const fs = nodeModule<NodeFs>('fs');
    const path = nodeModule<NodePath>('path');
    if (!fs || !path) return;

    const root = (process.env.BRAINUP_ROOT ?? '').trim() || process.cwd();
    const dir = path.join(root, LOG_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOG_FILE);

    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.rmSync(file, { force: true });
    } catch {
      // Si el fichero no existe, no hay nada que vaciar.
    }

    const detail =
      error instanceof Error
        ? `${error.name}: ${safeText(error.message, MAX_MESSAGE)}`
        : safeText(String(error), MAX_MESSAGE);
    const where = safeText(context?.routePath ?? request?.path ?? '', 160) || '(sin ruta)';
    const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${safeText(
      request?.method ?? 'GET',
      10
    )} ${where} · ${detail}\n`;

    fs.appendFileSync(file, line, 'utf8');
  } catch {
    // El registro nunca puede ser la causa de otro fallo.
  }
}
