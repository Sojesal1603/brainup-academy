/**
 * Levantar y reiniciar la app desde dentro.
 *
 * Esto es lo que hace que un fallo de funcionamiento se pueda **arreglar solo**:
 * si el servidor no responde se levanta, y si está en un bucle de caídas se
 * reinicia limpio. Son las dos únicas acciones de este módulo, y ninguna toca la
 * base de datos: reiniciar la app no puede perder nada de lo tuyo.
 *
 * La regla que se respeta siempre: **el servidor vigilado manda**. Si está en
 * marcha (`scripts/sirve.js`), es él quien levanta la app, así que aquí solo se le
 * deja hacer su trabajo (como mucho se cierra el proceso de Next para que lo
 * vuelva a levantar). Nunca se mata al vigilante: matarlo es quedarse sin red.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logsDirectory, projectRoot } from './operationalData';

export interface ServerControlResult {
  /** ¿Ha hecho algo de verdad? (`false` también es un resultado válido). */
  acted: boolean;
  /** Qué ha pasado, en una frase, para el log y para el taller. */
  detail: string;
}

/** Cuánto se espera a que la app responda después de tocarla. */
const WAIT_MS = 25_000;
const POLL_MS = 1_000;

function port(): number {
  const raw = Number(process.env.PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : 3000;
}

function healthUrl(): string {
  return `http://127.0.0.1:${port()}/api/salud`;
}

/**
 * Deja escrito en el diario que esta parada la hemos pedido nosotros.
 *
 * Sin esta línea, el reinicio del mantenimiento se leería como una caída nueva y
 * el sistema se reiniciaría a sí mismo en bucle (cada arreglo parecería un
 * problema). Además queda a la vista: nada de lo que hace solo se hace a escondidas.
 */
function markIntentionalRestart(reason: string): void {
  try {
    fs.appendFileSync(
      path.join(logsDirectory(), 'servidor.log'),
      `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] reinicio pedido por el mantenimiento: ${reason}\n`,
      'utf8'
    );
  } catch {
    // Si no se puede escribir, el reinicio sigue adelante: es peor no arreglarlo.
  }
}

function readPid(fileName: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(logsDirectory(), fileName), 'utf8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** ¿Responde la app al parte de salud? */
export async function appResponds(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl(), {
      signal: AbortSignal.timeout(5000),
      headers: { 'Cache-Control': 'no-store' },
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function waitUntilResponding(): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await appResponds()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}

/**
 * Arranca el servidor vigilado si no está en marcha. Si ya lo está, no hace nada:
 * meter otro vigilante sería pelearse por el mismo puerto.
 */
export async function startWatchedServer(): Promise<ServerControlResult> {
  const watchdog = readPid('sirve.pid');
  if (isAlive(watchdog)) {
    return {
      acted: false,
      detail: `el servidor vigilado ya está en marcha (PID ${watchdog}): la app vuelve sola`,
    };
  }

  const root = projectRoot();
  const script = path.join(root, 'scripts', 'sirve.js');
  if (!fs.existsSync(script)) {
    return { acted: false, detail: `no encuentro scripts/sirve.js en ${root}: no puedo levantar la app desde aquí` };
  }

  // Su salida va al mismo diario que la del vigilante: así el arreglo queda escrito.
  let out: number | 'ignore' = 'ignore';
  try {
    out = fs.openSync(path.join(logsDirectory(), 'servidor.log'), 'a');
  } catch {
    out = 'ignore';
  }

  try {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, PORT: String(port()) },
    });
    child.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { acted: false, detail: `no se ha podido arrancar el servidor vigilado: ${message}` };
  }

  const ok = await waitUntilResponding();
  return {
    acted: true,
    detail: ok
      ? 'app levantada: vuelve a responder'
      : `se ha arrancado el servidor vigilado, pero la app aún no responde (mirar data/logs/servidor.log)`,
  };
}

/**
 * Reinicia la app: cierra el proceso del servidor y deja que el vigilante lo
 * levante limpio. Si el vigilante no estuviera en marcha, lo levanta.
 */
export async function restartAppServer(): Promise<ServerControlResult> {
  const server = readPid('servidor.pid');
  const watchdog = readPid('sirve.pid');

  if (!isAlive(server)) {
    if (isAlive(watchdog)) {
      return { acted: false, detail: `el proceso de la app no estaba vivo; el vigilante (PID ${watchdog}) lo está levantando` };
    }
    return startWatchedServer();
  }

  markIntentionalRestart(`cerrando el proceso ${server} para que arranque limpio`);

  try {
    process.kill(server as number, 'SIGTERM');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { acted: false, detail: `no se ha podido cerrar el proceso ${server}: ${message}` };
  }

  // El vigilante reinicia en ~2 s; se espera a que la app conteste de nuevo.
  const ok = await waitUntilResponding();
  return {
    acted: true,
    detail: ok
      ? `app reiniciada (proceso ${server} cerrado y vuelto a levantar)`
      : `se ha cerrado el proceso ${server} pero la app aún no responde: mirar data/logs/servidor.log`,
  };
}
