/**
 * Verificación end-to-end de la conexión con Moodle por Web Services.
 *
 * Levanta un **Moodle simulado** (servidor HTTP local que responde como el
 * `webservice/rest/server.php` real y como `pluginfile.php`), conecta la app a
 * ese Moodle por su interfaz real (HTTP, con token) y comprueba todo lo que
 * promete la función:
 *
 *   1. La conexión valida el token y NO lo filtra (ni en la respuesta ni en la BD).
 *   2. Se indexan los apuntes de cada tema (archivos, carpetas, enlaces, páginas)
 *      y se ignoran las secciones y módulos ocultos.
 *   3. Se leen las tareas con su fecha de entrega y si ya están entregadas.
 *   4. Las tareas que ya estaban por el calendario iCal se adoptan, no se duplican.
 *   5. Los archivos se descargan con el token puesto en el servidor, quedan
 *      cacheados en data/moodle y después se sirven sin conexión.
 *   6. Un archivo de otro dominio no se descarga (el token no sale de tu Moodle).
 *   7. La vía fácil (usuario y contraseña → login/token.php) consigue la clave
 *      igual de bien, rechaza una contraseña mala sin pisar lo que ya había y
 *      nunca deja la contraseña en la base ni en la respuesta.
 *
 * Requisitos: servidor de desarrollo en http://localhost:3000.
 *
 * Uso:
 *   node scripts/verify-moodle-ws.js            → prueba completa y limpieza
 *   node scripts/verify-moodle-ws.js --keep     → deja los datos del mock para inspeccionarlos
 *   node scripts/verify-moodle-ws.js --serve    → solo levanta el Moodle simulado (pruebas a mano)
 *
 * El Moodle simulado usa el puerto 4977 (cambiable con MOODLE_MOCK_PORT).
 *
 * El perfil (dirección, token, sitio y usuario de Moodle) se guarda antes de
 * tocar nada y se restaura al terminar, pase lo que pase.
 */
const fs = require('fs');
const { getTestUserId } = require('./testUser.js');
const http = require('http');
const os = require('os');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const p = new PrismaClient();
const APP = 'http://localhost:3000';
const MOCK_PORT = Number(process.env.MOODLE_MOCK_PORT) || 4977;
const ATTACKER_PORT = MOCK_PORT + 1;
const WS_OFF_PORT = MOCK_PORT + 2;
const CLOSED_PORT = MOCK_PORT + 3;
const SERVICE_OFF_PORT = MOCK_PORT + 4;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const TOKEN = 'brainup-verify-token-123456';
// Credenciales del Moodle simulado para la vía «usuario y contraseña». La
// contraseña solo existe aquí y en la petición que hace la app: nunca se guarda.
const LOGIN_USER = 'santiago';
const LOGIN_PASSWORD = 'BrainUp-Verify-2026';
const USER_ID = 42;
const PROFILE_BACKUP = path.join(os.tmpdir(), 'brainup-moodle-ws-profile.json');
const CACHE_DIR = path.join(process.cwd(), 'data', 'moodle');
const keep = process.argv.includes('--keep');

let failures = 0;
const createdCourseIds = [];
const createdMaterialIds = [];
const createdTaskIds = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` · ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* Moodle simulado                                                     */
/* ------------------------------------------------------------------ */

const REQUIRED_FUNCTIONS = [
  'core_webservice_get_site_info',
  'core_enrol_get_users_courses',
  'core_course_get_contents',
  'mod_assign_get_assignments',
  'mod_assign_get_submissions',
];

const day = 86400000;
const nowSeconds = Math.floor(Date.now() / 1000);

function pluginFile(fileName) {
  return `${MOCK_BASE}/webservice/pluginfile.php/1/mod_resource/content/0/${encodeURIComponent(fileName)}`;
}

function fileContent(name) {
  return Buffer.from(`%PDF-1.4\n% Moodle simulado\nArchivo: ${name}\n`, 'utf8');
}

const COURSE_CONTENTS = {
  101: [
    {
      id: 1,
      name: 'Tema 1: Matrices',
      section: 1,
      visible: 1,
      modules: [
        {
          id: 11,
          name: 'Apuntes Tema 1',
          modname: 'resource',
          url: `${MOCK_BASE}/mod/resource/view.php?id=11`,
          visible: 1,
          contents: [
            {
              type: 'file',
              filename: 'Tema 1 - Matrices.pdf',
              fileurl: `${pluginFile('Matrices.pdf')}?forcedownload=1`,
              filesize: 2048,
              mimetype: 'application/pdf',
              timemodified: nowSeconds - day,
            },
          ],
        },
        {
          id: 12,
          name: 'Ejercicios resueltos',
          modname: 'folder',
          url: `${MOCK_BASE}/mod/folder/view.php?id=12`,
          visible: 1,
          contents: [
            {
              type: 'file',
              filename: 'Ejercicios 1.pdf',
              fileurl: pluginFile('Ejercicios1.pdf'),
              filesize: 1024,
              mimetype: 'application/pdf',
              timemodified: nowSeconds - 2 * day,
            },
            {
              type: 'file',
              filename: 'Ejercicios 2.pdf',
              fileurl: pluginFile('Ejercicios2.pdf'),
              filesize: 1024,
              mimetype: 'application/pdf',
              timemodified: nowSeconds - 2 * day,
            },
          ],
        },
        {
          id: 13,
          name: 'Vídeo de repaso',
          modname: 'url',
          url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
          visible: 1,
          contents: [],
        },
        {
          id: 14,
          name: 'Resumen de fórmulas',
          modname: 'page',
          url: `${MOCK_BASE}/mod/page/view.php?id=14`,
          visible: 1,
          contents: [],
        },
        {
          id: 15,
          name: 'Entrega Matrices',
          modname: 'assign',
          url: `${MOCK_BASE}/mod/assign/view.php?id=55`,
          visible: 1,
          contents: [],
        },
      ],
    },
    {
      id: 2,
      name: 'Recursos ocultos del profesor',
      section: 2,
      visible: 0,
      modules: [
        {
          id: 16,
          name: 'No debería aparecer',
          modname: 'resource',
          url: `${MOCK_BASE}/mod/resource/view.php?id=16`,
          visible: 1,
          contents: [
            {
              type: 'file',
              filename: 'Oculto.pdf',
              fileurl: pluginFile('Oculto.pdf'),
              filesize: 10,
              mimetype: 'application/pdf',
            },
          ],
        },
      ],
    },
    {
      id: 3,
      name: 'Tema 2: Determinantes',
      section: 3,
      visible: 1,
      modules: [
        {
          id: 17,
          name: 'Apuntes determinantes',
          modname: 'resource',
          url: `${MOCK_BASE}/mod/resource/view.php?id=17`,
          visible: 0,
          contents: [
            {
              type: 'file',
              filename: 'Determinantes.pdf',
              fileurl: pluginFile('Determinantes.pdf'),
              filesize: 4096,
              mimetype: 'application/pdf',
            },
          ],
        },
        {
          id: 18,
          name: 'Teoría de determinantes',
          modname: 'resource',
          url: `${MOCK_BASE}/mod/resource/view.php?id=18`,
          visible: 1,
          contents: [
            {
              type: 'file',
              filename: 'Teoria determinantes.pdf',
              fileurl: pluginFile('TeoriaDeterminantes.pdf'),
              filesize: 4096,
              mimetype: 'application/pdf',
            },
          ],
        },
      ],
    },
  ],
  102: [
    {
      id: 4,
      name: 'Tema 1: Cinemática',
      section: 1,
      visible: 1,
      modules: [
        {
          id: 21,
          name: 'Apuntes de cinemática',
          modname: 'resource',
          url: `${MOCK_BASE}/mod/resource/view.php?id=21`,
          visible: 1,
          contents: [
            {
              type: 'file',
              filename: 'Cinematica.pdf',
              fileurl: pluginFile('Cinematica.pdf'),
              filesize: 8192,
              mimetype: 'application/pdf',
            },
          ],
        },
      ],
    },
  ],
};

const ASSIGNMENTS = {
  courses: [
    {
      id: 101,
      fullname: 'Matemáticas I',
      shortname: 'MAT1',
      assignments: [
        {
          id: 9001,
          cmid: 55,
          name: 'Entrega Matrices',
          intro: '<p>Haz los <b>ejercicios</b> 1 y 2&nbsp;del tema.</p>',
          duedate: nowSeconds + 5 * day,
          grade: 100,
          nosubmissions: 0,
        },
      ],
    },
    {
      id: 102,
      fullname: 'Física y Química',
      shortname: 'FYQ1',
      assignments: [
        {
          id: 9002,
          cmid: 56,
          name: 'Problemas de cinemática',
          intro: 'Entrega los problemas 4, 5 y 6.',
          duedate: nowSeconds + 9 * day,
          grade: 100,
          nosubmissions: 0,
        },
        {
          id: 9003,
          cmid: 57,
          name: 'Trabajo de laboratorio',
          intro: 'Informe del péndulo.',
          duedate: nowSeconds + 14 * day,
          grade: 100,
          nosubmissions: 0,
        },
      ],
    },
  ],
};

const SUBMISSIONS = {
  assignments: [
    {
      assignmentid: 9001,
      submissions: [{ userid: USER_ID, status: 'submitted', graded: true, grade: 8.5 }],
    },
    { assignmentid: 9002, submissions: [{ userid: USER_ID, status: 'draft', graded: false }] },
    { assignmentid: 9003, submissions: [] },
  ],
};

const seenFunctions = [];
const pluginFileHits = [];
// Peticiones recibidas en /login/token.php. Se guarda el usuario y el servicio,
// NUNCA la contraseña: ni siquiera el simulador debe quedarse con ella.
const loginHits = [];

function send(res, code, body, contentType = 'application/json') {
  res.writeHead(code, { 'Content-Type': contentType });
  res.end(body);
}

function mockMoodle() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, MOCK_BASE);

    if (url.pathname === '/webservice/pluginfile.php' || url.pathname.includes('pluginfile.php')) {
      const fileName = decodeURIComponent(url.pathname.split('/').pop() || 'archivo');
      pluginFileHits.push({ fileName, token: url.searchParams.get('token') });

      if (url.searchParams.get('token') !== TOKEN) {
        return send(res, 403, 'Access denied: token inválido', 'text/plain');
      }
      if (fileName.startsWith('Denegado')) {
        return send(res, 403, 'Access denied', 'text/plain');
      }
      const body = fileContent(fileName);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(body.byteLength),
      });
      return res.end(body);
    }

    if (url.pathname.endsWith('/login/token.php')) {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        loginHits.push({ username: body.get('username'), service: body.get('service') });

        if (body.get('username') !== LOGIN_USER || body.get('password') !== LOGIN_PASSWORD) {
          return send(
            res,
            200,
            JSON.stringify({ error: 'Invalid login, please try again', errorcode: 'invalidlogin' })
          );
        }

        return send(res, 200, JSON.stringify({ token: TOKEN, privatetoken: 'privado-de-prueba' }));
      });
      return;
    }

    if (!url.pathname.endsWith('/webservice/rest/server.php')) {
      return send(res, 404, '{"errorcode":"notfound"}');
    }

    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = new URLSearchParams(raw);
      const wsfunction = body.get('wsfunction');
      const wstoken = body.get('wstoken');
      seenFunctions.push(wsfunction);

      if (wstoken !== TOKEN) {
        return send(res, 200, JSON.stringify({ errorcode: 'invalidtoken', message: 'Invalid token - token not found' }));
      }

      switch (wsfunction) {
        case 'core_webservice_get_site_info':
          return send(
            res,
            200,
            JSON.stringify({
              sitename: 'Moodle Instituto Demo',
              username: 'santiago',
              userid: USER_ID,
              release: '4.3.2',
              functions: REQUIRED_FUNCTIONS.map((name) => ({ name, version: '4.3' })),
            })
          );
        case 'core_enrol_get_users_courses':
          return send(
            res,
            200,
            JSON.stringify([
              { id: 101, fullname: 'Matemáticas I', shortname: 'MAT1' },
              { id: 102, fullname: 'Física y Química', shortname: 'FYQ1' },
            ])
          );
        case 'core_course_get_contents': {
          const courseId = Number(body.get('courseid'));
          return send(res, 200, JSON.stringify(COURSE_CONTENTS[courseId] ?? []));
        }
        case 'mod_assign_get_assignments': {
          const ids = [...body.keys()]
            .filter((key) => key.startsWith('courseids['))
            .map((key) => Number(body.get(key)));
          const courses = ASSIGNMENTS.courses.filter((course) => ids.includes(course.id));
          return send(res, 200, JSON.stringify({ courses }));
        }
        case 'mod_assign_get_submissions':
          return send(res, 200, JSON.stringify(SUBMISSIONS));
        default:
          return send(res, 200, JSON.stringify({ errorcode: 'accessexception', message: `Unknown function ${wsfunction}` }));
      }
    });
  });
}

function attackerServer(hits) {
  return http.createServer((req, res) => {
    hits.push(req.url);
    send(res, 200, 'datos robados', 'text/plain');
  });
}

// Un Moodle con los servicios web apagados: responde, pero se niega.
function moodleWithWebServicesOff() {
  return http.createServer((req, res) =>
    send(res, 200, JSON.stringify({ errorcode: 'wsaccessdisabled', message: 'Web services are disabled' }))
  );
}

// Un Moodle que deja entrar, pero con el servicio móvil sin habilitar: así la
// app puede distinguir «contraseña mala» de «este centro no tiene la vía
// activada» y decirle al alumno qué pedir.
function moodleWithMobileServiceOff() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/login/token.php')) {
      return send(
        res,
        200,
        JSON.stringify({ error: 'Web service is not available', errorcode: 'servicedisabled' })
      );
    }
    return send(res, 200, JSON.stringify({ errorcode: 'invalidtoken', message: 'Invalid token' }));
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `El puerto ${port} ya está ocupado (¿otra prueba o el modo --serve sigue abierto?). ` +
              'Cierra lo que lo esté usando o lanza de nuevo con MOODLE_MOCK_PORT=5050.'
          )
        );
        return;
      }
      reject(error);
    });
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

/* ------------------------------------------------------------------ */
/* Cliente de la app                                                   */
/* ------------------------------------------------------------------ */

async function post(pathname, body) {
  const res = await fetch(`${APP}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }
  return { status: res.status, data, raw };
}

async function del(pathname) {
  const res = await fetch(`${APP}${pathname}`, { method: 'DELETE' });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function getFile(id, query = '') {
  const res = await fetch(`${APP}/api/moodle/file/${id}${query}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buffer };
}

/* ------------------------------------------------------------------ */
/* Limpieza                                                            */
/* ------------------------------------------------------------------ */

async function wipeMockData() {
  const materials = await p.moodleMaterial.deleteMany({});
  const courses = await p.moodleCourse.deleteMany({});
  const tasks = await p.moodleTask.deleteMany({ where: { source: 'web_services' } });
  return { materials: materials.count, courses: courses.count, tasks: tasks.count };
}

// Copias locales descargadas durante la prueba.
async function removeCacheFiles(ids) {
  for (const id of ids) {
    try {
      for (const file of fs.readdirSync(CACHE_DIR)) {
        if (file.startsWith(`${id}-`)) fs.rmSync(path.join(CACHE_DIR, file), { force: true });
      }
    } catch {
      // Sin carpeta de caché: nada que borrar.
    }
  }
}

async function main() {
  // Modo servidor: deja el Moodle simulado en pie para probarlo a mano desde el
  // navegador (Ajustes → Moodle: apuntes y tareas). No toca la base ni el perfil.
  if (process.argv.includes('--serve')) {
    const mock = mockMoodle();
    await listen(mock, MOCK_PORT);
    console.log(`Moodle simulado escuchando en ${MOCK_BASE}`);
    console.log(`Dirección: ${MOCK_BASE}`);
    console.log(`Token:     ${TOKEN}`);
    console.log(`Usuario:   ${LOGIN_USER}`);
    console.log(`Contraseña: ${LOGIN_PASSWORD}   (solo para la vía «usuario y contraseña»)`);
    console.log('Pégalos en Ajustes → «Moodle: apuntes y tareas». Corta con Ctrl+C.');
    return;
  }

  const profile = await p.userProfile.findUnique({ where: { id: await getTestUserId() } });
  fs.writeFileSync(
    PROFILE_BACKUP,
    JSON.stringify({
      moodleBaseUrl: profile.moodleBaseUrl,
      moodleToken: profile.moodleToken,
      moodleSiteName: profile.moodleSiteName,
      moodleUserId: profile.moodleUserId,
      moodleConnectedAt: profile.moodleConnectedAt,
      lastMoodleSync: profile.lastMoodleSync,
    }),
    'utf8'
  );

  const appUp = await fetch(`${APP}/`).then((res) => res.ok).catch(() => false);
  if (!appUp) {
    console.log('✗ El servidor de desarrollo no responde en', APP);
    console.log('  Arranca «npm run dev» y vuelve a lanzar esta verificación.');
    process.exit(1);
  }

  // Las tareas que ya estaban por iCal se fotografían: si alguna se adopta
  // durante la prueba, hay que dejarla como estaba al terminar.
  const icalBefore = await p.moodleTask.findMany({ where: { source: 'ical' } });

  const swept = await wipeMockData();
  console.log(`Punto de partida limpio · ${swept.materials} apuntes, ${swept.courses} cursos y ${swept.tasks} tareas del mock borrados`);

  const mock = mockMoodle();
  await listen(mock, MOCK_PORT);
  const attackerHits = [];
  const attacker = attackerServer(attackerHits);
  await listen(attacker, ATTACKER_PORT);
  const wsOff = moodleWithWebServicesOff();
  await listen(wsOff, WS_OFF_PORT);
  const serviceOff = moodleWithMobileServiceOff();
  await listen(serviceOff, SERVICE_OFF_PORT);

  // Tarea previa por iCal, para comprobar que la sincronización la adopta.
  const icalTask = await p.moodleTask.create({
    data: {
      externalId: 'demo-adopt-lab',
      title: 'Trabajo de laboratorio',
      courseName: 'Física y Química',
      dueDate: new Date(Date.now() + 14 * day),
      source: 'ical',
    },
  });
  createdTaskIds.push(icalTask.id);

  try {
    /* 0. Diagnóstico sin token ------------------------------------- */
    console.log('\n0. Diagnóstico de la dirección ANTES de pedir la clave');
    const diagnose = async (baseUrl) => post('/api/moodle/diagnose', { baseUrl });

    const ready = await diagnose(MOCK_BASE);
    check(
      'Moodle con servicios web encendidos: lo dice y pide la clave',
      ready.status === 200 && ready.data?.diagnosis?.code === 'ready',
      ready.data?.diagnosis?.code
    );
    check(
      'Detecta que el servicio responde aunque no haya clave',
      ready.data?.diagnosis?.moodleError === 'invalidtoken',
      ready.data?.diagnosis?.moodleError
    );
    check(
      'Explica el siguiente paso con la ruta exacta',
      /Preferencias → Seguridad → «Claves de seguridad»/.test(ready.data?.diagnosis?.nextStep ?? '')
    );

    const off = await diagnose(`http://127.0.0.1:${WS_OFF_PORT}`);
    check(
      'Moodle con servicios web apagados: lo distingue del token malo',
      off.data?.diagnosis?.code === 'services_disabled',
      off.data?.diagnosis?.code
    );

    const notMoodle = await diagnose(`http://127.0.0.1:${ATTACKER_PORT}`);
    check(
      'Una dirección que no es un Moodle: lo dice claro',
      notMoodle.data?.diagnosis?.code === 'wrong_url',
      notMoodle.data?.diagnosis?.code
    );

    const dead = await diagnose(`http://127.0.0.1:${CLOSED_PORT}`);
    check(
      'Una dirección que no existe: avisa sin colgarse',
      dead.data?.diagnosis?.code === 'unreachable',
      dead.data?.diagnosis?.code
    );

    // Moodle Centros de verdad: ocho plataformas, una por provincia. Si no hay
    // internet o la Junta no responde, es un aviso, no un fallo.
    const centros = await diagnose('educacionadistancia.juntadeandalucia.es/centros/sevilla');
    const centrosDiagnosis = centros.data?.diagnosis;
    if (centrosDiagnosis?.code === 'ready' && centrosDiagnosis.centrosProvince === 'sevilla') {
      check('Reconoce Moodle Centros y su provincia', true, 'Sevilla · servicios web encendidos');
      check(
        'Y le dice al alumno de Centros qué hacer con la clave',
        /Claves de seguridad/.test(centrosDiagnosis.nextStep) && /profesor|coordinador TIC/.test(centrosDiagnosis.nextStep)
      );
    } else {
      console.log(`  ! Moodle Centros no comprobado en vivo (${centrosDiagnosis?.code ?? centros.status}). Es un aviso, no un fallo.`);
    }

    /* 1. Token incorrecto ------------------------------------------- */
    console.log('\n1. La conexión no acepta un token malo (ni pisa lo que ya había)');
    const badConnect = await post('/api/moodle/connect', { baseUrl: MOCK_BASE, token: 'token-que-no-vale' });
    check('Token inválido rechazado', badConnect.status !== 200, `HTTP ${badConnect.status}`);
    check(
      'El error se explica en español',
      typeof badConnect.data?.error === 'string' && /token/i.test(badConnect.data.error),
      badConnect.data?.error
    );
    const profileAfterBad = await p.userProfile.findUnique({ where: { id: await getTestUserId() } });
    check(
      'No se ha guardado nada al fallar',
      profileAfterBad.moodleToken === profile.moodleToken && profileAfterBad.moodleBaseUrl === profile.moodleBaseUrl
    );

    /* 1b. Usuario y contraseña: la vía fácil ----------------------- */
    console.log('\n1b. La vía fácil: el alumno pone su usuario y su contraseña');

    // Contraseña incorrecta: se rechaza y no se toca lo que ya había.
    const badPassword = await post('/api/moodle/connect', {
      baseUrl: MOCK_BASE,
      username: LOGIN_USER,
      password: 'esta-no-es-mi-contraseña',
    });
    check('Contraseña incorrecta rechazada', badPassword.status !== 200, `HTTP ${badPassword.status}`);
    check(
      'Se explica en español que el usuario o la contraseña no valen',
      typeof badPassword.data?.error === 'string' && /usuario o tu contraseña/i.test(badPassword.data.error),
      badPassword.data?.error
    );
    check('La contraseña mala no se cuela en la respuesta', !badPassword.raw.includes('esta-no-es-mi-contraseña'));
    const profileAfterBadPassword = await p.userProfile.findUnique({ where: { id: await getTestUserId() } });
    check(
      'Una contraseña mala no pisa el perfil guardado',
      profileAfterBadPassword.moodleToken === profile.moodleToken &&
        profileAfterBadPassword.moodleBaseUrl === profile.moodleBaseUrl
    );

    // Servicio móvil sin habilitar: se distingue de una contraseña mala.
    const serviceDisabled = await post('/api/moodle/connect', {
      baseUrl: `http://127.0.0.1:${SERVICE_OFF_PORT}`,
      username: LOGIN_USER,
      password: LOGIN_PASSWORD,
    });
    check(
      'Si el servicio móvil está apagado, lo dice con su nombre',
      serviceDisabled.status !== 200 && /servicio/i.test(serviceDisabled.data?.error ?? ''),
      serviceDisabled.data?.error
    );

    // El camino bueno: la app pide la clave a Moodle y la consigue.
    const byPassword = await post('/api/moodle/connect', {
      baseUrl: MOCK_BASE,
      username: LOGIN_USER,
      password: LOGIN_PASSWORD,
    });
    check('Conecta con usuario y contraseña', byPassword.status === 200 && byPassword.data?.ok === true, `HTTP ${byPassword.status}`);
    // El contrato de `via` cambió a propósito: dice por dónde se entra de verdad
    // —«token» (clave de Web Services, se haya pedido con la contraseña o pegada)
    // o «sesion» (entrando como el navegador)— y no por dónde se pidió.
    check('Dice por qué vía ha entrado', byPassword.data?.via === 'token', byPassword.data?.via);
    check('Dice el nombre del sitio y el usuario', byPassword.data?.site?.siteName === 'Moodle Instituto Demo' && byPassword.data?.site?.userName === 'santiago');
    check('La contraseña no aparece en la respuesta', !byPassword.raw.includes(LOGIN_PASSWORD));
    check('La clave obtenida tampoco aparece en la respuesta', !byPassword.raw.includes(TOKEN));
    check(
      'Moodle ha recibido la petición en login/token.php pidiendo el servicio móvil',
      loginHits.some((hit) => hit.username === LOGIN_USER && hit.service === 'moodle_mobile_app'),
      JSON.stringify(loginHits.slice(-2))
    );

    const profileByPassword = await p.userProfile.findUnique({ where: { id: await getTestUserId() } });
    check('La clave conseguida sí se guarda (para usarla desde el servidor)', profileByPassword.moodleToken === TOKEN);
    check(
      'La contraseña no se guarda en ningún campo del perfil',
      !JSON.stringify(profileByPassword).includes(LOGIN_PASSWORD) && !('password' in profileByPassword)
    );

    /* 2. Conexión buena -------------------------------------------- */
    console.log('\n2. Conexión real: dirección + token de Web Services');
    const connect = await post('/api/moodle/connect', { baseUrl: `${MOCK_BASE}/webservice/rest/server.php`, token: TOKEN });
    check('Conecta con el sitio', connect.status === 200 && connect.data?.ok === true, `HTTP ${connect.status}`);
    check('Dice el nombre del sitio y el usuario', connect.data?.site?.siteName === 'Moodle Instituto Demo' && connect.data?.site?.userName === 'santiago');
    check('El token no aparece en la respuesta al navegador', !connect.raw.includes(TOKEN));
    check(
      'Normaliza la dirección pegada entera',
      connect.data?.status?.baseUrl === MOCK_BASE,
      connect.data?.status?.baseUrl
    );

    const profileConnected = await p.userProfile.findUnique({ where: { id: await getTestUserId() } });
    check('El token se queda en la base local (para usarlo desde el servidor)', profileConnected.moodleToken === TOKEN);
    check('Guarda tu id de usuario de Moodle', profileConnected.moodleUserId === USER_ID);

    /* 3. Sincronización de apuntes y tareas ------------------------ */
    console.log('\n3. Sincronización: apuntes por tema y tareas con su estado');
    const sync = await post('/api/moodle/ws-sync');
    check('La sincronización responde', sync.status === 200 && sync.data?.ok === true, `HTTP ${sync.status}`);
    const stats = sync.data?.stats;
    check('Dos cursos leídos', stats?.courses === 2, `cursos: ${stats?.courses}`);
    check('Tres tareas leídas', stats?.tasks === 3, `tareas: ${stats?.tasks}`);
    check('Una tarea marcada como entregada', stats?.submitted === 1, `entregadas: ${stats?.submitted}`);
    check('Un curso emparejado con tu temario', stats?.linkedSubjects >= 1, `emparejados: ${stats?.linkedSubjects}`);

    const materials = await p.moodleMaterial.findMany({ include: { course: true } });
    const names = materials.map((material) => material.name).sort();
    createdMaterialIds.push(...materials.map((material) => material.id));

    check('Los apuntes quedan indexados', materials.length === 7, `${materials.length} apuntes: ${names.join(', ')}`);
    check('La sección oculta no entra', !names.includes('Oculto.pdf'));
    check('El módulo oculto no entra', !names.includes('Determinantes.pdf'));
    check('La tarea no se cuela como apunte', !names.includes('Entrega Matrices'));
    check('Los archivos de carpeta entran uno a uno', names.includes('Ejercicios 1.pdf') && names.includes('Ejercicios 2.pdf'));
    check('Los enlaces y páginas entran sin archivo', materials.some((m) => m.moduleType === 'url' && !m.downloadUrl) && materials.some((m) => m.moduleType === 'page'));
    check('El tema (sección) se guarda en cada apunte', materials.every((m) => m.sectionName.length > 0));
    check('Ningún enlace guardado lleva el token dentro', materials.every((m) => !/token=/.test(m.downloadUrl ?? '')));
    check(
      'Cada apunte cuelga de su curso de Moodle',
      materials.every((m) => ['Matemáticas I', 'Física y Química'].includes(m.course.fullName))
    );

    const courses = await p.moodleCourse.findMany();
    createdCourseIds.push(...courses.map((course) => course.id));
    check('Los cursos quedan guardados', courses.length === 2);

    const tasks = await p.moodleTask.findMany({ where: { source: 'web_services' } });
    const matrices = tasks.find((task) => task.assignmentId === 9001);
    const cinematica = tasks.find((task) => task.assignmentId === 9002);
    check('Las tareas de Moodle están en la base', tasks.length === 3, `${tasks.length} tareas`);
    check('Se sabe que una ya está entregada', matrices?.submitted === true);
    check('Se sabe que otra sigue sin entregar', cinematica?.submitted === false);
    check('La descripción del enunciado llega en texto limpio', /ejercicios 1 y 2 del tema/i.test(matrices?.description ?? ''), matrices?.description);
    check('Cada tarea tiene su enlace a Moodle', /\/mod\/assign\/view\.php\?id=/.test(matrices?.moodleUrl ?? ''));
    check(
      'La tarea del calendario se ha adoptado, no duplicado',
      stats?.adoptedFromCalendar === 1 &&
        (await p.moodleTask.count({ where: { assignmentId: 9003 } })) === 1
    );
    const adopted = await p.moodleTask.findUnique({ where: { id: icalTask.id } });
    check('La tarea adoptada conserva su origen iCal como identificador', adopted?.assignmentId === 9003 && adopted?.source === 'web_services');

    /* 4. Idempotencia --------------------------------------------- */
    console.log('\n4. Sincronizar otra vez no duplica nada');
    await post('/api/moodle/ws-sync');
    const materials2 = await p.moodleMaterial.count();
    const tasks2 = await p.moodleTask.count({ where: { source: 'web_services' } });
    check('Los apuntes siguen siendo los mismos', materials2 === materials.length, `${materials2} apuntes`);
    check('Las tareas siguen siendo las mismas', tasks2 === 3, `${tasks2} tareas`);

    /* 5. Descarga de un apunte ------------------------------------ */
    console.log('\n5. Los apuntes se descargan con el token puesto en el servidor');
    const matricesMaterial = materials.find((material) => material.name === 'Tema 1 - Matrices.pdf');
    const first = await getFile(matricesMaterial.id);
    check('El archivo llega', first.status === 200 && first.buffer.subarray(0, 4).toString() === '%PDF', `HTTP ${first.status}`);
    check('Se sirve como PDF legible, no como descarga ciega', (first.headers.get('content-type') ?? '').includes('application/pdf') && (first.headers.get('content-disposition') ?? '').startsWith('inline'));
    check(
      'Moodle ha recibido el token en la petición del archivo',
      pluginFileHits.some((hit) => hit.fileName === 'Matrices.pdf' && hit.token === TOKEN)
    );
    const cached = await p.moodleMaterial.findUnique({ where: { id: matricesMaterial.id } });
    check('Queda una copia local en data/moodle', Boolean(cached.localPath) && fs.existsSync(path.join(process.cwd(), cached.localPath)), cached.localPath);

    const download = await getFile(matricesMaterial.id, '?download=1');
    check('Con ?download=1 se fuerza la descarga', (download.headers.get('content-disposition') ?? '').startsWith('attachment'));

    await close(mock);
    const offline = await getFile(matricesMaterial.id);
    check('Sin conexión al Moodle, el apunte sigue abriéndose (copia local)', offline.status === 200 && offline.buffer.equals(first.buffer));
    await listen(mock, MOCK_PORT);

    /* 6. El token no sale del Moodle conectado --------------------- */
    console.log('\n6. El token no viaja a otros dominios');
    const foreign = await p.moodleMaterial.create({
      data: {
        externalId: 'ataque:1',
        courseId: courses[0].id,
        sectionName: 'Ataque',
        name: 'Ataque.pdf',
        moduleType: 'resource',
        downloadUrl: `http://127.0.0.1:${ATTACKER_PORT}/webservice/pluginfile.php/1/x/Ataque.pdf`,
      },
    });
    createdMaterialIds.push(foreign.id);
    // Cuenta desde aquí: el diagnóstico de una dirección SÍ contacta con ella a
    // propósito, así que lo que importa es que descargar un archivo no lo haga.
    const hitsBefore = attackerHits.length;
    const attack = await getFile(foreign.id);
    const newHits = attackerHits.length - hitsBefore;
    check('Un archivo de otro dominio se rechaza', attack.status >= 400, `HTTP ${attack.status}`);
    check('Y no se llega a pedir el archivo (cero peticiones nuevas al otro servidor)', newHits === 0, `${newHits} peticiones`);

    const denied = await p.moodleMaterial.create({
      data: {
        externalId: 'denegado:1',
        courseId: courses[0].id,
        sectionName: 'Denegado',
        name: 'Denegado.pdf',
        moduleType: 'resource',
        downloadUrl: `${MOCK_BASE}/webservice/pluginfile.php/1/mod_resource/content/0/Denegado.pdf`,
      },
    });
    createdMaterialIds.push(denied.id);
    const deniedRes = await getFile(denied.id);
    check('Si Moodle niega el archivo, se explica (no se finge éxito)', deniedRes.status === 502 && /403/.test(JSON.parse(deniedRes.buffer.toString()).error ?? ''), `HTTP ${deniedRes.status}`);

    /* 7. Desconectar ---------------------------------------------- */
    console.log('\n7. Desconectar borra el token');
    const disconnected = await del('/api/moodle/connect');
    check('La desconexión responde', disconnected.status === 200 && disconnected.data?.ok === true);
    const profileOut = await p.userProfile.findUnique({ where: { id: await getTestUserId() } });
    check('El token desaparece de la base', !profileOut.moodleToken && !profileOut.moodleBaseUrl);
    const noToken = await p.moodleMaterial.create({
      data: {
        externalId: 'sintoken:1',
        courseId: courses[0].id,
        sectionName: 'Sin token',
        name: 'SinToken.pdf',
        moduleType: 'resource',
        downloadUrl: `${MOCK_BASE}/webservice/pluginfile.php/1/mod_resource/content/0/SinToken.pdf`,
      },
    });
    createdMaterialIds.push(noToken.id);
    const withoutConnection = await getFile(noToken.id);
    check('Sin conectar, avisa en vez de fallar en silencio', withoutConnection.status === 400, `HTTP ${withoutConnection.status}`);
  } finally {
    await close(mock).catch(() => {});
    await close(attacker).catch(() => {});
    await close(wsOff).catch(() => {});
    await close(serviceOff).catch(() => {});
  }

  console.log('\n8. Limpieza');
  if (keep) {
    console.log('  ! Se dejan los datos del mock (--keep). Recuerda restaurar el perfil a mano.');
  } else {
    await removeCacheFiles(createdMaterialIds);
    await wipeMockData();
    await p.moodleTask.deleteMany({ where: { id: { in: createdTaskIds } } });
    for (const task of icalBefore) {
      await p.moodleTask.update({
        where: { id: task.id },
        data: {
          source: task.source,
          assignmentId: task.assignmentId,
          submitted: task.submitted,
          graded: task.graded,
          grade: task.grade,
          description: task.description,
          moodleUrl: task.moodleUrl,
          dueDate: task.dueDate,
        },
      });
    }
    await p.userProfile.update({
      where: { id: await getTestUserId() },
      data: JSON.parse(fs.readFileSync(PROFILE_BACKUP, 'utf8')),
    });
    const left = await Promise.all([p.moodleMaterial.count(), p.moodleCourse.count(), p.moodleTask.count()]);
    console.log(`  ✓ Limpio: ${left[0]} apuntes, ${left[1]} cursos, ${left[2]} tareas · perfil restaurado desde ${PROFILE_BACKUP}`);
  }

  console.log('\n==========================================');
  if (failures === 0) {
    console.log(`TODO EN VERDE · ${seenFunctions.length} llamadas a Moodle verificadas`);
  } else {
    console.log(`FALLOS: ${failures}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('FALLO:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await p.$disconnect();
  });
