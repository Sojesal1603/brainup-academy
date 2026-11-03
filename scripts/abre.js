/**
 * Abre BrainUp Academy. Es lo que hay detrás del icono, y no hay ningún CMD.
 *
 * Lo que hace, en orden:
 *   1. Pregunta a la app si ya está en pie (`/api/salud`). Si responde, abre el
 *      navegador y se va: menos de un segundo.
 *   2. Si no responde, pide a la tarea de Windows «BrainUp Academy» que la
 *      arranque. Esa tarea la levanta **sin ventana** y se queda con ella, así que
 *      este proceso no tiene que vivir para siempre (un icono no debe dejar una
 *      consola abierta toda la tarde).
 *   3. Espera a que responda de verdad —no a un número fijo de segundos— y
 *      entonces abre el navegador: nunca se enseña el «ERR_FAILED» por abrir
 *      antes de tiempo.
 *   4. Si en dos minutos y medio no ha respondido, abre una página local con lo
 *      último que dijo el servidor. Es mejor que la página de error del navegador:
 *      dice qué pasó y qué hacer, sin tecnicismos.
 *
 * `BRAINUP_NO_ABRIR=1` evita abrir el navegador (para probarlo sin ventanas).
 */
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const logDir = path.join(projectRoot, 'data', 'logs');
const logServidor = path.join(logDir, 'servidor.log');
const paginaError = path.join(projectRoot, 'data', 'ultimo-arranque.html');

const TASK_NAME = 'BrainUp Academy';
const rawPort = Number(process.env.PORT);
const PORT = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000;
const URL_APP = `http://localhost:${PORT}`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/salud`;
const SIN_NAVEGADOR = process.env.BRAINUP_NO_ABRIR === '1';

/** Cuánto se espera a que la app responda antes de rendirse (desarrollo compila al vuelo). */
const TOPE_ESPERA_MS = 150000;

function anotar(linea) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const sello = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(path.join(logDir, 'abrir.log'), `[${sello}] ${linea}\n`);
  } catch {}
}

async function saludable() {
  try {
    const res = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    const cuerpo = await res.json().catch(() => ({}));
    return res.ok && cuerpo.ok === true;
  } catch {
    return false;
  }
}

function abrirNavegador(url = URL_APP) {
  if (SIN_NAVEGADOR) return;
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {}
}

/**
 * Pide a Windows que ejecute la tarea. Si la tarea no existiera (instalación a
 * medias), se arranca el servidor vigilado directamente: el icono nunca se queda
 * de brazos cruzados.
 */
function arrancar() {
  try {
    execFileSync('schtasks', ['/run', '/tn', TASK_NAME], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
    anotar('arranque pedido a la tarea de Windows');
    return;
  } catch {
    anotar('la tarea no ha aceptado el arranque; se levanta el servidor directamente');
  }

  try {
    const hijo = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'sirve.js')], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    hijo.unref();
  } catch (error) {
    anotar(`no se ha podido lanzar el servidor: ${error.message}`);
  }
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function esperarSalud(topeMs) {
  const fin = Date.now() + topeMs;
  while (Date.now() < fin) {
    if (await saludable()) return true;
    await esperar(500);
  }
  return false;
}

function escapar(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Las últimas líneas del diario, que es donde está el motivo de verdad. */
function ultimasLineas(cuantas = 45) {
  try {
    const texto = fs.readFileSync(logServidor, 'utf8');
    return texto.trimEnd().split('\n').slice(-cuantas).join('\n');
  } catch {
    return '(todavía no hay diario del servidor)';
  }
}

/**
 * Página de error propia. Se abre como archivo local, así que funciona incluso
 * cuando no hay ningún servidor: es justo el caso en el que hace falta.
 */
function escribirPaginaDeError() {
  const ahora = new Date();
  const fecha = ahora.toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' });
  const detalle = escapar(ultimasLineas());

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BrainUp Academy no ha arrancado</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 32px 20px;
    background: radial-gradient(1200px 600px at 50% -10%, #0f2a22 0%, #090d16 55%);
    color: #e2e8f0; font: 16px/1.6 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 760px; }
  .marca { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
  .logo {
    width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
    background: rgba(16,185,129,.16); border: 1px solid rgba(16,185,129,.45);
    color: #34d399; font-weight: 800; font-size: 20px;
  }
  .marca b { letter-spacing: .12em; font-size: 13px; text-transform: uppercase; }
  .marca span { display: block; color: #34d399; font-size: 12px; font-family: ui-monospace, monospace; }
  h1 { font-size: clamp(24px, 5vw, 34px); line-height: 1.2; margin: 0 0 10px; letter-spacing: -.02em; }
  p { color: #94a3b8; margin: 0 0 16px; }
  .tarjeta {
    background: rgba(15,23,42,.72); border: 1px solid #1e293b; border-radius: 16px;
    padding: 20px; margin: 22px 0;
  }
  .tarjeta h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .1em; color: #cbd5e1; margin: 0 0 12px; }
  ol { margin: 0; padding-left: 20px; color: #cbd5e1; }
  li { margin: 8px 0; }
  pre {
    margin: 0; padding: 16px; border-radius: 12px; overflow: auto; max-height: 46vh;
    background: #05080f; border: 1px solid #1e293b; color: #a7f3d0;
    font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap;
  }
  .pie { margin-top: 18px; font-size: 13px; color: #64748b; }
  .boton {
    display: inline-block; margin-top: 6px; padding: 10px 16px; border-radius: 10px;
    background: #10b981; color: #04120d; font-weight: 700; text-decoration: none; font-size: 14px;
  }
</style>
</head>
<body>
<main>
  <div class="marca">
    <div class="logo">B</div>
    <div><b>BrainUp Academy</b><span>Bachillerato &amp; PAU</span></div>
  </div>

  <h1>La app no ha llegado a arrancar</h1>
  <p>No se ha perdido nada: tus datos siguen en el disco de este ordenador. Lo que no ha
     respondido es el servidor que sirve la app.</p>

  <div class="tarjeta">
    <h2>Qué hacer</h2>
    <ol>
      <li><b>Cierra esta pestaña y vuelve a hacer doble clic en el icono BrainUp Academy.</b>
          Casi siempre es un arranque que se ha atascado y el segundo intento entra.</li>
      <li>Si vuelve a salir esta página, mira el texto de abajo: dice el motivo exacto.</li>
      <li>Cópialo y pásalo para que se arregle de raíz. No hace falta que entiendas nada de lo que pone.</li>
    </ol>
  </div>

  <div class="tarjeta">
    <h2>Lo último que dijo el servidor · ${escapar(fecha)}</h2>
    <pre>${detalle}</pre>
  </div>

  <a class="boton" href="${escapar(URL_APP)}">Reintentar ahora</a>
  <p class="pie">El arranque automático se reintenta solo cada 5 minutos, también después de un reinicio.</p>
</main>
</body>
</html>`;

  try {
    fs.mkdirSync(path.dirname(paginaError), { recursive: true });
    fs.writeFileSync(paginaError, html, 'utf8');
  } catch (error) {
    anotar(`no se ha podido escribir la página de error: ${error.message}`);
    return;
  }

  anotar('la app no ha respondido: se abre la página de diagnóstico');
  abrirNavegador(`file:///${paginaError.replace(/\\/g, '/')}`);
}

(async () => {
  if (await saludable()) {
    anotar('la app ya estaba en pie: se abre el navegador');
    abrirNavegador();
    return 0;
  }

  anotar('la app no responde: se arranca');
  arrancar();

  if (await esperarSalud(TOPE_ESPERA_MS)) {
    anotar('la app ya responde: se abre el navegador');
    abrirNavegador();
    return 0;
  }

  escribirPaginaDeError();
  return 1;
})()
  .then((codigo) => process.exit(codigo))
  .catch((error) => {
    anotar(`error inesperado del lanzador: ${error.message}`);
    escribirPaginaDeError();
    process.exit(1);
  });
