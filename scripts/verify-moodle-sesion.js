/**
 * Verificación del acceso a Moodle **por sesión web** (sin clave de Web Services).
 *
 * Es la vía que hace falta cuando el centro no deja crear claves al alumnado: la
 * app entra con el usuario y la contraseña de siempre, como el navegador.
 *
 * Parte **offline** (siempre, sin red ni base de datos): compila los módulos y
 * comprueba el parseo contra HTML con la forma real de Moodle (formulario de
 * acceso, área personal, «Mis cursos», una página de curso de Moodle 4 y la
 * página de un recurso). Es el sitio donde de verdad se rompen estas cosas:
 * nombres con «Archivo» pegado, fechas en español, cursos repetidos en la portada
 * y archivos con `token=` en la URL.
 *
 * Parte **viva** (`--live`): se levanta un Moodle de mentira en `127.0.0.1` que
 * se comporta como el de verdad (formulario con `logintoken`, cookie de sesión,
 * 303 al área personal, error visible si la contraseña no es) y se entra en él
 * **por HTTP de verdad**: login, cookies, lista de cursos, página de curso,
 * recursos y tareas. Además se prueba contra la base local el cifrado de la
 * contraseña (que no se pueda leer en claro) y el guardado de cursos y tareas sin
 * duplicar. Todo lo que toca la base se borra al terminar.
 *
 * Uso:
 *   node scripts/verify-moodle-sesion.js           → lo offline (gratis, sin red)
 *   node scripts/verify-moodle-sesion.js --live    → además, el camino completo
 */

const path = require('path');
const { getTestUserId } = require('./testUser.js');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-moodle-sesion');
const LIVE = process.argv.includes('--live');

let failures = 0;
const failed = [];

function section(title) {
  console.log(`\n${title}`);
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  \u001b[32m✓\u001b[0m ${label}${detail ? ` · ${detail}` : ''}`);
  } else {
    failures += 1;
    failed.push(label);
    console.log(`  \u001b[31m✗\u001b[0m ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

function loadEnv() {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const value = match[2].replace(/^['"]|['"]$/g, '').trim();
    if (value && !process.env[match[1]]) process.env[match[1]] = value;
  }
}

/** Transpila los módulos de la vía de sesión a un directorio temporal. */
function compile() {
  fs.rmSync(outDir, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      path.join('src', 'lib', 'moodleSession.ts'),
      path.join('src', 'lib', 'moodleAuth.ts'),
      path.join('src', 'lib', 'moodleStore.ts'),
      path.join('src', 'lib', 'moodleWsSync.ts'),
      path.join('src', 'lib', 'moodleSelfHeal.ts'),
      path.join('src', 'lib', 'moodleSync.ts'),
      '--outDir',
      '.tmp-verify-moodle-sesion',
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--moduleResolution',
      'node',
      '--skipLibCheck',
      '--esModuleInterop',
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  );
}

/* ------------------------------------------------------------------ */
/* HTML con la forma real de Moodle                                    */
/* ------------------------------------------------------------------ */

function loginPage(base, token) {
  return `<!DOCTYPE html><html lang="es"><head><title>Acceso al sitio | Moodle de prueba</title></head><body>
<div class="loginbox clearfix">
  <div class="loginpanel"><h2>¿Alguien nuevo por aquí?</h2></div>
  <div class="signuppanel">
    <form class="mform" id="login" action="${base}/login/index.php" method="post">
      <input type="hidden" name="logintoken" value="${token}">
      <input type="hidden" name="anchor" value="">
      <div class="form-group"><label for="username">Nombre de usuario</label>
        <input type="text" name="username" id="username" value=""></div>
      <div class="form-group"><label for="password">Contraseña</label>
        <input type="password" name="password" id="password" value=""></div>
      <button type="submit" id="loginbtn">Acceder</button>
    </form>
  </div>
</div>
</body></html>`;
}

function loginErrorPage(base, token) {
  return `<!DOCTYPE html><html lang="es"><head><title>Acceso al sitio | Moodle de prueba</title></head><body>
<div class="loginbox">
  <div class="loginerrors" id="loginerrormessage">Usuario o contraseña incorrectos.</div>
  <form class="mform" id="login" action="${base}/login/index.php" method="post">
    <input type="hidden" name="logintoken" value="${token}">
    <input type="text" name="username" id="username">
    <input type="password" name="password" id="password">
  </form>
</div>
</body></html>`;
}

function dashboardPage(base) {
  return `<!DOCTYPE html><html lang="es"><head><title>Área personal | Moodle de prueba</title></head><body>
<nav class="navbar">
  <div data-userid="42"></div>
  <a href="${base}/user/profile.php?id=42" class="usertext">María Ojeda</a>
  <a href="${base}/login/logout.php?sesskey=AbC123" class="dropdown-item">Salir</a>
</nav>
<div class="block-myoverview"><h2>Mis cursos</h2></div>
</body></html>`;
}

/**
 * Un Moodle que entra con el acceso único del centro: no hay formulario con
 * usuario y contraseña, así que la vía de sesión no puede usarse y hay que decirlo.
 */
function ssoPage(base) {
  return `<!DOCTYPE html><html lang="es"><head><title>Acceso | Moodle de prueba</title></head><body>
<div class="loginbox"><h2>Entra con tu cuenta del centro</h2>
  <a class="btn" href="https://sso.micentro.es/login?from=${base}">Entrar con Google</a>
</div>
</body></html>`;
}

function coursesPage(base) {
  return `<!DOCTYPE html><html lang="es"><head><title>Mis cursos | Moodle de prueba</title></head><body>
<div data-userid="42"></div><a href="${base}/login/logout.php">Salir</a>
<div class="card mb-3">
  <a class="aalink" href="${base}/course/view.php?id=101">Filosofía</a>
</div>
<div class="card mb-3">
  <a class="aalink" href="${base}/course/view.php?id=101">Filosofía (1º de Bachillerato)</a>
</div>
<div class="card mb-3">
  <a class="aalink" href="${base}/course/view.php?id=102">Matemáticas II</a>
</div>
<div class="card mb-3">
  <a class="aalink" href="${base}/course/view.php?id=1">Área personal</a>
</div>
</body></html>`;
}

function coursePage(base, id = 101) {
  if (id === 102) {
    return `<!DOCTYPE html><html lang="es"><head><title>Matemáticas II | Moodle de prueba</title></head><body>
<div data-userid="42"></div><a href="${base}/login/logout.php">Salir</a>
<ul class="course-content">
  <li id="section-0" class="section course-section main" data-sectionid="0">
    <h3 class="sectionname">Tema 1: Límites</h3>
    <ul class="section img-text">
      <li class="activity resource modtype_resource" id="module-601">
        <a class="aalink" href="${base}/mod/resource/view.php?id=601"><span class="instancename">Ejercicios de límites</span></a>
      </li>
      <li class="activity assign modtype_assign" id="module-888">
        <a class="aalink" href="${base}/mod/assign/view.php?id=888"><span class="instancename">Hoja de límites</span></a>
        <div class="activity-dates"><div>Vence: martes, 3 de noviembre de 2026, 22:00</div></div>
      </li>
    </ul>
  </li>
</ul>
</body></html>`;
  }

  return `<!DOCTYPE html><html lang="es"><head><title>Filosofía (1º de Bachillerato) | Moodle de prueba</title></head><body>
<div data-userid="42"></div><a href="${base}/login/logout.php">Salir</a>
<ul class="course-content">
  <li id="section-0" class="section course-section main" data-sectionid="0">
    <h3 class="sectionname">General</h3>
    <ul class="section img-text">
      <li class="activity forum modtype_forum" id="module-500">
        <a class="aalink" href="${base}/mod/forum/view.php?id=500"><span class="instancename">Tablón de anuncios</span></a>
      </li>
    </ul>
  </li>
  <li id="section-1" class="section course-section main" data-sectionid="1">
    <h3 class="sectionname">Tema 1: El saber filosófico</h3>
    <ul class="section img-text">
      <li class="activity resource modtype_resource" id="module-555">
        <span class="activityiconcontainer"><img class="activityicon" alt="Archivo"></span>
        <a class="aalink" href="${base}/mod/resource/view.php?id=555"><span class="instancename">Apuntes del tema 1<span class="accesshide">Archivo</span></span></a>
      </li>
      <li class="activity folder modtype_folder" id="module-556">
        <a class="aalink" href="${base}/mod/folder/view.php?id=556"><span class="instancename">Textos para comentar</span></a>
      </li>
      <li class="activity assign modtype_assign" id="module-777">
        <a class="aalink" href="${base}/mod/assign/view.php?id=777"><span class="instancename">Comentario de texto</span></a>
        <div class="activity-dates">
          <div>Apertura: lunes, 20 de octubre de 2026, 00:00</div>
          <div>Vence: <strong>viernes, 24 de octubre de 2026, 23:59</strong></div>
        </div>
        <span class="text-success">Entregado</span>
      </li>
    </ul>
  </li>
  <li id="section-2" class="section course-section main" data-sectionid="2">
    <h3 class="sectionname">Tema 2: La metafísica</h3>
    <ul class="section img-text">
      <li class="activity assign modtype_assign" id="module-778">
        <a class="aalink" href="${base}/mod/assign/view.php?id=778"><span class="instancename">Disertación sobre el ser</span></a>
        <div class="activity-dates"><div>Vence: 30/10/2026, 23:59</div></div>
        <span class="text-danger">Sin entregar</span>
      </li>
    </ul>
  </li>
</ul>
</body></html>`;
}

function resourcePage(base) {
  return `<!DOCTYPE html><html lang="es"><head><title>Apuntes del tema 1 | Moodle de prueba</title></head><body>
<div data-userid="42"></div>
<div class="resourcecontent resourcepdf">
  <object data="${base}/pluginfile.php/123456/mod_resource/content/1/apuntes-tema-1.pdf" type="application/pdf"></object>
</div>
<div class="resourceworkaround">
  <a href="${base}/pluginfile.php/123456/mod_resource/content/1/apuntes-tema-1.pdf?forcedownload=1" class="btn">Descargar</a>
</div>
</body></html>`;
}

function folderPage(base) {
  return `<!DOCTYPE html><html lang="es"><head><title>Textos para comentar | Moodle de prueba</title></head><body>
<div data-userid="42"></div>
<div class="foldertree">
  <div class="file"><a href="${base}/pluginfile.php/999/mod_folder/content/0/Plat%C3%B3n%20-%20Rep%C3%BAblica.txt?forcedownload=1">Platón - República.txt</a></div>
</div>
</body></html>`;
}

function urlPage(base) {
  return `<!DOCTYPE html><html lang="es"><head><title>Un enlace | Moodle de prueba</title></head><body>
<div data-userid="42"></div>
<div class="urlworkaround"><a class="urlworkaround" href="https://es.wikipedia.org/wiki/Filosof%C3%ADa">Wikipedia</a></div>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* El Moodle de mentira                                                */
/* ------------------------------------------------------------------ */

const USER = 'maria.ojeda';
const PASS = 'UnaClaveMuySecreta-2026';
const LOGIN_TOKEN = 'LogintokenDePrueba123';

function startFakeMoodle() {
  const seen = [];
  let cookieIssued = null;
  let loggedInCookie = null;
  let loginToken = LOGIN_TOKEN;

  const server = http.createServer((request, response) => {
    const url = request.url || '/';
    const cookie = request.headers.cookie || '';
    seen.push({ url, cookie, host: request.headers.host });

    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
      response.end(body);
    };

    let base = `http://${request.headers.host}`;

    // Un sitio con acceso único del centro: su /login/index.php no trae formulario.
    if (url.startsWith('/sso')) {
      return send(200, ssoPage(base));
    }

    // Este centro no tiene habilitado el servicio móvil: por aquí no hay clave.
    if (url.startsWith('/login/token.php')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ errorcode: 'servicedisabled', message: 'Web services are not enabled' }));
      return;
    }

    if (url.startsWith('/login/index.php')) {
      if (request.method === 'POST') {
        let raw = '';
        request.on('data', (chunk) => {
          raw += chunk;
        });
        request.on('end', () => {
          const params = new URLSearchParams(raw);
          const ok =
            params.get('logintoken') === loginToken &&
            params.get('username') === USER &&
            params.get('password') === PASS;

          if (!ok) {
            loginToken = `${LOGIN_TOKEN}-2`;
            send(200, loginErrorPage(base, loginToken));
            return;
          }

          loggedInCookie = 'MoodleSessionSesionBuena';
          send(303, '', {
            Location: `${base}/my/`,
            'Set-Cookie': `MoodleSession=${loggedInCookie}; path=/; HttpOnly`,
          });
        });
        return;
      }

      cookieIssued = 'MoodleSessionPrevia';
      send(200, loginPage(base, loginToken), {
        'Set-Cookie': `MoodleSession=${cookieIssued}; path=/; HttpOnly`,
      });
      return;
    }

    const authenticated = cookie.includes('MoodleSessionSesionBuena');

    if (url.startsWith('/my/courses.php')) {
      if (!authenticated) return send(200, loginPage(base, loginToken));
      return send(200, coursesPage(base));
    }

    if (url.startsWith('/my/')) {
      if (!authenticated) return send(200, loginPage(base, loginToken));
      return send(200, dashboardPage(base));
    }

    if (url.startsWith('/course/view.php')) {
      if (!authenticated) return send(200, loginPage(base, loginToken));
      const id = Number(new URL(url, base).searchParams.get('id') || 101);
      return send(200, coursePage(base, id));
    }

    if (url.startsWith('/mod/resource/view.php')) {
      if (!authenticated) return send(200, loginPage(base, loginToken));
      return send(200, resourcePage(base));
    }

    if (url.startsWith('/mod/folder/view.php')) {
      if (!authenticated) return send(200, loginPage(base, loginToken));
      return send(200, folderPage(base));
    }

    if (url.startsWith('/mod/url/view.php')) {
      if (!authenticated) return send(200, loginPage(base, loginToken));
      return send(200, urlPage(base));
    }

    if (url.startsWith('/login/logout.php')) {
      loggedInCookie = null;
      return send(200, loginPage(base, loginToken));
    }

    send(404, '<html><body>No encontrado</body></html>');
  });

  return {
    server,
    seen,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ------------------------------------------------------------------ */
/* Programa                                                            */
/* ------------------------------------------------------------------ */

(async () => {
  console.log('Verificación de Moodle por sesión web (sin clave de Web Services)');

  compile();
  const S = require(path.join(outDir, 'moodleSession.js'));

  const BASE = 'https://moodle.micentro.es';

  /* ---------------- 1. El formulario de acceso ---------------- */
  section('1 · El formulario de acceso: sacar el logintoken y entender la respuesta');
  {
    const page = loginPage(BASE, 'TokenReal123');
    check('El logintoken se saca del formulario', S.extractLogintoken(page) === 'TokenReal123');
    check(
      'Y también cuando el tema pone value antes que name',
      S.extractLogintoken('<input value="OtroToken" name="logintoken" type="hidden">') === 'OtroToken'
    );
    check('Sin campo oculto no se inventa nada', S.extractLogintoken('<form></form>') === null);

    check('Una página de acceso NO parece una sesión abierta', S.looksLoggedIn(page) === false);
    check('El área personal SÍ', S.looksLoggedIn(dashboardPage(BASE)) === true);

    const error = S.detectLoginError(loginErrorPage(BASE, 'x'));
    check('El aviso de Moodle se lee tal cual', error === 'Usuario o contraseña incorrectos.', String(error));
    check('Y una página limpia no da error', S.detectLoginError(page) === null);
    check(
      'Sin caja de error, el texto de contraseña incorrecta también vale',
      typeof S.detectLoginError('<html><body>Invalid login, please try again</body></html>') === 'string'
    );
  }

  /* ---------------- 2. El sitio y la persona ---------------- */
  section('2 · Saber en qué sitio y con quién se ha entrado');
  {
    const dashboard = dashboardPage(BASE);
    check('El nombre del sitio sale del título', S.parseSiteName(dashboard) === 'Moodle de prueba', String(S.parseSiteName(dashboard)));
    check('El nombre de la persona sale del menú de usuario', S.parseUserName(dashboard) === 'María Ojeda', String(S.parseUserName(dashboard)));
    check('Y el id del usuario, de la propia página', S.parseUserId(dashboard) === 42);

    check(
      'El ruido de lectores de pantalla («Archivo») no se cuela en los nombres',
      S.stripScreenReaderNoise('<span class="instancename">Apuntes<span class="accesshide">Archivo</span></span>')
        .replace(/<[^>]*>/g, '')
        .trim() === 'Apuntes'
    );
  }

  /* ---------------- 3. Mis cursos ---------------- */
  section('3 · Mis cursos: sin duplicados y sin la portada');
  {
    const courses = S.parseCoursesFromHtml(coursesPage(BASE), BASE);
    check('Se ven los dos cursos del alumno', courses.length === 2, courses.map((c) => c.fullName).join(' · '));
    check(
      'El curso repetido se queda una vez y con el nombre completo',
      courses.filter((c) => c.moodleId === 101)[0]?.fullName === 'Filosofía (1º de Bachillerato)',
      courses.filter((c) => c.moodleId === 101)[0]?.fullName
    );
    check('La portada del sitio (id 1) no es un curso suyo', courses.every((c) => c.moodleId !== 1));
    check('El segundo curso entra con su id', courses.some((c) => c.moodleId === 102 && c.fullName === 'Matemáticas II'));
  }

  /* ---------------- 4. La página de un curso ---------------- */
  section('4 · La página de un curso: temas, recursos y tareas');
  {
    const parsed = S.parseCoursePage(coursePage(BASE), BASE);
    check('Se cuentan los tres temas', parsed.sections === 3, `${parsed.sections} sección(es)`);

    const pdf = parsed.materials.find((m) => m.name === 'Apuntes del tema 1');
    check('El recurso entra en el índice con su sección', Boolean(pdf) && pdf.sectionName === 'Tema 1: El saber filosófico', pdf ? `${pdf.name} · ${pdf.sectionName}` : 'no está');
    check(
      'Y el ruido de lector de pantalla no se le pega al nombre',
      Boolean(pdf) && !/archivo/i.test(pdf.name),
      pdf ? pdf.name : 'no está'
    );
    check(
      'La carpeta se indexa con su enlace (el archivo se busca en su página)',
      parsed.materials.some((m) => m.moduleType === 'folder' && /mod\/folder\/view\.php/.test(m.webUrl ?? '')),
      parsed.materials.map((m) => m.moduleType).join(',')
    );
    check(
      'Una tarea o un foro no se cuelan como apunte',
      parsed.materials.every((m) => !['assign', 'forum'].includes(m.moduleType)),
      parsed.materials.map((m) => m.moduleType).join(',')
    );

    const tarea = parsed.assignments.find((a) => a.title === 'Comentario de texto');
    check('La tarea se lee con su fecha de entrega en español', Boolean(tarea?.dueDate), tarea?.dueDate ? tarea.dueDate.toISOString() : 'sin fecha');
    check(
      'La fecha es la correcta (viernes 24 de octubre de 2026, 23:59)',
      Boolean(tarea?.dueDate) &&
        tarea.dueDate.getFullYear() === 2026 &&
        tarea.dueDate.getMonth() === 9 &&
        tarea.dueDate.getDate() === 24 &&
        tarea.dueDate.getHours() === 23 &&
        tarea.dueDate.getMinutes() === 59,
      tarea?.dueDate ? tarea.dueDate.toString() : 'sin fecha'
    );
    check('Y se sabe que ya está entregada', tarea?.submitted === true);

    const otra = parsed.assignments.find((a) => a.title === 'Disertación sobre el ser');
    check('Una fecha en formato 30/10/2026 también se entiende', Boolean(otra?.dueDate) && otra.dueDate.getDate() === 30);
    check('Y la que no está entregada se marca como tal', otra?.submitted === false);
  }

  /* ---------------- 5. La página de un recurso ---------------- */
  section('5 · La página del recurso: el archivo de verdad');
  {
    const files = S.parseResourcePage(resourcePage(BASE), BASE, {
      cmid: 555,
      modname: 'resource',
      sectionName: 'Tema 1: El saber filosófico',
      fallbackName: 'Apuntes del tema 1',
    });
    check('Se saca el archivo', files.length === 1, `${files.length} archivo(s)`);
    check(
      'Con el nombre del archivo, no el texto del botón',
      files[0]?.name === 'apuntes-tema-1.pdf',
      files[0]?.name
    );
    check(
      'Y el enlace queda sin ningún token en la URL',
      Boolean(files[0]?.downloadUrl) && !/token=/i.test(files[0].downloadUrl),
      files[0]?.downloadUrl
    );

    const folder = S.parseResourcePage(folderPage(BASE), BASE, {
      cmid: 556,
      modname: 'folder',
      sectionName: 'Tema 1: El saber filosófico',
      fallbackName: 'Textos para comentar',
    });
    check(
      'Una carpeta trae sus archivos con el nombre decodificado',
      folder.length === 1 && folder[0].name === 'Platón - República.txt',
      folder.map((f) => f.name).join(', ')
    );

    const link = S.parseResourcePage(urlPage(BASE), BASE, {
      cmid: 557,
      modname: 'url',
      sectionName: 'Tema 1',
      fallbackName: 'Un enlace',
    });
    check(
      'Un recurso de tipo enlace guarda su enlace externo',
      link.length === 1 && /^https?:\/\//.test(link[0].downloadUrl ?? ''),
      link[0]?.downloadUrl
    );
  }

  /* ---------------- 6. Fechas de Moodle ---------------- */
  section('6 · Fechas de Moodle: entenderlas o no inventarlas');
  {
    const cases = [
      ['viernes, 24 de octubre de 2026, 23:59', [2026, 9, 24, 23, 59]],
      ['24 de octubre de 2026', [2026, 9, 24, 23, 59]],
      ['24 octubre 2026, 10:00', [2026, 9, 24, 10, 0]],
      ['30/10/2026, 23:59', [2026, 9, 30, 23, 59]],
      ['2-11-2026', [2026, 10, 2, 23, 59]],
      ['Friday, 24 October 2026, 11:00 PM', [2026, 9, 24, 11, 0]],
    ];

    for (const [text, expected] of cases) {
      const date = S.parseMoodleHumanDate(text);
      const got = date
        ? [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()]
        : null;
      check(`«${text}» → fecha de verdad`, JSON.stringify(got) === JSON.stringify(expected), got ? got.join('-') : 'null');
    }

    check('Un texto sin fecha no se inventa una', S.parseMoodleHumanDate('sin fecha límite') === null);
    check('Y el vacío tampoco', S.parseMoodleHumanDate('') === null);
  }

  /* ---------------- 7. Entrar de verdad en un Moodle ---------------- */
  if (!LIVE) {
    console.log('\n  (la parte viva —login HTTP, cookies, base de datos— se lanza con --live)');
  } else {
    loadEnv();
    const { prisma } = require(path.join(outDir, 'prisma.js'));
    const A = require(path.join(outDir, 'moodleAuth.js'));
    const Store = require(path.join(outDir, 'moodleStore.js'));
    const Sync = require(path.join(outDir, 'moodleWsSync.js'));
    const Heal = require(path.join(outDir, 'moodleSelfHeal.js'));
    const Live = require(path.join(outDir, 'moodleSync.js'));

    const ID = await getTestUserId();
    const before = await prisma.userProfile.findUnique({ where: { id: ID } });
    const countsBefore = {
      cursos: await prisma.moodleCourse.count(),
      apuntes: await prisma.moodleMaterial.count(),
      tareas: await prisma.moodleTask.count(),
    };

    const fake = startFakeMoodle();
    const base = await fake.listen();

    try {
      section('7 · Entrar en un Moodle de verdad (de mentira, pero por HTTP)');
      const session = await S.loginToMoodle({ baseUrl: base, username: USER, password: PASS });

      check('Se abre la sesión con el usuario y la contraseña', Boolean(session.cookieHeader), session.cookieHeader.slice(0, 30));
      check('Se sabe el sitio en el que se ha entrado', session.siteName === 'Moodle de prueba', session.siteName);
      check('Y con qué nombre', session.userName === 'María Ojeda', session.userName);
      check('Y el id de usuario, que hace falta para sus cursos', session.userId === 42);

      const loginPost = fake.seen.find((r) => r.url.startsWith('/login/index.php') && r.cookie.includes('MoodleSession'));
      check('La petición llevaba la cookie previa del sitio', Boolean(loginPost), loginPost ? loginPost.cookie.slice(0, 40) : 'sin cookie');

      const dashboardHit = fake.seen.find((r) => r.url === '/my/');
      check(
        'La sesión viaja en la cookie al área personal',
        Boolean(dashboardHit) && dashboardHit.cookie.includes('MoodleSessionSesionBuena'),
        dashboardHit ? dashboardHit.cookie.slice(0, 40) : 'sin petición'
      );

      const courses = await S.fetchEnrolledCourses(session);
      check('Se ven sus cursos entrando como el navegador', courses.length === 2, courses.map((c) => c.fullName).join(' · '));

      const html = await S.fetchCoursePage(session, 101);
      const page = S.parseCoursePage(html, session.baseUrl);
      check('Y la página del curso se lee entera', page.materials.length >= 2 && page.assignments.length === 2, `${page.materials.length} recurso(s) · ${page.assignments.length} tarea(s)`);

      const resourceHtml = await S.fetchMoodlePage(session, page.materials.find((m) => m.moduleType === 'resource').webUrl);
      const file = S.parseResourcePage(resourceHtml, session.baseUrl, {
        cmid: 555,
        modname: 'resource',
        sectionName: 'Tema 1',
        fallbackName: 'Apuntes del tema 1',
      })[0];
      check('Y su recurso da el PDF de verdad', Boolean(file) && file.name === 'apuntes-tema-1.pdf', file ? file.name : 'sin archivo');

      check(
        'Todas las peticiones han ido a ese mismo Moodle, ninguna a otro sitio',
        fake.seen.every((r) => r.host === new URL(base).host),
        `${fake.seen.length} petición(es)`
      );

      /* --- La contraseña equivocada --- */
      let wrong = null;
      try {
        await S.loginToMoodle({ baseUrl: base, username: USER, password: 'no-es-mi-clave' });
      } catch (error) {
        wrong = error;
      }
      check('Con la contraseña mal, se dice (no se cuela un error genérico)', /usuario o contraseña/i.test(String(wrong?.message ?? '')), String(wrong?.message ?? 'no ha fallado'));
      check('Y queda marcado como credenciales inválidas', wrong?.code === 'invalidlogin', String(wrong?.code));
      check(
        'La contraseña no aparece por ningún lado del error',
        wrong && !String(wrong.message).includes('no-es-mi-clave'),
        'comprobado'
      );

      /* --- Un Moodle que no enseña formulario (acceso único del centro) --- */
      let noForm = null;
      try {
        await S.loginToMoodle({ baseUrl: `${base}/sso`, username: USER, password: PASS });
      } catch (error) {
        noForm = error;
      }
      check(
        'Si el sitio no enseña el formulario, se explica en vez de inventarse una sesión',
        noForm !== null && noForm.code === 'no_login_form',
        String(noForm?.message ?? 'no ha fallado').slice(0, 90)
      );
      check(
        'Y se le dice al alumno qué hacer en su lugar',
        /clave de seguridad/i.test(String(noForm?.message ?? '')),
        'comprobado'
      );

      /* --- LA RESERVA: el centro no da clave y se entra como el navegador --- */
      section('8 · La reserva: el centro no da clave y la app entra sola por sesión');

      const outcome = await Live.connectMoodleAnyWay({
        baseUrl: base,
        username: USER,
        password: PASS,
        sealPassword: true,
      });

      check('En vez de fallar, se entra por la sesión web', outcome.via === 'sesion', outcome.via);
      check(
        'Y se explica por qué no se ha usado la clave (con el nombre del servicio)',
        /servicio/i.test(String(outcome.tokenTrouble ?? '')),
        String(outcome.tokenTrouble ?? 'sin motivo').slice(0, 90)
      );
      check(
        'Se sabe en qué sitio y con qué nombre se ha entrado',
        outcome.siteName === 'Moodle de prueba' && outcome.userName === 'María Ojeda',
        `${outcome.siteName} · ${outcome.userName}`
      );

      const savedAuth = await A.getMoodleSessionAuth();
      check('Las credenciales quedan guardadas para no volver a pedirlas', savedAuth?.username === USER && savedAuth?.password === PASS);
      check('Y la vía guardada es la de sesión', (await A.getMoodleAuthMode()) === 'sesion');

      const synced = await Live.syncMoodleAnyWay();
      check('La sincronización va por la misma vía', synced.via === 'sesion', synced.via);
      check('Y trae sus dos cursos', synced.stats.courses === 2, `${synced.stats.courses} curso(s)`);
      // Tres tareas en el Moodle de mentira: dos en Filosofía (una entregada y otra
      // no) y una en Matemáticas.
      check('Con sus tareas', synced.stats.tasks === 3, `${synced.stats.tasks} tarea(s)`);
      check(
        'Y sabiendo cuáles están entregadas y cuáles no',
        (await prisma.moodleTask.count({ where: { source: 'sesion', submitted: true } })) === 1 &&
          (await prisma.moodleTask.count({ where: { source: 'sesion', submitted: false } })) === 1,
        `${await prisma.moodleTask.count({ where: { source: 'sesion' } })} guardada(s)`
      );

      const apuntes = await prisma.moodleMaterial.findMany({
        where: { course: { moodleId: { in: [101, 102] } } },
      });
      check(
        'Y con los archivos de verdad, no solo el nombre del recurso',
        apuntes.length === 3 && apuntes.some((m) => m.name === 'apuntes-tema-1.pdf'),
        apuntes.map((m) => m.name).join(' · ')
      );
      check(
        'Cada apunte queda colgado de su curso',
        apuntes.every((m) => Boolean(m.courseId)),
        `${apuntes.length} apunte(s)`
      );
      check(
        'Y la conexión queda comprobada y al día',
        (await Heal.readMoodleHealth()).connected === true && (await Heal.readMoodleHealth()).mode === 'sesion'
      );

      // Es una prueba: lo que ha escrito esta sección se borra ahora mismo. Tus
      // cursos y apuntes de verdad no se tocan en ningún momento.
      await prisma.moodleTask.deleteMany({ where: { source: 'sesion' } });
      for (const moodleId of [101, 102]) {
        const curso = await prisma.moodleCourse.findUnique({ where: { moodleId } });
        if (!curso) continue;
        await prisma.moodleMaterial.deleteMany({ where: { courseId: curso.id } });
        await prisma.moodleCourse.delete({ where: { id: curso.id } });
      }
    } finally {
      await fake.close();
    }

    try {
      section('9 · La contraseña guardada: cifrada y sin poder leerse en claro');
      const SECRET = 'ClaveDelInstituto-2026!';

      await A.saveMoodleSessionAuth({
        baseUrl: 'https://moodle.micentro.es/login/index.php',
        username: '  maria.ojeda  ',
        password: SECRET,
        seal: true,
      });

      const row = await prisma.userProfile.findUnique({ where: { id: ID } });
      check('La dirección se queda limpia (sin /login ni barras de más)', row.moodleBaseUrl === 'https://moodle.micentro.es', row.moodleBaseUrl);
      check('El usuario se guarda sin espacios de más', row.moodleUsername === 'maria.ojeda', row.moodleUsername);
      check('La contraseña NO está en claro en la base', !String(row.moodlePasswordSealed ?? '').includes(SECRET), 'comprobado');
      check('Se guarda en el formato del cifrador', String(row.moodlePasswordSealed ?? '').startsWith('v1:'), String(row.moodlePasswordSealed ?? '').slice(0, 8));
      check('La vía queda marcada como sesión', row.moodleAuthMode === 'sesion');

      const auth = await A.getMoodleSessionAuth();
      check('Y se puede volver a leer (para entrar solo mañana)', auth?.password === SECRET && auth?.username === 'maria.ojeda', auth ? `${auth.username} · ${auth.baseUrl}` : 'no se ha podido leer');

      const state = await A.getMoodleCredentialState();
      check('El estado dice que hay contraseña guardada', state.mode === 'sesion' && state.passwordSaved === true);

      const health = await Heal.readMoodleHealth();
      check('Con usuario y contraseña guardada, Moodle está «conectado»', health.connected === true && health.mode === 'sesion', health.detail.slice(0, 70));

      const status = await Sync.getMoodleStatus();
      check(
        'Y Ajustes lo pintará como conectado por sesión, sin la contraseña',
        status.connected === true && status.authMode === 'sesion' && status.username === 'maria.ojeda' && status.passwordSaved === true,
        `${status.authMode} · ${status.username}`
      );
      check('El estado público no lleva la contraseña cifrada', !JSON.stringify(status).includes('v1:'), 'comprobado');

      /* --- Manipular el archivo guardado no sirve de nada --- */
      // Dos formas de tocar el valor guardado: añadirle basura al final (que el
      // decodificador de base64 tiende a ignorar en silencio) y cambiarle bytes.
      await prisma.userProfile.update({
        where: { id: ID },
        data: { moodlePasswordSealed: `${row.moodlePasswordSealed}MANIPULADO` },
      });
      const withJunk = await A.getMoodleSessionAuth();
      check('Añadirle basura al final no cuela: no se puede leer', withJunk === null);

      await prisma.userProfile.update({
        where: { id: ID },
        data: { moodlePasswordSealed: `${row.moodlePasswordSealed.slice(0, -4)}AAAA` },
      });
      const changed = await A.getMoodleSessionAuth();
      check('Y cambiarle un trozo tampoco', changed === null);

      await prisma.userProfile.update({
        where: { id: ID },
        data: { moodlePasswordSealed: row.moodlePasswordSealed },
      });
      check('El valor de verdad sí se lee', (await A.getMoodleSessionAuth())?.password === SECRET);

      /* --- Sin querer guardar la contraseña --- */
      await A.saveMoodleSessionAuth({ baseUrl: 'https://moodle.micentro.es', username: 'maria.ojeda', password: SECRET, seal: false });
      const noSave = await A.getMoodleSessionAuth();
      const health2 = await Heal.readMoodleHealth();
      check('Si el alumno dice que no se guarde, no se guarda', noSave === null);
      check('Y la app no dice «conectado» a medias', health2.connected === false && health2.mode === 'sesion', health2.detail.slice(0, 60));

      /* ---------------- 10. Guardar cursos y tareas de Moodle ---------------- */
      section('10 · Guardar cursos, apuntes y tareas: sin duplicar y sin borrar lo tuyo');

      const curso = { moodleId: 990101, fullName: 'ZZ verificación · Filosofía', shortName: 'ZZ filo' };
      const material = (nombre) => ({
        externalId: `990555:${nombre.toLowerCase()}`,
        sectionName: 'Tema 1',
        name: nombre,
        moduleType: 'resource',
        moduleName: nombre,
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        modifiedAt: null,
        downloadUrl: 'https://moodle.micentro.es/pluginfile.php/1/mod_resource/content/1/x.pdf',
        webUrl: null,
      });

      const first = await Store.storeCourseWithMaterials({
        course: curso,
        subjectId: null,
        sections: 3,
        materials: [material('Apuntes del tema 1'), material('Esquema del tema 1')],
      });
      const second = await Store.storeCourseWithMaterials({
        course: curso,
        subjectId: null,
        sections: 3,
        materials: [material('Apuntes del tema 1')],
      });

      const materiales = await prisma.moodleMaterial.findMany({ where: { courseId: first.id } });
      check('El curso se guarda', first.id === second.id && Boolean(first.id));
      check(
        'Lo que ya no está en Moodle sale del índice (el archivo del alumno no se toca)',
        materiales.length === 1 && materiales[0].name === 'Apuntes del tema 1',
        materiales.map((m) => m.name).join(', ')
      );

      const tarea = {
        externalId: 'sesion:cmid:990777',
        assignmentId: null,
        title: 'ZZ verificación · Comentario de texto',
        description: null,
        courseName: curso.fullName,
        subjectId: null,
        dueDate: new Date('2026-10-24T23:59:00'),
        moodleUrl: 'https://moodle.micentro.es/mod/assign/view.php?id=990777',
        source: 'sesion',
        submitted: false,
        graded: false,
        grade: null,
      };

      const t1 = await Store.storeTasks([tarea]);
      const t2 = await Store.storeTasks([{ ...tarea, title: tarea.title, submitted: true }]);
      const guardadas = await prisma.moodleTask.findMany({ where: { title: tarea.title } });
      check('La tarea se guarda una sola vez', t1.tasks === 1 && t2.tasks === 1 && guardadas.length === 1, `${guardadas.length} fila(s)`);
      check('Y la segunda pasada actualiza en vez de duplicar', guardadas[0]?.submitted === true);
      check('Con su fecha de entrega de Moodle', guardadas[0]?.dueDate?.toISOString().startsWith('2026-10-24') === true, String(guardadas[0]?.dueDate));

      // Una entrega que ya había entrado por el calendario iCal: se adopta.
      await prisma.moodleTask.deleteMany({ where: { title: tarea.title } });
      const ical = await prisma.moodleTask.create({
        data: {
          externalId: 'ical-uid-zz-verificacion',
          title: tarea.title,
          courseName: curso.fullName,
          dueDate: new Date('2026-10-24T23:59:00'),
          source: 'ical',
        },
      });
      const adopted = await Store.storeTasks([tarea]);
      const total = await prisma.moodleTask.count({ where: { title: tarea.title } });
      check('Una entrega del calendario se adopta en vez de duplicarse', adopted.adopted === 1 && total === 1, `${total} fila(s)`);
      const adoptedRow = await prisma.moodleTask.findUnique({ where: { id: ical.id } });
      check('Y queda con los datos buenos de Moodle', adoptedRow?.source === 'sesion' && adoptedRow?.externalId === tarea.externalId);
    } finally {
      // Se borra todo lo que ha creado esta parte, en orden y sin tocar nada más.
      await prisma.moodleTask.deleteMany({ where: { title: { startsWith: 'ZZ verificación ·' } } }).catch(() => {});
      await prisma.moodleTask.deleteMany({ where: { source: 'sesion' } }).catch(() => {});
      for (const moodleId of [101, 102]) {
        const rest = await prisma.moodleCourse.findUnique({ where: { moodleId } }).catch(() => null);
        if (!rest) continue;
        await prisma.moodleMaterial.deleteMany({ where: { courseId: rest.id } }).catch(() => {});
        await prisma.moodleCourse.delete({ where: { id: rest.id } }).catch(() => {});
      }
      const course = await prisma.moodleCourse.findUnique({ where: { moodleId: 990101 } }).catch(() => null);
      if (course) {
        await prisma.moodleMaterial.deleteMany({ where: { courseId: course.id } }).catch(() => {});
        await prisma.moodleCourse.delete({ where: { id: course.id } }).catch(() => {});
      }

      await prisma.userProfile.update({
        where: { id: ID },
        data: {
          moodleBaseUrl: before.moodleBaseUrl,
          moodleToken: before.moodleToken,
          moodleAuthMode: before.moodleAuthMode,
          moodleUsername: before.moodleUsername,
          moodlePasswordSealed: before.moodlePasswordSealed,
          moodleSessionAt: before.moodleSessionAt,
          moodleSiteName: before.moodleSiteName,
          moodleUserId: before.moodleUserId,
          moodleConnectedAt: before.moodleConnectedAt,
          moodleTokenState: before.moodleTokenState,
          moodleCheckedAt: before.moodleCheckedAt,
          lastMoodleSync: before.lastMoodleSync,
        },
      });

      const restored = await prisma.userProfile.findUnique({ where: { id: ID } });
      check(
        'Tu conexión de Moodle se queda como estaba',
        restored.moodleBaseUrl === before.moodleBaseUrl &&
          restored.moodleAuthMode === before.moodleAuthMode &&
          restored.moodlePasswordSealed === before.moodlePasswordSealed,
        `${restored.moodleBaseUrl ?? 'sin conectar'} · ${restored.moodleAuthMode}`
      );
      check('Y no queda ningún curso de prueba', (await prisma.moodleCourse.count({ where: { moodleId: 990101 } })) === 0);
      check(
        'La base queda con los mismos cursos, apuntes y tareas que al empezar',
        (await prisma.moodleCourse.count()) === countsBefore.cursos &&
          (await prisma.moodleMaterial.count()) === countsBefore.apuntes &&
          (await prisma.moodleTask.count()) === countsBefore.tareas,
        `${await prisma.moodleCourse.count()} cursos · ${await prisma.moodleMaterial.count()} apuntes · ${await prisma.moodleTask.count()} tareas`
      );

      await prisma.$disconnect().catch(() => {});
    }
  }

  fs.rmSync(outDir, { recursive: true, force: true });

  console.log('');
  if (failures === 0) {
    console.log(`\u001b[32mTODO EN VERDE\u001b[0m · ${failed.length === 0 ? 'sin fallos' : ''}`);
  } else {
    console.log(`\u001b[31m${failures} COMPROBACIÓN(ES) EN ROJO\u001b[0m`);
    for (const label of failed) console.log(`  ✗ ${label}`);
  }

  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\nLa verificación se ha roto:', error);
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
