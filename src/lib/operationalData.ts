/**
 * Leer los rastros del sistema desde el disco.
 *
 * El motor de comprobaciones es puro (`operationalTrace.ts`); esto es solo la
 * parte que toca el disco: leer la cola de los logs y devolver el texto. Está
 * aparte porque lo usan los dos lados (la página del taller y el vigilante) y
 * porque así el motor se puede probar con un log de mentira.
 *
 * Dos cuidados que importan:
 *
 *   - **Solo la cola.** Un log de meses puede pesar megas; se leen los últimos
 *     kilobytes, que es donde está lo que acaba de pasar.
 *   - **Nunca lanza.** Que no haya log (o no se pueda leer) no es un fallo del
 *     sistema: el motor lo trata como «no hay noticias» y sigue.
 */

import fs from 'fs';
import path from 'path';
import { buildTrace, type OperationalTrace } from './operationalTrace';

/** Cuánto se lee del final de cada log. */
const MAX_TAIL_BYTES = 200_000;

/** La raíz del proyecto: donde vive `data/logs`. */
export function projectRoot(): string {
  const configured = (process.env.BRAINUP_ROOT ?? '').trim();
  return configured.length > 0 ? configured : process.cwd();
}

export function logsDirectory(): string {
  return path.join(projectRoot(), 'data', 'logs');
}

/** La cola de un fichero de texto, o `null` si no existe o no se puede leer. */
export function readLogTail(fileName: string): string | null {
  const file = path.join(logsDirectory(), fileName);

  try {
    const stats = fs.statSync(file);
    if (!stats.isFile() || stats.size === 0) return null;

    const start = Math.max(0, stats.size - MAX_TAIL_BYTES);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(file, 'r');
    try {
      fs.readSync(handle, buffer, 0, length, start);
    } finally {
      fs.closeSync(handle);
    }

    // Si se ha cortado por la mitad de una línea, esa primera línea se descarta:
    // media línea suelta solo puede confundir al parser.
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  }
}

/**
 * El rastro de funcionamiento tal y como está el sistema ahora mismo.
 *
 * `health` se deja a `null` a propósito: quien sepa de verdad si la app responde
 * (el vigilante, desde fuera) es quien lo rellena. La página del taller no lo
 * necesita: si la estás viendo, la app está respondiendo.
 */
export async function loadOperationalTrace(now: Date = new Date()): Promise<OperationalTrace> {
  return buildTrace({
    serverLog: readLogTail('servidor.log'),
    vigilanteLog: readLogTail('vigilante.log'),
    appLog: readLogTail('errores-app.log'),
    now,
  });
}
