/**
 * Compilar un módulo de `src/lib` para poder ejecutarlo desde un script.
 *
 * Node no entiende TypeScript, y el vigilante necesita ejecutar **el mismo**
 * código que corre dentro de la app (el motor de mantenimiento, el cliente de
 * Prisma, el motor de IA). Se le pide a `tsc` que compile la cadena real —el
 * módulo y todo lo que importa— en una carpeta temporal, y desde ahí se
 * `require()`ea. Así no hay una segunda copia de las reglas que pueda quedarse
 * desfasada: si el motor cambia, el vigilante cambia con él.
 *
 * Es la misma técnica que usan los scripts `verify-*` del proyecto.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');

/**
 * Compila `src/lib/<entrada>.ts` en `.<outDirName>/` y devuelve la ruta de la
 * carpeta compilada.
 *
 * Si `tsc` falla, se lanza el error con la salida del compilador incluida: un
 * vigilante que no arranca porque el código no compila tiene que decirlo claro,
 * no morir en silencio.
 */
function compilaTs(entrada, outDirName) {
  // Cada proceso compila en **su propia** carpeta (el sufijo es su PID). Si dos
  // scripts comparten carpeta, uno borra la del otro mientras la está usando y el
  // `require` acaba en un «Cannot find module» que no tiene nada que ver con el
  // código: pasó en cuanto arrancaron dos vigilantes a la vez.
  const sufijo = String(process.pid);
  // Ojo: el nombre que se le da a `tsc` tiene que ser EXACTAMENTE el mismo que
  // después se `require`ea. Con sufijos distintos, tsc escribe en un sitio y el
  // require busca en otro (y el error que sale es un «Cannot find module» que no
  // tiene nada que ver con el código de la app).
  const outDirRel = `${outDirName}-${sufijo}`;
  const outDir = path.join(projectRoot, outDirRel);
  fs.rmSync(outDir, { recursive: true, force: true });
  borraViejas(outDirName, outDir);

  const tsc = require.resolve('typescript/bin/tsc');
  const args = [
    path.join('src', 'lib', entrada),
    '--outDir',
    outDirRel,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--resolveJsonModule',
  ];

  try {
    execFileSync(process.execPath, [tsc, ...args], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    const salida = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    const detalle = salida.split('\n').slice(0, 20).join('\n');
    throw new Error(
      `No se ha podido compilar src/lib/${entrada}.ts${detalle ? `:\n${detalle}` : ` (${error.message})`}`
    );
  }

  return outDir;
}

/**
 * Limpia las carpetas de compilación que han dejado otros procesos (o este mismo
 * en una ejecución anterior). Se conserva la carpeta en uso.
 */
function borraViejas(outDirName, enUso) {
  try {
    const prefijo = `${outDirName}-`;
    for (const nombre of fs.readdirSync(projectRoot)) {
      if (!nombre.startsWith(prefijo)) continue;
      const ruta = path.join(projectRoot, nombre);
      if (ruta === enUso) continue;
      // Solo se borran carpetas: nunca un fichero que el alumno pueda querer.
      if (fs.statSync(ruta).isDirectory()) fs.rmSync(ruta, { recursive: true, force: true });
    }
  } catch {
    // Si no se puede limpiar, no pasa nada: molesta, no rompe.
  }
}

module.exports = { compilaTs, projectRoot };
