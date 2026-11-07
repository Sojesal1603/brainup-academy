/**
 * Sirve la app y no la deja caer.
 *
 * El problema que resuelve: `npm run dev` es un proceso normal, y un proceso
 * normal se muere (se cierra la terminal, alguien lo mata para tocar la base, un
 * recompilado se atasca). Cuando se muere, el navegador suelta justo eso:
 *
 *     No se puede acceder a este sitio web
 *     Es posible que la página web http://localhost:3000/ esté temporalmente inactiva…
 *     ERR_FAILED
 *
 * Este vigilante arranca Next, **escucha lo que le pasa** y lo vuelve a levantar
 * solo, sin que nadie se lo pida:
 *
 *   - Si el proceso termina (caída, Ctrl+C en otra ventana, kill para regenerar
 *     Prisma), lo reinicia en 2 segundos.
 *   - Si el proceso sigue vivo pero la app no responde al endpoint de salud
 *     (`/api/salud`) tres veces seguidas, lo reinicia: un servidor zombi es peor
 *     que uno caído, porque el puerto está cogido y no contesta.
 *   - Deja todo escrito en `data/logs/servidor.log` y su PID en
 *     `data/logs/sirve.pid`, para poder pararlo sin buscarlo a ciegas.
 *
 * Uso:
 *   npm run sirve                 → arranca la app vigilada Y el mantenimiento
 *   npm run sirve -- --stop       → para los dos
 *   npm run sirve -- --status     → dice si está vivo y quién escucha en el puerto
 *   npm run sirve -- --abrir      → además abre el navegador en cuanto responde
 *   npm run sirve -- --sin-vigilante → arranca solo el servidor
 *
 * Además, al arrancar levanta el vigilante de mantenimiento (`scripts/vigilante.js`)
 * si no está ya en marcha: son las dos mitades de lo mismo. Uno mantiene la app en
 * pie (esto), el otro mantiene el sistema sano (revisa, repara y anota lo que no
 * puede arreglar solo). Un solo comando y no hay que acordarse de nada más.
 */
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { direccionesLocales, urlMovil } = require('./red-local');

const projectRoot = path.join(__dirname, '..');
const logDir = path.join(projectRoot, 'data', 'logs');
const logPath = path.join(logDir, 'servidor.log');
const pidPath = path.join(logDir, 'sirve.pid');
// El PID del servidor de Next también se guarda: al parar hay que matar a los
// dos, o el hijo se queda con el puerto cogido y el vigilante "parado".
const childPidPath = path.join(logDir, 'servidor.pid');
// El vigilante de mantenimiento comparte carpeta y PID: al parar hay que pararlo a
// él también, o volvería a levantar el servidor cinco minutos después.
const vigilantePidPath = path.join(logDir, 'vigilante.pid');
// Cerrojo de arranque: si dos cosas piden arrancar a la vez (la tarea de Windows y
// el icono, o dos latidos solapados), solo una levanta Next. Sin él, las dos ven el
// puerto libre, las dos arrancan y se pelean por el mismo `.next`: la app se queda
// a medias y el navegador da ERR_FAILED.
const lockPath = path.join(logDir, 'arranque.lock');
// Diario corto del arranque automático: una línea por latido. Sirve para ver que
// el latido late de verdad sin llenar `servidor.log` (que es el diario técnico).
const latidoPath = path.join(logDir, 'latido.log');
const vigilanteLogPath = path.join(logDir, 'vigilante.log');
// Ojo con `process.env.PORT`: puede venir definido y vacío (o con basura) y
// `Number('')` es 0, que Next interpreta como «un puerto libre al azar». Se
// valida antes de usarlo o la salud apuntaría a un sitio distinto.
const rawPort = Number(process.env.PORT);
const PORT = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000;
// Por dónde se escucha. `0.0.0.0` es «todas las conexiones de este ordenador», que
// es lo que permite abrirlo desde el móvil en la misma Wi-Fi (Next lo usa por
// defecto, pero aquí se dice explícito: de esto depende que el móvil llegue). Con
// `BRAINUP_HOST=127.0.0.1` en `.env`, la app vuelve a ser solo de este PC.
const HOST = (process.env.BRAINUP_HOST || '0.0.0.0').trim() || '0.0.0.0';
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/salud`;

/** Cada cuánto se pregunta si la app sigue respondiendo. */
const HEALTH_INTERVAL_MS = 20000;
/** Fallos de salud seguidos antes de reiniciar. */
const HEALTH_FAILURES_BEFORE_RESTART = 3;
/** Espera antes de levantar otra vez el servidor caído. */
const RESTART_DELAY_MS = 2000;
/** Tope de reinicios en 10 minutos; pasado eso, se espacian para no dar la lata. */
const MAX_FAST_RESTARTS = 8;

fs.mkdirSync(logDir, { recursive: true });

function anotaLatido(texto) {
  try {
    const sello = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(latidoPath, `[${sello}] ${texto}\n`);
  } catch {}
}

/**
 * Windows (y algunos antivirus) pueden dejar la tarea de arranque deshabilitada
 * sin avisar. La app se la vuelve a habilitar cada vez que arranca: si algún día
 * la desactivan, el simple hecho de abrirla deja el arranque automático reparado.
 */
function rehabilitaArranque() {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('schtasks', ['/change', '/tn', 'BrainUp Academy', '/enable'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 8000,
    });
  } catch {}
}

function log(line) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = `[${stamp}] ${line}\n`;

  // Se escribe en la ventana solo si hay una ventana. Cuando lo levanta el
  // vigilante, su salida ya va a este mismo fichero: sin esta guarda, cada línea
  // saldría dos veces en el diario.
  if (process.stdout.isTTY) process.stdout.write(text);

  try {
    fs.appendFileSync(logPath, text);
  } catch {
    // Si no se puede escribir el log, no se cae el servidor por eso.
  }
}

/** Fichero de PID: poder pararlo sin adivinar qué proceso es. */
function readPidFrom(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

function readPid() {
  return readPidFrom(pidPath);
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

/**
 * ¿Ese PID es de verdad un Node, o el número se ha reciclado?
 *
 * Windows reutiliza números de proceso. El 28 de octubre los ficheros de PID
 * quedaron de un árbol de procesos que ya no existía; si uno de esos números
 * hubiera caído en otro programa, el servidor se creería «ya en marcha» y no
 * arrancaría nunca — el fallo mudo perfecto. `tasklist` dice el nombre del proceso
 * y cuesta milisegundos. Si `tasklist` no estuviera, se confía en el PID, como antes.
 */
function esNodeVivo(pid) {
  if (!isAlive(pid)) return false;
  if (process.platform !== 'win32') return true;
  try {
    const salida = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
    });
    return /node\.exe/i.test(salida);
  } catch {
    return true;
  }
}

/** Argumentos de línea de comandos. */
const args = process.argv.slice(2);

if (args.includes('--stop')) {
  const pids = [readPid(), readPidFrom(childPidPath)].filter((pid) => pid && esNodeVivo(pid));

  if (pids.length === 0) {
    console.log('No hay ningún servidor vigilado en marcha.');
    for (const file of [pidPath, childPidPath]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
    process.exit(0);
  }

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Parado el proceso ${pid}.`);
    } catch (error) {
      console.error(`No se ha podido parar el PID ${pid}:`, error.message);
    }
  }

  // Y se para el vigilante de mantenimiento: si siguiera vivo, en cinco minutos
  // volvería a levantar el servidor que acabas de parar.
  const vigilantePid = readPidFrom(vigilantePidPath);
  if (vigilantePid && esNodeVivo(vigilantePid)) {
    try {
      process.kill(vigilantePid, 'SIGTERM');
      console.log(`Parado también el vigilante de mantenimiento (PID ${vigilantePid}).`);
    } catch (error) {
      console.error(`No se ha podido parar el vigilante (PID ${vigilantePid}):`, error.message);
    }
  }

  for (const file of [pidPath, childPidPath, vigilantePidPath]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
  process.exit(0);
}

if (args.includes('--status')) {
  const pid = readPid();
  console.log(`PID vigilado: ${pid ?? 'ninguno'} ${pid && isAlive(pid) ? '(vivo)' : '(no responde)'}`);
  fetch(HEALTH_URL)
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      console.log(`Salud: HTTP ${res.status} · ok=${body.ok} · base=${body.database?.ok}`);
      process.exit(0);
    })
    .catch(() => {
      console.log('Salud: la app no responde.');
      process.exit(1);
    });
  // `--status` termina cuando responda la petición de arriba.
  return;
}

let lockTaken = false;

function soltarCerrojo() {
  if (!lockTaken) return;
  lockTaken = false;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {}
}

/**
 * Toma el cerrojo, o dice que no. Se crea con `wx`: el sistema garantiza que solo
 * un proceso gana. Si el dueño anterior murió (cierre a lo bruto), su PID ya no
 * existe y el cerrojo se limpia: nunca queda la app bloqueada para siempre.
 */
function tomarCerrojo() {
  for (let intento = 0; intento < 2; intento += 1) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', flag: 'wx' });
      lockTaken = true;
      return true;
    } catch {
      const dueno = readPidFrom(lockPath);
      if (dueno && esNodeVivo(dueno)) return false;
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {}
    }
  }
  return false;
}

if (!tomarCerrojo()) {
  console.log('Ya se está arrancando la app en otro proceso; este no hace nada.');
  process.exit(0);
}
process.on('exit', soltarCerrojo);

rehabilitaArranque();

// Si hay una compilación en marcha (el build deja su cerrojo), este latido no
// arranca nada: un servidor en desarrollo escribe en la misma carpeta de salida
// que el build y lo deja a medias (ENOENT pages-manifest). El siguiente latido,
// cinco minutos después, ya la encuentra libre.
const buildLock = path.join(logDir, "build.lock");
if (fs.existsSync(buildLock)) {
  anotaLatido("compilación en marcha: no arranco el servidor");
  console.log("Hay una compilación en marcha; no se arranca la app todavía.");
  process.exit(0);
}

// Evitar dos vigilantes peleándose por el mismo puerto.
//
// Dos puertas, porque aquí se juega que no haya dos Next sobre el mismo `.next`
// (se pelean y la app se queda a medias): primero el PID, que es gratis, y si el
// PID no está —o su fichero se perdió— se le pregunta a la app. Si alguien
// responde en el puerto, ya hay servidor y no se abre otro. Esta segunda puerta es
// también la que hace que el latido de Windows pueda ser simplemente «ejecuta
// sirve.js»: si la app está en pie, este proceso termina en el acto.
const existing = readPid();
if (existing && esNodeVivo(existing)) {
  // Se apunta el latido también por esta puerta: es la que se toma cuando el
  // servidor ya está vivo, que es el caso normal de cada tick de los 5 minutos.
  anotaLatido(`ya en pie (PID ${existing}): no hay nada que arrancar`);
  console.log(`Ya hay un servidor vigilado en marcha (PID ${existing}).`);
  console.log('Si quieres reiniciarlo: npm run sirve -- --stop');
  process.exit(0);
}

/** Con `--abrir`, se abre el navegador en cuanto la app responda. */
const abrirAlEstar = args.includes('--abrir');

const timeoutSalud = AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined;

fetch(HEALTH_URL, timeoutSalud ? { signal: timeoutSalud } : {})
  .then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) {
      anotaLatido('ya en pie: no hay nada que arrancar');
      console.log(`Ya hay una app respondiendo en el puerto ${PORT} (http://localhost:${PORT}).`);
      console.log('No se abre una segunda copia. Para reiniciarla: npm run sirve -- --stop');
      // Si se ha abierto con «Arranca BrainUp.cmd», la app ya estaba en pie: se
      // abre el navegador igual, que es lo que el doble clic promete.
      if (abrirAlEstar) abrirNavegador();
      process.exit(0);
    }
    arranque();
  })
  .catch(() => arranque());

let child = null;
let stopping = false;
let restarts = [];
let healthFailures = 0;
let healthTimer = null;

/** Next arrancado directamente: un proceso menos que matar cuando toque. */
function nextBin() {
  return path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
}

/**
 * Carpeta de salida de Next, leída de la propia configuración.
 *
 * Por defecto es `.next`, la misma carpeta que usa el build. Si la configuración
 * cambiara `distDir` y aquí se asumiera `.next`, el vigilante no encontraría el
 * BUILD_ID y arrancaría en desarrollo teniendo la compilación hecha.
 */
function distDir() {
  try {
    const config = require(path.join(projectRoot, 'next.config.js'));
    const dir = String(config?.distDir ?? '').trim();
    if (dir) return dir;
  } catch {
    // Sin configuración legible, se usa el valor por defecto de Next.
  }
  return (process.env.BRAINUP_DIST_DIR || '.next').trim() || '.next';
}

function startServer() {
  const command = process.execPath;

  // Si hay una compilación de producción (`.next/BUILD_ID`), se sirve esa: las
  // páginas salen ya hechas, sin compilar al vuelo. En desarrollo, Next compila
  // cada ruta la primera vez (800+ módulos, varios segundos) y, mientras tanto,
  // el navegador puede dar la página por caída («ERR_FAILED»). Para seguir
  // tocando código se arranca en desarrollo con `npm run dev` (o borrando
  // `.next`); para servir el día a día, producción.
  const productionBuild = path.join(projectRoot, distDir(), 'BUILD_ID');
  const production = fs.existsSync(productionBuild);
  const childArgs = production
    ? [nextBin(), 'start', '-p', String(PORT), '-H', HOST]
    : [nextBin(), 'dev', '-p', String(PORT), '-H', HOST];

  log(
    `arrancando: node next ${production ? 'start (producción)' : 'dev (desarrollo)'} -p ${PORT} -H ${HOST}`
  );

  const out = fs.openSync(logPath, 'a');
  child = spawn(command, childArgs, {
    cwd: projectRoot,
    stdio: ['ignore', out, out],
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  if (child.pid) {
    try {
      fs.writeFileSync(childPidPath, String(child.pid), 'utf8');
    } catch {}
  }

  child.on('exit', (code, signal) => {
    try {
      fs.rmSync(childPidPath, { force: true });
    } catch {}
    if (stopping) return;
    log(`el servidor ha terminado (código ${code ?? 'null'}, señal ${signal ?? '-'}). Se reinicia.`);

    const now = Date.now();
    restarts = restarts.filter((at) => now - at < 10 * 60 * 1000);
    const delay = restarts.length >= MAX_FAST_RESTARTS ? 30000 : RESTART_DELAY_MS;
    restarts.push(now);

    if (restarts.length >= MAX_FAST_RESTARTS) {
      log('muchas caídas seguidas: se espacian los reinicios a 30 s. Revisa data/logs/servidor.log.');
    }

    setTimeout(() => {
      if (!stopping) startServer();
    }, delay);
  });

  child.on('error', (error) => {
    log(`no se ha podido arrancar el servidor: ${error.message}`);
  });

  healthFailures = 0;
}

/**
 * Pregunta de salud. Solo se reinicia el proceso cuando NO CONTESTA.
 *
 * Un 200 con `ok: false` significa «la app está en pie, la base de datos no»:
 * reiniciar el servidor no arregla la base y sí parte en dos el turno de IA que
 * esté en vuelo, que es exactamente lo que el navegador enseña como «Failed to
 * fetch». Por eso aquí se mira el HTTP, no el estado de la base.
 */
function checkHealth() {
  if (stopping || !child) return;

  const timeout = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;

  fetch(HEALTH_URL, timeout ? { signal: timeout } : {})
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (res.status === 200) {
        if (healthFailures > 0) log('la app vuelve a responder con normalidad.');
        if (body && body.ok === false) {
          log('salud: la app responde, pero la base no (no se reinicia por eso).');
        }
        healthFailures = 0;
        return;
      }
      healthFailures += 1;
      log(`salud: HTTP ${res.status} (${healthFailures}/${HEALTH_FAILURES_BEFORE_RESTART})`);
      maybeRestartForHealth();
    })
    .catch(() => {
      healthFailures += 1;
      log(`salud: sin respuesta (${healthFailures}/${HEALTH_FAILURES_BEFORE_RESTART})`);
      maybeRestartForHealth();
    });
}

/** Evita que dos comprobaciones finales se pisen. */
let confirmandoReinicio = false;

/**
 * Matar el servidor es el último recurso, y antes se le da una última
 * oportunidad con más margen: un turno de IA puede tardar 30 s y no por eso
 * está muerto. El proceso se lleva por delante la petición HTTP en curso y el
 * alumno ve «Failed to fetch».
 */
async function maybeRestartForHealth() {
  if (healthFailures < HEALTH_FAILURES_BEFORE_RESTART || confirmandoReinicio) return;
  confirmandoReinicio = true;

  try {
    const sigueVivo = await new Promise((resolve) => {
      const timeout = AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined;
      fetch(HEALTH_URL, timeout ? { signal: timeout } : {})
        .then((res) => resolve(res.status === 200))
        .catch(() => resolve(false));
    });

    if (sigueVivo) {
      healthFailures = 0;
      log('la app ha contestado a la comprobación final: no se reinicia.');
      return;
    }

    log('la app lleva tres comprobaciones sin responder: se reinicia el servidor para desatascarlo.');
    healthFailures = 0;

    if (child) {
      const doomed = child;
      child = null;
      try {
        doomed.kill();
      } catch {}
      // Si en 10 segundos no ha muerto, se fuerza.
      setTimeout(() => {
        try {
          process.kill(doomed.pid, 'SIGKILL');
        } catch {}
      }, 10000);
    }
  } finally {
    confirmandoReinicio = false;
  }
}

function shutdown(signal) {
  stopping = true;
  log(`parando (${signal})…`);
  soltarCerrojo();
  if (healthTimer) clearInterval(healthTimer);
  if (child) {
    try {
      child.kill();
    } catch {}
  }
  for (const file of [pidPath, childPidPath]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));


/**
 * Levanta el vigilante de mantenimiento, si no está ya vivo.
 *
 * Se espera unos segundos a que Next arranque: los dos compilan al empezar y no
 * tiene sentido pelearse por el disco. Si el vigilante ya está en marcha (o si se
 * ha pedido `--sin-vigilante`), no se toca nada.
 */
function arrancaVigilante() {
  if (args.includes('--sin-vigilante')) {
    log('vigilante de mantenimiento: no arrancado (--sin-vigilante)');
    return;
  }

  const vivo = readPidFrom(vigilantePidPath);
  if (vivo && isAlive(vivo)) {
    log(`vigilante de mantenimiento ya en marcha (PID ${vivo})`);
    return;
  }

  try {
    const out = fs.openSync(vigilanteLogPath, 'a');
    const vigilante = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'vigilante.js')], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    });
    vigilante.unref();
    log('vigilante de mantenimiento arrancado: revisa, repara y apunta fallos solo (log: data/logs/vigilante.log).');
  } catch (error) {
    log(`no se ha podido arrancar el vigilante de mantenimiento: ${error.message}`);
  }
}

/** Abre la app en el navegador de siempre. */
function abrirNavegador() {
  console.log(`Abriendo http://localhost:${PORT} en el navegador…`);
  try {
    spawn('cmd.exe', ['/c', 'start', '', `http://localhost:${PORT}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {
    // Si no se puede abrir el navegador, la app sigue en pie y la dirección está
    // en pantalla: no es motivo para nada más.
  }
}

/**
 * Abre el navegador en cuanto la app responda (solo con `--abrir`).
 *
 * Se espera a que responda de verdad, no a un número fijo de segundos: la primera
 * vez Next compila cada ruta y tarda; abrir el navegador antes de tiempo enseña
 * justo el error que este proyecto existe para no volver a ver.
 */
function abrirCuandoResponda(topeMs = 180000) {
  if (!abrirAlEstar) return;
  const fin = Date.now() + topeMs;

  const intento = () => {
    const timeout = AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined;
    fetch(HEALTH_URL, timeout ? { signal: timeout } : {})
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          abrirNavegador();
          return;
        }
        if (Date.now() < fin) setTimeout(intento, 2000);
      })
      .catch(() => {
        if (Date.now() < fin) setTimeout(intento, 2000);
      });
  };

  setTimeout(intento, 1500);
}

/**
 * El arranque de verdad. Se llama solo cuando ya se sabe que el puerto está libre
 * (lo de arriba), que es lo que garantiza que no haya dos servidores a la vez.
 */
function arranque() {
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  anotaLatido('arrancando el servidor');

  console.log('');
  console.log('  BrainUp Academy · servidor vigilado');
  console.log('  ──────────────────────────────────');
  console.log(`  App:      http://localhost:${PORT}`);
  console.log(`  Salud:    http://localhost:${PORT}/api/salud`);
  // La dirección del móvil, preguntada al sistema ahora mismo: el router la cambia
  // de un día para otro (y con ella el rango de la red), así que la última que se vio
  // no sirve. Se enseña la conexión de verdad que haya; si solo hay VPN, esa.
  const redes = direccionesLocales();
  const casa = redes.find((red) => !red.virtual) || redes[0];
  console.log(
    casa
      ? `  Móvil:    ${urlMovil(casa.direccion, PORT)}   (${casa.nombre}, misma Wi-Fi)`
      : '  Móvil:    ahora mismo este ordenador no está en ninguna red'
  );
  console.log(`  Log:      data/logs/servidor.log`);
  console.log('');
  console.log('  Si el servidor se cae, se vuelve a levantar solo.');
  console.log('  Para pararlo: npm run sirve -- --stop');
  console.log('');

  log(`vigilante iniciado (PID ${process.pid})`);

  startServer();
  healthTimer = setInterval(checkHealth, HEALTH_INTERVAL_MS);
  setTimeout(arrancaVigilante, 8000);
  abrirCuandoResponda();
}
