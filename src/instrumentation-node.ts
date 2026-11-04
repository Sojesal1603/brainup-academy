/**
 * La parte del registro de errores que sí toca el disco.
 *
 * Vive en su propio archivo a propósito: `instrumentation.ts` se compila también
 * para el Edge Runtime, y allí `process.cwd()`, `fs` o `path` no existen. Lo carga
 * `instrumentation.ts` con un `import()` dinámico detrás de
 * `process.env.NEXT_RUNTIME === 'nodejs'`, así que el compilador de Edge ni
 * siquiera lo mira y la terminal queda limpia de avisos.
 *
 * Este módulo **solo se ejecuta en Node**, por eso aquí sí se pueden usar APIs de
 * Node. Aun así se piden al runtime con `process.getBuiltinModule` (igual que
 * antes) para que el compilador no tenga que resolverlas.
 */

const LOG_DIR = 'data/logs';
const LOG_FILE = 'errores-app.log';
/** Para que un error enorme no deje el log ilegible. */
const MAX_MESSAGE = 300;
/** Tope del fichero: si crece demasiado, se empieza de cero (es un rastro, no un archivo). */
const MAX_BYTES = 512 * 1024;

type NodeFs = typeof import('fs');
type NodePath = typeof import('path');

interface ErrorRequestInfo {
  path?: string;
  method?: string;
}

interface ErrorRequestContext {
  routePath?: string;
  routeType?: string;
  renderSource?: string;
}

/**
 * Un módulo del runtime de Node, pedido directamente al proceso.
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

export async function logRequestError(
  error: unknown,
  request: ErrorRequestInfo,
  context: ErrorRequestContext
): Promise<void> {
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
