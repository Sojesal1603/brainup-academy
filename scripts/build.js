/**
 * `npm run build:local`, pero sin pelearse con la app.
 *
 * El fallo que había:
 *
 *     ✓ Compiled successfully
 *     Error: ENOENT ... .next/server/pages-manifest.json
 *     PageNotFoundError: Cannot find module for page: /api/errores
 *
 * No era el código: era que la app se arranca sola cada 5 minutos (tarea
 * programada → `sirve.js`). Si no encuentra una compilación de producción, ese
 * vigilante arranca Next **en desarrollo**, y el servidor de desarrollo escribe
 * en la MISMA carpeta de salida que el build (`distDir`). Mientras compilaba,
 * el dev iba borrando y reescribiendo piezas (manifests, vendor-chunks) y el
 * build se encontraba su propio resultado a medias.
 *
 * Este script hace las tres cosas en orden:
 *   1. Deja un cerrojo (`data/logs/build.lock`) para que ningún latido arranque
 *      un servidor mientras dure la compilación.
 *   2. Para la app si está en pie: un servidor y un build no pueden compartir la
 *      carpeta de salida.
 *   3. Genera Prisma y compila. Al terminar (o al fallar) suelta el cerrojo.
 *
 * La app queda parada a propósito: el latido de Windows la vuelve a levantar
 * sola en unos minutos, ya en modo producción (existe `BUILD_ID`). Para
 * levantarla ahora mismo: `npm run sirve`.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const logDir = path.join(projectRoot, 'data', 'logs');
const lockPath = path.join(logDir, 'build.lock');
const sirveBin = path.join(__dirname, 'sirve.js');
const prismaBin = path.join(__dirname, 'prisma-generate.js');
const healthUrl = 'http://127.0.0.1:3000/api/salud';

fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(lockPath, String(process.pid), 'utf8');

/** El cerrojo se suelta pase lo que pase: si se queda, la app no vuelve. */
function soltarCerrojo() {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Si no se puede borrar, el latido lo ignora en cuanto la app responda.
  }
}

process.on('exit', soltarCerrojo);
process.on('SIGINT', () => {
  soltarCerrojo();
  process.exit(130);
});
process.on('uncaughtException', (error) => {
  soltarCerrojo();
  console.error(error);
  process.exit(1);
});

function paso(titulo, args, opciones = {}) {
  console.log(`\n▶ ${titulo}`);
  execFileSync(process.execPath, args, { cwd: projectRoot, stdio: 'inherit', ...opciones });
}

/** ¿Hay app respondiendo en el puerto de siempre? */
function appEnPie() {
  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `fetch(${JSON.stringify(healthUrl)}).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));`,
      ],
      { cwd: projectRoot, stdio: 'ignore', timeout: 4000 }
    );
    return true;
  } catch {
    return false;
  }
}

function esperar(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 1. La app, parada. Si no está, `--stop` simplemente informa y sigue.
try {
  paso('Parando la app (un servidor y un build no pueden compartir la carpeta de salida)', [
    sirveBin,
    '--stop',
  ]);
} catch {
  console.log('  (no había nada que parar)');
}

// 2. Esperar a que el puerto quede libre de verdad.
for (let intento = 0; intento < 10 && appEnPie(); intento += 1) {
  esperar(1000);
}

// 3. Prisma y build.
paso('Generando el cliente de Prisma', [prismaBin]);

console.log('\n▶ Compilando la app');
execFileSync(
  process.execPath,
  [path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'],
  { cwd: projectRoot, stdio: 'inherit' }
);

console.log('\n✔ Build terminado. La app queda parada: se levanta sola en el próximo latido');
console.log('  (o ahora mismo con `npm run sirve`).');
