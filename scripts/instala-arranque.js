/**
 * Deja BrainUp Academy instalada como una app de Windows: se enciende sola al
 * entrar, se revive si se cae, y se abre con un icono. Sin CMD y sin scripts que
 * un antivirus pueda borrar.
 *
 * **Por qué no hay un .cmd ni un .ps1 en el camino crítico.** El 28 de octubre el
 * instalador se quejaba de que «falta un script», y era verdad: el `.ps1` que
 * lanzaba la app había desaparecido (antes se había llevado el `.vbs` Windows
 * Defender, que borra scripts que abren procesos ocultos). Un fichero de script en
 * disco es justo lo que un antivirus elimina sin avisar. Aquí no hay ninguno: la
 * tarea ejecuta **una línea de PowerShell sin fichero** (`-Command`) que llama a
 * Node con `scripts/sirve.js`. No hay nada que se pueda perder.
 *
 * **Por qué una sola tarea y no un acceso directo en Inicio.** Tener las dos cosas
 * es tener dos arranques a la vez: dos `sirve.js` comprobando la salud al mismo
 * tiempo, los dos viendo el puerto libre y los dos levantando Next sobre el mismo
 * `.next` (se pelean y la app queda a medias). Ahora hay **una tarea** con dos
 * disparadores —al iniciar sesión y cada 5 minutos— y `MultipleInstances
 * IgnoreNew`: Windows no lanza una segunda mientras la primera sigue viva. El
 * cerrojo de `sirve.js` cierra el hueco que queda si algo arranca por otra vía.
 *
 * **Qué hace cada disparador.**
 *   - Al iniciar sesión: la app está lista sin que el alumno toque nada.
 *   - Cada 5 minutos: si la app responde, `sirve.js` termina en el acto (latido
 *     barato); si no responde, se queda ejecutándola. Eso convierte una caída en
 *     cinco minutos de espera, no en una tarde sin app.
 *
 * La tarea corre como el usuario y **no** pide permisos de administrador: la app
 * no debe ser de administrador (escribiría archivos que luego no se pueden tocar
 * desde una ventana normal).
 *
 * Uso:
 *   node scripts/instala-arranque.js            → instala todo y arranca la app
 *   node scripts/instala-arranque.js --estado   → dice qué hay puesto y si responde
 *   node scripts/instala-arranque.js --arranca  → solo la levanta ahora
 *   node scripts/instala-arranque.js --quitar   → lo desinstala (sin borrar datos)
 *
 * Con npm:
 *   npm run arranque:instala · npm run arranque:estado · npm run arranque:quita
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { direccionesLocales, urlMovil } = require('./red-local');

const projectRoot = path.join(__dirname, '..');
const launcher = path.join(projectRoot, 'scripts', 'sirve.js');
const abre = path.join(projectRoot, 'scripts', 'abre.js');
const iconoPng = path.join(projectRoot, 'public', 'icon.png');
const iconoIco = path.join(projectRoot, 'public', 'brainup.ico');
const nodeExe = process.execPath;

const TASK_NAME = 'BrainUp Academy';
/** Nombres de intentos anteriores: se quitan para que no haya dos arranques. */
const LEGACY_TASKS = ['BrainUp Academy (latido)', 'BrainUp Academy - arranque'];
const SHORTCUT_NAME = 'BrainUp Academy.lnk';
const LEGACY_STARTUP_FILES = ['BrainUp Academy.lnk', 'BrainUp Academy.vbs', 'arranca-oculto.vbs'];

const rawPort = Number(process.env.PORT);
const PORT = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/salud`;

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script) {
  try {
    return {
      ok: true,
      out: execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 60000 }
      ).trim(),
    };
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    const stdout = String(error?.stdout ?? '').trim();
    return { ok: false, out: stderr || stdout || String(error?.message ?? '') };
  }
}

function startupFolder() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null;
}

/** Rutas reales del escritorio y del menú Inicio (pueden estar en OneDrive). */
function rutasAccesos() {
  const result = runPowerShell(
    [
      "$escritorio = [Environment]::GetFolderPath('Desktop')",
      "$programas = [Environment]::GetFolderPath('Programs')",
      "$escritorio",
      "$programas",
    ].join('; ')
  );
  if (result.ok) {
    const [escritorio, programas] = result.out.split(/\r?\n/).map((linea) => linea.trim());
    if (escritorio && programas) {
      return {
        escritorio: path.join(escritorio, SHORTCUT_NAME),
        menuInicio: path.join(programas, SHORTCUT_NAME),
      };
    }
  }
  return {
    escritorio: path.join(process.env.USERPROFILE || '', 'Desktop', SHORTCUT_NAME),
    menuInicio: path.join(
      process.env.APPDATA || '',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      SHORTCUT_NAME
    ),
  };
}

/**
 * Convierte el PNG de la app en un .ico para el acceso directo.
 *
 * Un ICO moderno puede llevar un PNG dentro tal cual (Windows Vista y posteriores),
 * así que no hace falta ninguna librería: 6 bytes de cabecera, 16 de directorio y
 * el PNG detrás. Si el PNG no se puede leer, se sigue sin icono propio: no es
 * motivo para no instalar nada.
 */
function escribirIcono() {
  try {
    const png = fs.readFileSync(iconoPng);
    if (png.length < 24 || png.toString('ascii', 1, 4) !== 'PNG') return false;

    const ancho = png.readUInt32BE(16);
    const alto = png.readUInt32BE(20);
    if (!ancho || !alto || ancho > 256 || alto > 256) return false;

    const cabecera = Buffer.alloc(6);
    cabecera.writeUInt16LE(0, 0); // reservado
    cabecera.writeUInt16LE(1, 2); // tipo: icono
    cabecera.writeUInt16LE(1, 4); // un solo icono

    const entrada = Buffer.alloc(16);
    entrada.writeUInt8(ancho === 256 ? 0 : ancho, 0);
    entrada.writeUInt8(alto === 256 ? 0 : alto, 1);
    entrada.writeUInt8(0, 2); // sin paleta
    entrada.writeUInt8(0, 3);
    entrada.writeUInt16LE(1, 4); // planos
    entrada.writeUInt16LE(32, 6); // bits por píxel
    entrada.writeUInt32LE(png.length, 8);
    entrada.writeUInt32LE(22, 12); // tras cabecera + entrada

    fs.writeFileSync(iconoIco, Buffer.concat([cabecera, entrada, png]));
    return true;
  } catch {
    return false;
  }
}

function crearAcceso(destino) {
  const icono = fs.existsSync(iconoIco) ? `${iconoIco},0` : '';
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut(${psQuote(destino)})`,
    `$sc.TargetPath = ${psQuote(nodeExe)}`,
    `$sc.Arguments = ${psQuote(`"${abre}"`)}`,
    `$sc.WorkingDirectory = ${psQuote(projectRoot)}`,
    ...(icono ? [`$sc.IconLocation = ${psQuote(icono)}`] : []),
    '$sc.WindowStyle = 7',
    '$sc.Description = "Abre BrainUp Academy (la arranca si hace falta)"',
    '$sc.Save()',
  ].join('; ');

  const result = runPowerShell(script);
  return result.ok && fs.existsSync(destino);
}

function instalarAccesos() {
  const rutas = rutasAccesos();
  return {
    ...rutas,
    escritorioOk: crearAcceso(rutas.escritorio),
    menuInicioOk: crearAcceso(rutas.menuInicio),
  };
}

function quitarAccesos() {
  const rutas = rutasAccesos();
  const inicio = startupFolder();
  const delInicio = inicio ? path.join(inicio, 'BrainUp Academy (inicio).lnk') : null;
  for (const ruta of [rutas.escritorio, rutas.menuInicio, delInicio]) {
    if (!ruta) continue;
    try {
      fs.rmSync(ruta, { force: true });
    } catch {}
  }
}

function tareaExiste(nombre) {
  const result = runPowerShell(
    `if (Get-ScheduledTask -TaskName ${psQuote(nombre)} -ErrorAction SilentlyContinue) { 'si' } else { 'no' }`
  );
  return result.ok && result.out.trim().toLowerCase() === 'si';
}

function quitarTarea(nombre) {
  const result = runPowerShell(
    [
      `Unregister-ScheduledTask -TaskName ${psQuote(nombre)} -Confirm:$false -ErrorAction SilentlyContinue`,
      `if (Get-ScheduledTask -TaskName ${psQuote(nombre)} -ErrorAction SilentlyContinue) { 'sigue' } else { 'fuera' }`,
    ].join('; ')
  );
  return result.ok && result.out.trim().toLowerCase() === 'fuera';
}

/** Estado de la tarea: «estado|último resultado|próxima vez». */
function estadoTarea() {
  const result = runPowerShell(
    [
      `$t = Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue`,
      "if (-not $t) { 'no' } else { " +
        `$i = Get-ScheduledTaskInfo -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue; ` +
        "\"$($t.State)|$($i.LastTaskResult)|$($i.NextRunTime)\" }",
    ].join('; ')
  );
  return result.ok ? result.out.trim() : '';
}

/**
 * Registra la tarea. Devuelve el estado que ha quedado («ready», «running»,
 * «disabled»…) o el error, sin esconderlo.
 */
/**
 * Registra la tarea delegando en `scripts/instala-tarea.ps1`.
 *
 * Antes se construía el registro en una línea de PowerShell generada desde aquí.
 * Funcionaba, pero es un texto con comillas dentro de comillas que se rompe con
 * facilidad (y el canal elevado de este equipo corta los comandos largos). El
 * `.ps1` hace lo mismo con sintaxis de verdad, deja su propio diario y se puede
 * ejecutar solo para reparar la tarea sin tocar nada más. Si el `.ps1`
 * desapareciera, la tarea ya instalada sigue funcionando: no es un lanzador.
 */
function instalarTarea() {
  const ps1 = path.join(projectRoot, 'scripts', 'instala-tarea.ps1');
  if (!fs.existsSync(ps1)) {
    return { estado: '', error: 'falta scripts/instala-tarea.ps1' };
  }

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    });
  } catch (error) {
    return {
      estado: '',
      error: String(error?.stderr || error?.message || 'el instalador de la tarea falló').trim(),
    };
  }

  const estado = estadoTarea().split('|')[0].toLowerCase();
  return { estado, error: estado ? '' : 'Windows no devuelve la tarea' };
}

function quitarTareasAntiguas() {
  const quitadas = [];
  for (const nombre of LEGACY_TASKS) {
    if (tareaExiste(nombre) && quitarTarea(nombre)) quitadas.push(nombre);
  }
  // El acceso directo de Inicio de la versión anterior: si se quedara, arrancaría
  // otra copia a la vez que la tarea.
  const inicio = startupFolder();
  if (inicio) {
    for (const archivo of LEGACY_STARTUP_FILES) {
      const ruta = path.join(inicio, archivo);
      if (fs.existsSync(ruta)) {
        try {
          fs.rmSync(ruta, { force: true });
          quitadas.push(archivo);
        } catch {}
      }
    }
  }
  return quitadas;
}

async function saludable() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    return res.ok && body.ok === true;
  } catch {
    return false;
  }
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lanza la tarea ya, sin esperar al latido, y espera a que responda. */
async function arrancarAhora() {
  const tarea = tareaExiste(TASK_NAME);
  if (tarea) {
    runPowerShell(`schtasks /run /tn ${psQuote(TASK_NAME)} | Out-Null; 'ok'`);
  } else {
    // Sin tarea (por ejemplo, si Windows no dejó registrarla), se levanta el
    // servidor directamente para que el alumno tenga la app igualmente.
    try {
      const { spawn } = require('child_process');
      spawn(nodeExe, [launcher], {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      }).unref();
    } catch {}
  }

  for (let i = 0; i < 60; i += 1) {
    if (await saludable()) return true;
    await esperar(1000);
  }
  return false;
}

function direccionMovil() {
  const redes = direccionesLocales();
  const casa = redes.find((red) => !red.virtual) || redes[0];
  return casa ? urlMovil(casa.direccion, PORT) : '';
}

async function main() {
  const modo = process.argv[2] ?? '';

  if (process.platform !== 'win32') {
    console.log('Esto solo tiene sentido en Windows.');
    process.exitCode = 1;
    return;
  }

  for (const [ruta, nombre] of [
    [launcher, 'scripts/sirve.js'],
    [abre, 'scripts/abre.js'],
  ]) {
    if (!fs.existsSync(ruta)) {
      console.log(`Falta ${nombre}: sin él no hay nada que instalar.`);
      process.exitCode = 1;
      return;
    }
  }

  if (modo === '--estado') {
    console.log('BrainUp Academy · arranque automático');
    console.log('─────────────────────────────────────');
    const estado = estadoTarea();
    if (!estado || estado === 'no') {
      console.log('Tarea de Windows: NO instalada (la app no se levanta sola).');
    } else {
      const [est, ultimo, proximo] = estado.split('|');
      console.log(`Tarea de Windows: puesta · estado ${est} · último resultado ${ultimo} · próximo ${proximo || '(sin fecha)'}`);
      if (String(est).toLowerCase() === 'disabled') {
        console.log('  AVISO: está deshabilitada. Vuelve a instalar con `npm run arranque:instala`.');
      }
    }
    const rutas = rutasAccesos();
    console.log(`Icono en el escritorio: ${fs.existsSync(rutas.escritorio) ? 'sí' : 'no'}`);
    console.log(`Icono en el menú Inicio: ${fs.existsSync(rutas.menuInicio) ? 'sí' : 'no'}`);
    const inicioArranque = startupFolder();
    const accesoInicio = inicioArranque ? path.join(inicioArranque, 'BrainUp Academy (inicio).lnk') : null;
    console.log(`Acceso de arranque en Inicio: ${accesoInicio && fs.existsSync(accesoInicio) ? 'sí' : 'no'}`);
    const inicio = startupFolder();
    const restos = inicio
      ? LEGACY_STARTUP_FILES.filter((archivo) => fs.existsSync(path.join(inicio, archivo)))
      : [];
    if (restos.length > 0) console.log(`Restos antiguos en Inicio: ${restos.join(', ')}`);
    console.log(`App ahora: ${(await saludable()) ? 'responde' : 'NO responde'}`);
    const movil = direccionMovil();
    if (movil) console.log(`Móvil (misma Wi-Fi): ${movil}`);
    return;
  }

  if (modo === '--quitar') {
    const existia = tareaExiste(TASK_NAME);
    const fuera = existia ? quitarTarea(TASK_NAME) : true;
    quitarAccesos();
    const antiguas = quitarTareasAntiguas();
    console.log(existia ? (fuera ? 'Tarea quitada: la app ya no arranca sola.' : 'No se ha podido quitar la tarea.') : 'No había tarea instalada.');
    console.log('Iconos quitados del escritorio y del menú Inicio.');
    if (antiguas.length > 0) console.log(`Limpiados restos antiguos: ${antiguas.join(', ')}`);
    console.log('La app que esté en marcha sigue en marcha; tus datos no se tocan.');
    return;
  }

  if (modo === '--arranca') {
    console.log('Arrancando BrainUp Academy…');
    const ok = await arrancarAhora();
    console.log(ok ? `Ya responde en http://localhost:${PORT}` : 'No ha respondido. Revisa data/logs/servidor.log');
    process.exitCode = ok ? 0 : 1;
    return;
  }

  // Instalación completa.
  console.log('BrainUp Academy · dejando el arranque automático');
  console.log('──────────────────────────────────────────────');

  const icono = escribirIcono();
  const accesos = instalarAccesos();
  const antiguas = quitarTareasAntiguas();
  const tarea = instalarTarea();

  console.log('');
  console.log(icono ? 'Icono propio: preparado.' : 'Icono propio: no se ha podido preparar (se usa el de Node).');
  console.log(
    accesos.escritorioOk
      ? `Icono en el escritorio: ${accesos.escritorio}`
      : 'Icono en el escritorio: no se ha podido crear.'
  );
  console.log(
    accesos.menuInicioOk
      ? 'Icono en el menú Inicio: puesto (búscalo como «BrainUp Academy»).'
      : 'Icono en el menú Inicio: no se ha podido crear.'
  );
  if (antiguas.length > 0) console.log(`Limpiados restos de versiones anteriores: ${antiguas.join(', ')}`);

  if (tarea.estado === 'ready' || tarea.estado === 'running') {
    console.log('Tarea de Windows: puesta.');
    console.log('  · Se enciende sola al entrar en Windows.');
    console.log('  · Cada 5 minutos mira si responde y, si no, la levanta.');
  } else if (tarea.estado === 'disabled') {
    console.log('Tarea de Windows: registrada pero DESHABILITADA. Ejecuta esto otra vez como administrador.');
  } else {
    console.log('Tarea de Windows: no se ha podido registrar.');
    if (tarea.error) console.log(`  Motivo: ${tarea.error}`);
    console.log('  Los iconos sí están puestos: al abrirlos, la app arranca igualmente.');
  }

  console.log('');
  console.log('Arrancando ahora…');
  const ok = await arrancarAhora();
  const movil = direccionMovil();
  console.log('');
  if (ok) {
    console.log(`Listo: responde en http://localhost:${PORT}`);
    if (movil) console.log(`Desde el móvil, misma Wi-Fi: ${movil}`);
    console.log('A partir de ahora no hay que ejecutar nada: abre el icono BrainUp Academy.');
  } else {
    console.log('No ha respondido todavía. El latido lo reintenta cada 5 minutos.');
    console.log('Detalle en data/logs/servidor.log y data/logs/abrir.log');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('No se ha podido terminar:', error?.message ?? error);
  process.exitCode = 1;
});
