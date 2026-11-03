/**
 * El vigilante: el que mantiene el sistema cuando no hay nadie delante.
 *
 * Hace tres cosas, en este orden, cada ronda:
 *
 *   1. **Comprueba que la app está en pie** (`/api/salud`, que toca la base de
 *      verdad, no solo el puerto). Si no contesta y no hay ningún servidor
 *      vigilado en marcha, lo levanta él (`scripts/sirve.js`): eso es lo que
 *      corta el «No se puede acceder a este sitio web · ERR_FAILED».
 *   2. **Repasa el sistema** con el motor de mantenimiento y aplica **los
 *      arreglos seguros** (renombrar, renumerar, acotar rangos, quitar una
 *      unidad repetida que está vacía). Lo que borraría datos con valor no se
 *      toca nunca solo.
 *   3. **Pide ayuda a la IA** solo para lo que las reglas no cubren, en un
 *      vocabulario cerrado de operaciones que se validan una a una. Y deja
 *      apuntado como incidencia lo que siga mal, cerrando las que ya no se
 *      detectan.
 *
 * Todo queda en `data/logs/vigilante.log` y la última ronda en
 * `data/logs/vigilante-ultimo.json`.
 *
 * Uso:
 *   npm run vigilante                → rondas cada 5 minutos (deja la ventana abierta)
 *   npm run vigilante -- --once      → una ronda y se va
 *   npm run vigilante -- --dry       → mirar y contar, sin tocar nada
 *   npm run vigilante -- --status    → qué dijo la última ronda
 *   npm run vigilante -- --stop      → pararlo
 *   npm run vigilante -- --every=60000   → cambiar el ritmo (en milisegundos)
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { compilaTs, projectRoot } = require('./lib/compilaTs');

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const DRY = args.includes('--dry');
const EVERY_ARG = args.find((arg) => arg.startsWith('--every='));
const SERVER_URL = process.env.APP_URL || 'http://127.0.0.1:3000';

/** Cada cuánto se hace una ronda. Cinco minutos es «estar pendiente» sin dar la lata. */
const EVERY_MS = Number(EVERY_ARG ? EVERY_ARG.split('=')[1] : process.env.VIGILANTE_EVERY_MS) || 5 * 60 * 1000;
/** No se intenta levantar la app más de una vez cada cinco minutos. */
const SERVER_GUARD_MIN_GAP_MS = 5 * 60 * 1000;
/** Ni más de seis veces por hora: si no arranca, el problema no es un reinicio. */
const SERVER_GUARD_MAX_PER_HOUR = 6;
/** Cuánto se espera a que la app recién levantada conteste. */
const SERVER_WAIT_MS = 45 * 1000;

const logDir = path.join(projectRoot, 'data', 'logs');
const logPath = path.join(logDir, 'vigilante.log');
const pidPath = path.join(logDir, 'vigilante.pid');
const snapshotPath = path.join(logDir, 'vigilante-ultimo.json');
const sirvePidPath = path.join(logDir, 'sirve.pid');

fs.mkdirSync(logDir, { recursive: true });

function log(line) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = `[${stamp}] ${line}\n`;

  // Si la salida se ve en una ventana, se escribe también ahí (es lo natural
  // cuando lo arrancas tú a mano). Si no —porque lo ha levantado `sirve` y su
  // salida ya va a este mismo fichero— solo se escribe una vez: si no, cada línea
  // acabaría duplicada en el diario.
  if (process.stdout.isTTY) process.stdout.write(text);

  try {
    fs.appendFileSync(logPath, text);
  } catch {
    // Si el log no se puede escribir, el vigilante sigue trabajando igual.
  }
}

function readPid(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* --stop y --status: poder pararlo y saber qué pasó, sin buscar a ciegas */
/* ------------------------------------------------------------------ */

if (args.includes('--stop')) {
  const pid = readPid(pidPath);
  if (pid && isAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Vigilante parado (PID ${pid}).`);
    } catch (error) {
      console.error(`No se ha podido parar el vigilante: ${error.message}`);
    }
  } else {
    console.log('No hay ningún vigilante en marcha.');
  }
  try {
    fs.rmSync(pidPath, { force: true });
  } catch {}
  process.exit(0);
}

if (args.includes('--status')) {
  const pid = readPid(pidPath);
  console.log(`Vigilante: ${pid ? `PID ${pid} ${isAlive(pid) ? '(vivo)' : '(no responde)'}` : 'parado'}`);
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const hace = Math.round((Date.now() - new Date(snapshot.finishedAt).getTime()) / 1000);
    console.log(`Última ronda: hace ${hace} s`);
    console.log(`Resumen: ${snapshot.headline}`);
    if (snapshot.health) console.log(`App: ${snapshot.health.ok ? 'OK' : 'con problemas'} · ${snapshot.health.detail}`);
    if (snapshot.findingsAfter) {
      for (const finding of snapshot.findingsAfter.slice(0, 12)) {
        console.log(`  · [${finding.severity}] ${finding.title} (×${finding.count})`);
      }
    }
    if (snapshot.issues && snapshot.issues.opened && snapshot.issues.opened.length > 0) {
      console.log(`Incidencias abiertas en la última ronda: ${snapshot.issues.opened.join(' | ')}`);
    }
  } catch {
    console.log('Todavía no hay ninguna ronda guardada.');
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* El código de la app, compilado para poder ejecutarlo aquí            */
/* ------------------------------------------------------------------ */

/**
 * Solo un vigilante a la vez.
 *
 * Dos rondas simultáneas no vigilan el doble: escriben lo mismo, se pisan los
 * ficheros temporales y confunden las incidencias. Si ya hay uno trabajando, este
 * se retira y lo dice (el que está ya hace el trabajo).
 */
if (!ONCE && !DRY) {
  const enMarcha = readPid(pidPath);
  if (enMarcha && enMarcha !== process.pid && isAlive(enMarcha)) {
    console.log(`Ya hay un vigilante en marcha (PID ${enMarcha}).`);
    console.log('Para reiniciarlo: npm run vigilante -- --stop');
    console.log('Para ver qué ha hecho: npm run vigilante -- --status');
    process.exit(0);
  }
}

let vigilante;
try {
  const outDir = compilaTs('vigilante.ts', '.tmp-vigilante');
  vigilante = require(path.join(outDir, 'vigilante.js'));
} catch (error) {
  log(`ERROR: ${error.message}`);
  log('El vigilante no puede trabajar si el código no compila. Arréglalo y vuelve a arrancarlo.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Que la app esté en pie (esto es lo que evita el ERR_FAILED)          */
/* ------------------------------------------------------------------ */

let lastServerAttemptAt = 0;
let serverAttempts = [];

/**
 * ¿Está la app en pie? Si no, se levanta el servidor vigilado.
 *
 * No se levanta a la ligera: si `scripts/sirve.js` ya está en marcha, es **él**
 * quien reinicia (escucha la caída del proceso de Next). Solo se arranca uno
 * nuevo cuando no hay ninguno vigilando, para no acabar con dos `next dev`
 * peleándose por el puerto 3000.
 */
async function ensureServer(health) {
  if (health.reachable) return { started: false, detail: 'la app ya responde' };

  const now = Date.now();
  serverAttempts = serverAttempts.filter((at) => now - at < 60 * 60 * 1000);

  const sirvePid = readPid(sirvePidPath);
  if (sirvePid && isAlive(sirvePid)) {
    return {
      started: false,
      detail: `la app no responde pero el servidor vigilado (PID ${sirvePid}) está en marcha: lo reiniciará él`,
    };
  }

  if (now - lastServerAttemptAt < SERVER_GUARD_MIN_GAP_MS) {
    return { started: false, detail: 'se ha intentado levantar hace poco: se espera antes de repetir' };
  }

  if (serverAttempts.length >= SERVER_GUARD_MAX_PER_HOUR) {
    return {
      started: false,
      detail: `se ha intentado levantar ${serverAttempts.length} veces en la última hora sin conseguirlo: mira data/logs/servidor.log`,
    };
  }

  lastServerAttemptAt = now;
  serverAttempts.push(now);

  log(`la app no responde (${health.detail}). Se levanta el servidor vigilado…`);

  try {
    const out = fs.openSync(path.join(logDir, 'servidor.log'), 'a');
    const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'sirve.js')], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, PORT: process.env.PORT || '3000' },
    });
    child.unref();
  } catch (error) {
    return { started: false, detail: `no se ha podido arrancar el servidor: ${error.message}` };
  }

  // Se espera a que conteste: «lo he arrancado» no es «está funcionando».
  const deadline = Date.now() + SERVER_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const check = await vigilante.checkHealth(SERVER_URL);
    if (check.ok) {
      log(`la app vuelve a estar en pie (${check.responseMs} ms).`);
      return { started: true, detail: 'levantada y respondiendo' };
    }
  }

  log('se ha arrancado el servidor pero la app sigue sin contestar: mira data/logs/servidor.log.');
  return { started: true, detail: 'arrancada, pero todavía no contesta' };
}

/* ------------------------------------------------------------------ */
/* Una ronda                                                            */
/* ------------------------------------------------------------------ */

let running = false;

async function round() {
  if (running) {
    log('la ronda anterior sigue en marcha: se salta esta.');
    return;
  }
  running = true;

  try {
    const health = await vigilante.checkHealth(SERVER_URL);
    const server = DRY ? { started: false, detail: 'simulación' } : await ensureServer(health);

    const report = await vigilante.runVigilanteCycle({
      serverUrl: SERVER_URL,
      dry: DRY,
      log,
    });

    report.server = server;
    report.headline = `${report.headline} · servidor: ${server.detail}`;

    for (const note of report.notes ?? []) log(`nota: ${note}`);
    for (const problem of report.problems ?? []) log(`aviso: ${problem}`);

    try {
      fs.writeFileSync(snapshotPath, JSON.stringify(report, null, 2), 'utf8');
    } catch (error) {
      log(`no se ha podido guardar el resumen de la ronda: ${error.message}`);
    }
  } catch (error) {
    log(`la ronda ha fallado: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
  }
}

/* ------------------------------------------------------------------ */
/* Arranque                                                             */
/* ------------------------------------------------------------------ */

process.on('SIGINT', () => {
  log('parando (SIGINT)…');
  try {
    fs.rmSync(pidPath, { force: true });
  } catch {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  log('parando (SIGTERM)…');
  try {
    fs.rmSync(pidPath, { force: true });
  } catch {}
  process.exit(0);
});

if (ONCE || DRY) {
  round().then(() => process.exit(0));
} else {
  // El PID se escribe cuando ya está comprobado que podemos trabajar (no antes:
  // un fichero de PID de un proceso que se cae engaña a quien venga después).
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');

  log(`vigilante arrancado (PID ${process.pid})${DRY ? ' en modo simulación' : ''}`);
  log(`ronda cada ${Math.round(EVERY_MS / 1000)} s · app: ${SERVER_URL} · log: data/logs/vigilante.log`);

  round();
  setInterval(round, EVERY_MS);
}
