/**
 * `prisma generate` con una red debajo.
 *
 * En este equipo, Windows se queda a veces con el motor de Prisma abierto
 * (`query_engine-windows.dll.node`) y el renombrado final falla con:
 *
 *     EPERM: operation not permitted, rename ... .tmp20016 -> query_engine-windows.dll.node
 *
 * Eso tumbaba `npm run build` entero aunque el cliente ya estuviera generado y
 * fuera perfectamente válido: el build de Next no llegaba ni a empezar.
 *
 * Aquí se hace lo sensato en tres pasos:
 *   1. Se intenta generar.
 *   2. Si falla, se reintenta unas cuantas veces (el bloqueo suele ser de un
 *      antivirus o de un proceso que acaba de morir, y dura segundos).
 *   3. Si sigue fallando pero el cliente ya existe, se avisa y se continúa: el
 *      código generado es el mismo que se iba a escribir, así que seguir es
 *      honesto. Si NO existe, el error se propaga y el build falla de verdad.
 *
 * Uso: `node scripts/prisma-generate.js` (lo llama `npm run build:local`).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
/** Cliente ya generado: si está, el proyecto puede compilar sin volver a generarlo. */
const clientEntry = path.join(projectRoot, 'node_modules', '.prisma', 'client', 'index.js');
/** Cuántas veces se intenta antes de darse por vencido. */
const INTENTOS = 3;
/** Espera entre intentos (2 s, 4 s…): un bloqueo de antivirus se suelta rápido. */
const BASE_ESPERA_MS = 2000;

/** `Atomics.wait` es la única espera síncrona fiable sin dependencias. */
function esperar(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rutaCli() {
  const ruta = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js');
  return fs.existsSync(ruta) ? ruta : null;
}

function generar() {
  const cli = rutaCli();
  if (cli) {
    execFileSync(process.execPath, [cli, 'generate'], { cwd: projectRoot, stdio: 'inherit' });
    return;
  }
  // Sin el CLI local, `npx` es el camino de siempre.
  execFileSync('npx', ['prisma', 'generate'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

let ultimoError = null;

for (let intento = 1; intento <= INTENTOS; intento += 1) {
  try {
    generar();
    ultimoError = null;
    break;
  } catch (error) {
    ultimoError = error;
    if (intento < INTENTOS) {
      console.warn(
        `aviso: prisma generate falló (intento ${intento}/${INTENTOS}). Reintento en ${
          (BASE_ESPERA_MS * intento) / 1000
        } s…`
      );
      esperar(BASE_ESPERA_MS * intento);
    }
  }
}

if (ultimoError) {
  if (fs.existsSync(clientEntry)) {
    console.warn(
      'aviso: prisma generate no ha podido reescribir el cliente (archivo bloqueado por otro proceso), ' +
        'pero el cliente ya generado existe y el build continúa con él. Cierra la app y vuelve a compilar ' +
        'si has cambiado el esquema.'
    );
    process.exit(0);
  }

  console.error('prisma generate ha fallado y no hay cliente generado: no se puede compilar.');
  process.exit(1);
}
