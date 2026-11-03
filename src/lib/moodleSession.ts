/**
 * Moodle por **sesión web**: entrar como entra el navegador.
 *
 * La vía de Web Services necesita una clave que el centro tiene que permitir
 * crear al alumnado, y muchos no la permiten (o el servicio móvil está apagado).
 * Este módulo hace lo que hace un navegador, con el usuario y la contraseña que
 * el alumno ya tiene:
 *
 *   1. `GET /login/index.php` → se guarda la cookie y se saca el `logintoken`
 *      (el campo oculto que Moodle pone para que nadie pueda enviar el
 *      formulario desde fuera).
 *   2. `POST /login/index.php` con usuario, contraseña y ese token → Moodle
 *      responde con la cookie de sesión (`MoodleSession`).
 *   3. Se recorren `Mis cursos` y cada `course/view.php`, y se leen de su HTML:
 *      los temas (secciones), los recursos con su archivo (`pluginfile.php`), las
 *      tareas de `mod/assign` y su fecha de entrega.
 *
 * Reglas que no se saltan:
 *   - La contraseña se usa aquí y se olvida: no se guarda, no se registra y no
 *     se repite en ningún mensaje de error.
 *   - Las cookies de sesión viven en memoria mientras dura la sincronización:
 *     no se manda ninguna al navegador.
 *   - Se hacen peticiones normales, como un navegador: sin trucos raros, sin
 *     saltarse permisos y con una sola sesión a la vez.
 *
 * Módulo sin base de datos: solo HTTP y parseo (lo que se puede probar).
 */

import {
  MoodleError,
  normalizeMoodleBaseUrl,
  stripTokenFromUrl,
  type MoodleCourseInfo,
  type MoodleMaterialDraft,
} from './moodleWs';

/** Sesión abierta contra un Moodle. Las cookies no salen de aquí. */
export interface MoodleSession {
  baseUrl: string;
  /** Cabecera `Cookie` completa de la sesión. */
  cookieHeader: string;
  siteName: string;
  userName: string;
  userId: number;
}

/** Tarea leída del HTML de un curso (aún sin pasar por la base). */
export interface MoodleSessionAssignment {
  /** `cmid` del módulo: identifica la tarea dentro del sitio. */
  cmid: number;
  title: string;
  description: string | null;
  dueDate: Date | null;
  url: string;
  submitted: boolean | null;
}

export interface MoodleCoursePage {
  sections: number;
  materials: MoodleMaterialDraft[];
  assignments: MoodleSessionAssignment[];
}

/* ------------------------------------------------------------------ */
/* Utilidades puras                                                    */
/* ------------------------------------------------------------------ */

/** HTML → texto plano, sin acentos raros ni espacios de más. */
export function htmlToPlainText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|span)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&aacute;/gi, 'á')
    .replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú')
    .replace(/&ntilde;/gi, 'ñ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Saca el `logintoken` del formulario de acceso. Si no está, ese sitio no usa el
 * formulario de siempre (login único del centro, por ejemplo).
 */
export function extractLogintoken(html: string): string | null {
  const match = String(html ?? '').match(
    /<input[^>]+name="logintoken"[^>]*value="([^"]+)"/i
  );
  if (match) return match[1];

  // Algunos temas lo ponen al revés (value antes que name).
  const reversed = String(html ?? '').match(
    /<input[^>]+value="([^"]+)"[^>]*name="logintoken"/i
  );
  return reversed ? reversed[1] : null;
}

/**
 * ¿La página que tenemos es de alguien con la sesión abierta? Se busca la salida
 * del menú de usuario y el propio menú: lo que solo existe estando dentro.
 */
export function looksLoggedIn(html: string): boolean {
  const text = String(html ?? '');
  if (/\/login\/index\.php/i.test(text) && /logintoken/i.test(text)) return false;
  return /logout\.php|data-region="user-menu|class="[^"]*usertext/i.test(text);
}

/** El aviso de error que Moodle pinta en el formulario, si lo hay. */
export function detectLoginError(html: string): string | null {
  const text = String(html ?? '');

  const boxes = [
    /<div[^>]*class="[^"]*(?:loginerrors|alert-danger|errorbox)[^"]*"[^>]*>([\s\S]{0,600}?)<\/div>/i,
    /id="loginerrormessage"[^>]*>([\s\S]{0,400}?)</i,
  ];

  for (const pattern of boxes) {
    const match = text.match(pattern);
    const message = match ? htmlToPlainText(match[1]) : '';
    if (message.length > 3) return message.slice(0, 300);
  }

  // El texto que usa Moodle cuando las credenciales no valen (en español y en
  // inglés: «Invalid login, please try again»).
  if (/invalid\s*login|invalid username or password|usuario o contraseña incorrectos/i.test(text)) {
    return 'Tu usuario o tu contraseña no son los de ese Moodle.';
  }
  return null;
}

/** Nombre del sitio, si la página lo dice. */
export function parseSiteName(html: string): string | null {
  const text = String(html ?? '');

  const title = text.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  if (title) {
    const parts = htmlToPlainText(title[1])
      .split(/[|·–—]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 2);
    // En Moodle el título es «Página | Nombre del sitio»: nos quedamos con el
    // trozo que no es el nombre de la página.
    const site = parts.find((part) => !/^área personal$|^my home$|^panel$|^inicio$|^dashboard$/i.test(part));
    if (site) return site.slice(0, 120);
  }

  const logo = text.match(/<img[^>]*class="[^"]*logo[^"]*"[^>]*alt="([^"]{3,120})"/i);
  if (logo) return logo[1].trim();
  if (/moodle/i.test(text)) return 'Moodle';
  return null;
}

/** Nombre de la persona con la sesión abierta, si aparece. */
export function parseUserName(html: string): string | null {
  const text = String(html ?? '');
  const candidates = [
    /class="[^"]*usertext[^"]*"[^>]*>([^<]{2,80})</i,
    /href="[^"]*\/user\/profile\.php[^"]*"[^>]*>([^<]{2,80})</i,
    /class="[^"]*usermenu[^"]*"[^>]*>[\s\S]{0,200}?<span[^>]*>([^<]{2,80})</i,
  ];

  for (const pattern of candidates) {
    const match = text.match(pattern);
    const name = match ? htmlToPlainText(match[1]) : '';
    if (name.length > 1 && !/^(perfil|profile|salir|logout|mi cuenta)$/i.test(name)) {
      return name.slice(0, 80);
    }
  }
  return null;
}

/** Id del alumno en el sitio, si Moodle lo ha dejado escrito en la página. */
export function parseUserId(html: string): number {
  const text = String(html ?? '');
  const match =
    text.match(/data-userid="(\d+)"/i) ||
    text.match(/"userid"\s*:\s*"?(\d+)"?/i) ||
    text.match(/M\.cfg\.userId\s*=\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

/**
 * Quita el texto que Moodle esconde para lectores de pantalla
 * (`<span class="accesshide">Archivo</span>`): es invisible a la vista, pero al
 * pasar el HTML a texto se cuela en el nombre del recurso y queda un apunte
 * llamado «Apuntes del tema 1 Archivo».
 */
export function stripScreenReaderNoise(html: string): string {
  return String(html ?? '').replace(
    /<span[^>]*class="[^"]*accesshide[^"]*"[^>]*>[\s\S]*?<\/span>/gi,
    ' '
  );
}

/** Lista de cursos a partir de los enlaces a `course/view.php` de una página. */
export function parseCoursesFromHtml(html: string, baseUrl: string): MoodleCourseInfo[] {
  const text = String(html ?? '');
  const seen = new Map<number, MoodleCourseInfo>();
  const pattern =
    /<a[^>]+href="([^"]*\/course\/view\.php\?id=(\d+)[^"]*)"[^>]*>([\s\S]{0,800}?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const moodleId = Number(match[2]);
    // El curso 1 es la portada del sitio: ahí no hay nada del alumno.
    if (!Number.isFinite(moodleId) || moodleId <= 1) continue;

    const name = htmlToPlainText(match[3]).replace(/\s+/g, ' ').trim();
    if (name.length < 2) continue;
    if (/^(ir al curso|volver|inicio|mi curso)$/i.test(name)) continue;

    const previous = seen.get(moodleId);
    // En la portada un curso aparece varias veces: nos quedamos con el nombre
    // más largo, que es el completo.
    if (!previous || previous.fullName.length < name.length) {
      seen.set(moodleId, { moodleId, fullName: name.slice(0, 160), shortName: name.slice(0, 60) });
    }
  }

  void baseUrl; // el id del curso ya basta para volver a él
  return [...seen.values()];
}

const MONTHS: Record<string, number> = {
  enero: 1, ene: 1, january: 1, jan: 1,
  febrero: 2, feb: 2, february: 2,
  marzo: 3, mar: 3, march: 3,
  abril: 4, abr: 4, april: 4, apr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6, june: 6,
  julio: 7, jul: 7, july: 7,
  agosto: 8, ago: 8, august: 8, aug: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, september: 9,
  octubre: 10, oct: 10, october: 10,
  noviembre: 11, nov: 11, november: 11,
  diciembre: 12, dic: 12, december: 12, dec: 12,
};

/**
 * Fecha de Moodle («viernes, 24 de octubre de 2026, 23:59») → `Date`.
 * Devuelve `null` si el texto no trae una fecha reconocible: en ese caso la
 * tarea queda sin fecha, que es mejor que ponerle una inventada.
 */
export function parseMoodleHumanDate(raw: string): Date | null {
  const text = String(raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;

  const time = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const hours = time ? Number(time[1]) : 23;
  const minutes = time ? Number(time[2]) : 59;

  // 24/10/2026 o 24-10-2026 (día primero, como en España).
  const numeric = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return new Date(year, month - 1, day, hours, minutes, 0, 0);
    }
  }

  // 24 de octubre de 2026
  const spelled = text.match(/(\d{1,2})\s*(?:de\s+)?([a-z]+)\.?\s*(?:de\s+)?(\d{4})/);
  if (spelled) {
    const day = Number(spelled[1]);
    const month = MONTHS[spelled[2]];
    const year = Number(spelled[3]);
    if (month && day >= 1 && day <= 31) {
      return new Date(year, month - 1, day, hours, minutes, 0, 0);
    }
  }

  return null;
}

/** «Viernes, 24 de octubre de 2026, 23:59» dentro del bloque de una actividad. */
function extractDueDate(blockHtml: string): Date | null {
  const patterns = [
    /(?:vence|entrega|fecha\s*l[ií]mite|due)\s*:?\s*(?:<[^>]*>\s*)*([^<>{}]{6,90})/i,
    /class="[^"]*(?:activity-dates|text-danger|text-nowrap)[^"]*"[^>]*>([\s\S]{0,120}?)<\//i,
  ];

  for (const pattern of patterns) {
    const match = String(blockHtml).match(pattern);
    if (!match) continue;
    const date = parseMoodleHumanDate(htmlToPlainText(match[1]));
    if (date) return date;
  }
  return null;
}

/** ¿El bloque dice que ya está entregada? */
function extractSubmitted(blockHtml: string): boolean | null {
  const text = htmlToPlainText(blockHtml).toLowerCase();
  if (/entregado|submitted|enviado/.test(text)) return true;
  if (/sin entregar|no entregado|not submitted|pendiente de entrega/.test(text)) return false;
  return null;
}

/** Módulos que NO son material de estudio (se tratan aparte o no se indexan). */
const NON_MATERIAL_MODULES = new Set(['assign', 'label', 'attendance', 'choice', 'feedback', 'quiz', 'forum']);

interface ActivityBlock {
  modname: string;
  cmid: number;
  url: string;
  name: string;
  files: MoodleMaterialDraft[];
  assignment: MoodleSessionAssignment | null;
}

/**
 * Lee las actividades de un trozo de página de curso. Se apoya en las clases de
 * Moodle (`li.activity`, `a.aalink`), que llevan años siendo las mismas, y si el
 * tema es antiguo cae en buscar los enlaces a `mod/.../view.php`.
 */
function parseActivities(chunkHtml: string, baseUrl: string, sectionName: string): ActivityBlock[] {
  const text = String(chunkHtml ?? '');
  const out: ActivityBlock[] = [];

  // Se parte el HTML por cada actividad, para poder leer su fecha y sus archivos
  // sin atribuírselos al de al lado.
  const starts = [...text.matchAll(/<li[^>]*class="[^"]*\bactivity\b[^"]*"/gi)].map((m) => m.index ?? 0);
  const chunks: string[] =
    starts.length > 0
      ? starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length))
      : [text];

  for (const block of chunks) {
    const link = block.match(
      /<a[^>]+href="([^"]*\/mod\/([a-z_]+)\/view\.php\?id=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i
    );
    if (!link) continue;

    const cmid = Number(link[3]);
    if (!Number.isFinite(cmid) || cmid <= 0) continue;

    const modname = link[2].toLowerCase();
    const name =
      htmlToPlainText(stripScreenReaderNoise(link[4])).replace(/\s+/g, ' ').trim() || modname;
    const url = absoluteMoodleUrl(link[1], baseUrl);

    // Archivos enlazados directamente en la página del curso (algunos temas los
    // pintan aquí, sobre todo dentro de carpetas).
    const files: MoodleMaterialDraft[] = [];
    const filePattern = /<a[^>]+href="([^"]*pluginfile\.php[^"]*)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
    let fileMatch: RegExpExecArray | null;
    while ((fileMatch = filePattern.exec(block)) !== null) {
      const parsed = materialFromFileUrl(fileMatch[1], htmlToPlainText(fileMatch[2]), {
        cmid,
        modname,
        sectionName,
        baseUrl,
      });
      if (parsed) files.push(parsed);
    }

    out.push({
      modname,
      cmid,
      url,
      name,
      files,
      assignment:
        modname === 'assign'
          ? {
              cmid,
              title: name.slice(0, 160),
              description: null,
              dueDate: extractDueDate(block),
              url,
              submitted: extractSubmitted(block),
            }
          : null,
    });
  }

  return out;
}

/** Un archivo de Moodle (`pluginfile.php`) → apunte listo para guardar. */
function materialFromFileUrl(
  rawUrl: string,
  linkText: string,
  context: { cmid: number; modname: string; sectionName: string; baseUrl: string }
): MoodleMaterialDraft | null {
  const url = String(rawUrl ?? '').trim();
  if (!url) return null;

  let decoded: URL | null = null;
  try {
    decoded = new URL(url, context.baseUrl);
  } catch {
    return null;
  }

  const fromQuery = decoded.searchParams.get('filename') ?? '';
  // El nombre de verdad suele venir en la propia ruta del archivo; el texto del
  // enlace muchas veces es solo «Descargar», así que va el último.
  const fromPath = decodeURIComponent(decoded.pathname.split('/').filter(Boolean).pop() ?? '');
  const name = (fromQuery || fromPath || linkText || context.modname).trim().slice(0, 180);
  if (!name) return null;

  return {
    externalId: `${context.cmid}:${name.toLowerCase()}`,
    sectionName: context.sectionName.slice(0, 180),
    name,
    moduleType: context.modname,
    moduleName: linkText.trim().slice(0, 180) || null,
    // `forcedownload=1` va en la URL y el token se quita siempre.
    downloadUrl: stripTokenFromUrl(decoded.toString()),
    webUrl: null,
    mimeType: null,
    sizeBytes: 0,
    modifiedAt: null,
  };
}

/** URL absoluta a partir de un enlace relativo de Moodle. */
export function absoluteMoodleUrl(href: string, baseUrl: string): string {
  try {
    return new URL(String(href ?? ''), `${String(baseUrl ?? '').replace(/\/+$/, '')}/`).toString();
  } catch {
    return String(href ?? '');
  }
}

/** Nombre del tema (sección) en cuyo trozo estamos. */
function parseSectionName(chunkHtml: string, fallbackIndex: number): string {
  const text = String(chunkHtml ?? '');
  const patterns = [
    /class="[^"]*sectionname[^"]*"[^>]*>([\s\S]{0,200}?)<\/h[1-6]>/i,
    /class="[^"]*sectionname[^"]*"[^>]*>([\s\S]{0,200}?)</i,
    /aria-label="([^"]{3,120})"/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = match
      ? htmlToPlainText(stripScreenReaderNoise(match[1])).replace(/\s+/g, ' ').trim()
      : '';
    if (name.length > 1 && !/^(sección|section|tema)\s*\d*$/i.test(name)) return name.slice(0, 180);
  }
  return `Tema ${fallbackIndex + 1}`;
}

/**
 * Convierte el HTML de `course/view.php` en lo que hay que guardar: los temas,
 * los recursos (con su archivo si la página lo trae) y las tareas de entrega.
 */
export function parseCoursePage(html: string, baseUrl: string): MoodleCoursePage {
  const text = String(html ?? '');

  const markers = [...text.matchAll(/id="section-(\d+)"/gi)].map((match) => ({
    index: match.index ?? 0,
    number: Number(match[1]),
  }));

  const chunks: Array<{ html: string; index: number }> =
    markers.length > 0
      ? markers.map((marker, index) => ({
          html: text.slice(marker.index, markers[index + 1]?.index ?? text.length),
          index: marker.number,
        }))
      : [{ html: text, index: 0 }];

  const materials: MoodleMaterialDraft[] = [];
  const assignments: MoodleSessionAssignment[] = [];
  const seenMaterials = new Set<string>();

  for (const chunk of chunks) {
    const sectionName = parseSectionName(chunk.html, chunk.index);

    for (const activity of parseActivities(chunk.html, baseUrl, sectionName)) {
      if (activity.assignment) assignments.push(activity.assignment);

      if (activity.files.length > 0) {
        for (const file of activity.files) {
          if (seenMaterials.has(file.externalId)) continue;
          seenMaterials.add(file.externalId);
          materials.push(file);
        }
        continue;
      }

      // Una tarea, un cuestionario o una etiqueta no son apuntes: indexarlos
      // llenaría el cuaderno de ruido.
      if (NON_MATERIAL_MODULES.has(activity.modname)) continue;

      // Sin archivo a la vista: se indexa el propio recurso con su enlace. Así en
      // el cuaderno aparece lo que el profesor ha subido, aunque el archivo se
      // tenga que abrir en Moodle.
      const externalId = `${activity.cmid}:${activity.name.toLowerCase()}`;
      if (seenMaterials.has(externalId)) continue;
      seenMaterials.add(externalId);
      materials.push({
        externalId,
        sectionName,
        name: activity.name.slice(0, 180),
        moduleType: activity.modname,
        moduleName: activity.name.slice(0, 180),
        mimeType: null,
        sizeBytes: 0,
        modifiedAt: null,
        downloadUrl: null,
        webUrl: activity.url,
      });
    }
  }

  return { sections: chunks.length, materials, assignments };
}

/**
 * De la página de un recurso (`mod/resource`, `mod/folder`, `mod/url`…) saca su
 * archivo o su enlace real. Es la llamada que hace que en el cuaderno haya
 * apuntes de verdad y no solo nombres.
 */
export function parseResourcePage(
  html: string,
  baseUrl: string,
  context: { cmid: number; modname: string; sectionName: string; fallbackName: string }
): MoodleMaterialDraft[] {
  const text = String(html ?? '');
  const out: MoodleMaterialDraft[] = [];
  const seen = new Set<string>();

  const filePattern = /<a[^>]+href="([^"]*pluginfile\.php[^"]*)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(text)) !== null) {
    const material = materialFromFileUrl(match[1], htmlToPlainText(match[2]), {
      cmid: context.cmid,
      modname: context.modname,
      sectionName: context.sectionName,
      baseUrl,
    });
    if (!material || seen.has(material.externalId)) continue;
    seen.add(material.externalId);
    out.push(material);
  }

  if (out.length > 0) return out;

  // Un enlace externo (mod/url) no tiene archivo: se guarda como enlace.
  const external = text.match(/<a[^>]+class="[^"]*(?:urlworkaround|external)[^"]*"[^>]+href="(https?:\/\/[^"]+)"/i);
  if (external) {
    const url = stripTokenFromUrl(external[1]);
    out.push({
      externalId: `${context.cmid}:${context.fallbackName.toLowerCase()}`,
      sectionName: context.sectionName.slice(0, 180),
      name: context.fallbackName.slice(0, 180),
      moduleType: context.modname,
      moduleName: context.fallbackName.slice(0, 180),
      mimeType: null,
      sizeBytes: 0,
      modifiedAt: null,
      downloadUrl: url,
      webUrl: url,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP: cookies propias y redirecciones a mano                       */
/* ------------------------------------------------------------------ */

/** Caché de cookies de una sesión (aquí no hay navegador que las guarde). */
class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(headers: Headers): void {
    for (const raw of readSetCookie(headers)) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value.length === 0) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** `Set-Cookie` de una respuesta, sin depender de si el runtime trae `getSetCookie`. */
function readSetCookie(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === 'function') return withGetter.getSetCookie();

  const raw = headers.get('set-cookie');
  if (!raw) return [];
  // Sin `getSetCookie` hay que adivinar dónde acaba una cookie: se corta por la
  // coma que va seguida de un nombre de cookie (no por la de una fecha).
  return raw.split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
}

interface HttpResult {
  status: number;
  location: string | null;
  body: string;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BrainUpAcademy/1.0 (sesión local de Moodle)';

async function request(options: {
  url: string;
  method?: 'GET' | 'POST';
  form?: URLSearchParams;
  jar?: CookieJar;
  referer?: string;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<HttpResult> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'es-ES,es;q=0.9',
  };

  if (options.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (options.referer) headers.Referer = options.referer;
  const cookie = options.jar?.header();
  if (cookie) headers.Cookie = cookie;

  let response: Response;
  try {
    response = await fetch(options.url, {
      method: options.method ?? 'GET',
      headers,
      body: options.form ? options.form.toString() : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MoodleError(
      `No se ha podido contactar con tu Moodle (${detail}). Comprueba la dirección y tu conexión.`,
      'network'
    );
  }

  options.jar?.absorb(response.headers);

  const location = response.headers.get('location');
  const text = (await response.text()).slice(0, options.maxBytes ?? 3_000_000);

  return { status: response.status, location, body: text };
}

/** Sigue las redirecciones a mano para no perder ninguna cookie por el camino. */
async function requestFollowing(options: {
  url: string;
  jar: CookieJar;
  method?: 'GET' | 'POST';
  form?: URLSearchParams;
  referer?: string;
  maxHops?: number;
  maxBytes?: number;
}): Promise<HttpResult> {
  let url = options.url;
  let method = options.method ?? 'GET';
  let form = options.form;
  let referer = options.referer;
  const maxHops = options.maxHops ?? 6;

  for (let hop = 0; hop <= maxHops; hop++) {
    const result = await request({
      url,
      method,
      form,
      jar: options.jar,
      referer,
      timeoutMs: options.form ? 25_000 : 20_000,
      maxBytes: options.maxBytes,
    });

    if (result.status >= 300 && result.status < 400 && result.location) {
      referer = url;
      url = absoluteMoodleUrl(result.location, url);
      // Las redirecciones de Moodle (login y "post" de formularios) se siguen
      // siempre con GET.
      method = 'GET';
      form = undefined;
      continue;
    }

    return result;
  }

  throw new MoodleError(
    'Tu Moodle ha encadenado demasiadas redirecciones al entrar. Prueba otra vez; si sigue igual, entra desde el navegador para comprobar que el sitio va bien.',
    'too_many_redirects'
  );
}

/* ------------------------------------------------------------------ */
/* Entrar en Moodle                                                    */
/* ------------------------------------------------------------------ */

/**
 * Abre una sesión en Moodle con el usuario y la contraseña del alumno, igual que
 * si entrara desde el navegador.
 *
 * La contraseña no se queda en ningún sitio: solo viaja en el `POST`.
 */
export async function loginToMoodle(params: {
  baseUrl: string;
  username: string;
  password: string;
}): Promise<MoodleSession> {
  const baseUrl = normalizeMoodleBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new MoodleError(
      'La dirección de tu Moodle no es válida. Debe ser algo como https://moodle.tuinstituto.es',
      'bad_url'
    );
  }

  const username = String(params.username ?? '').trim();
  if (!username) throw new MoodleError('Escribe tu usuario de Moodle.', 'missingusername');
  if (!String(params.password ?? '')) {
    throw new MoodleError('Escribe tu contraseña de Moodle.', 'missingpassword');
  }

  const jar = new CookieJar();
  const loginUrl = `${baseUrl}/login/index.php`;

  const page = await request({ url: loginUrl, jar });
  if (page.status === 404) {
    throw new MoodleError(
      'En esa dirección no hay una página de acceso de Moodle. Comprueba que es la dirección del sitio donde entras a tus cursos.',
      'wrong_url'
    );
  }

  const logintoken = extractLogintoken(page.body);
  if (!logintoken) {
    if (looksLoggedIn(page.body)) {
      const inside = await requestFollowing({ url: `${baseUrl}/my/`, jar });
      return {
        baseUrl,
        cookieHeader: jar.header(),
        siteName: parseSiteName(inside.body) ?? 'Moodle',
        userName: parseUserName(inside.body) ?? username,
        userId: parseUserId(inside.body),
      };
    }

    throw new MoodleError(
      `Ese Moodle no enseña el formulario de acceso de siempre en ${loginUrl}. Muchos centros entran con el usuario único del instituto (Google, Microsoft, EducaMadrid…), y esa puerta no se puede abrir con usuario y contraseña. Prueba con la clave de seguridad desde Ajustes.`,
      'no_login_form'
    );
  }

  const form = new URLSearchParams();
  form.append('anchor', '');
  form.append('logintoken', logintoken);
  form.append('username', username);
  form.append('password', String(params.password));

  const post = await request({
    url: loginUrl,
    method: 'POST',
    form,
    jar,
    referer: loginUrl,
  });

  // Moodle contesta 200 con el formulario y el error escrito dentro.
  const failure = detectLoginError(post.body);
  if (failure) throw new MoodleError(failure, 'invalidlogin');

  if (post.status >= 400) {
    throw new MoodleError(
      `Tu Moodle ha respondido con HTTP ${post.status} al entrar. Inténtalo otra vez en un rato.`,
      'http_error'
    );
  }

  // Comprobación de verdad: el área personal solo se ve con la sesión abierta.
  const afterPost =
    post.status >= 300 && post.location
      ? await requestFollowing({ url: absoluteMoodleUrl(post.location, loginUrl), jar, referer: loginUrl })
      : post;

  const dashboard = looksLoggedIn(afterPost.body)
    ? afterPost
    : await requestFollowing({ url: `${baseUrl}/my/`, jar, referer: loginUrl });

  if (!looksLoggedIn(dashboard.body)) {
    throw new MoodleError(
      detectLoginError(dashboard.body) ??
        'Tu Moodle no ha dado por buena la sesión. Comprueba el usuario y la contraseña con los que entras en el navegador.',
      'login_failed'
    );
  }

  return {
    baseUrl,
    cookieHeader: jar.header(),
    siteName: parseSiteName(dashboard.body) ?? 'Moodle',
    userName: parseUserName(dashboard.body) ?? username,
    userId: parseUserId(dashboard.body),
  };
}

/** Una página de Moodle con la sesión abierta (sigue redirecciones). */
export async function fetchMoodlePage(
  session: MoodleSession,
  pathOrUrl: string,
  options: { maxBytes?: number } = {}
): Promise<string> {
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : absoluteMoodleUrl(pathOrUrl, session.baseUrl);

  if (!url.startsWith(session.baseUrl)) {
    throw new MoodleError(
      'Moodle ha intentado llevarme a otro sitio: solo leo páginas de tu propio Moodle.',
      'foreign_url'
    );
  }

  // El jar ya no existe fuera del login: la cookie viaja en la sesión.
  const result = await requestFollowing({
    url,
    jar: jarFromHeader(session.cookieHeader),
    maxBytes: options.maxBytes,
  });

  if (result.status === 404) {
    throw new MoodleError(`Esa página de Moodle no existe (${url}).`, 'not_found');
  }
  if (result.status === 403) {
    throw new MoodleError(
      'Tu Moodle ha dicho que no tienes permiso para esa página. Puede que la sesión se haya cerrado: vuelve a conectar desde Ajustes.',
      'forbidden'
    );
  }

  return result.body;
}

/** Reconstruye el tarro de cookies a partir de la cabecera de una sesión. */
function jarFromHeader(cookieHeader: string): CookieJar {
  const jar = new CookieJar();
  const headers = new Headers();
  for (const pair of String(cookieHeader ?? '').split(';')) {
    const trimmed = pair.trim();
    if (trimmed) headers.append('set-cookie', trimmed);
  }
  jar.absorb(headers);
  return jar;
}

/** Cursos del alumno, entrando por «Mis cursos» y con la portada como respaldo. */
export async function fetchEnrolledCourses(session: MoodleSession): Promise<MoodleCourseInfo[]> {
  const pages = ['/my/courses.php', '/my/', '/course/index.php'];

  for (const page of pages) {
    try {
      const html = await fetchMoodlePage(session, page);
      const courses = parseCoursesFromHtml(html, session.baseUrl);
      if (courses.length > 0) return courses;
    } catch (error) {
      // Una página que no existe no es un fallo: se prueba la siguiente.
      if (error instanceof MoodleError && ['not_found', 'forbidden'].includes(error.code)) continue;
      throw error;
    }
  }

  return [];
}

/** El HTML de un curso. */
export async function fetchCoursePage(session: MoodleSession, moodleId: number): Promise<string> {
  return fetchMoodlePage(session, `/course/view.php?id=${moodleId}`);
}
