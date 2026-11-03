/**
 * Moodle por Web Services (con token): cursos, apuntes y tareas de verdad.
 *
 * El enlace iCal (ver `moodle.ts`) solo trae fechas de entrega. Para **entrar en
 * los apuntes y ver las tareas reales** hace falta el token de Web Services del
 * alumno: con él Moodle responde a `core_course_get_contents` (los archivos de
 * cada tema) y a `mod_assign_get_assignments` + `mod_assign_get_submissions`
 * (las tareas y si ya están entregadas).
 *
 * Este módulo no toca la base de datos: es el cliente HTTP y el mapeo (puro) de
 * las respuestas de Moodle. Quien escribe en SQLite es `moodleWsSync.ts`.
 *
 * REGLA DEL TOKEN: no sale nunca de aquí. No se guarda dentro de ninguna URL
 * (las URLs de archivo se guardan sin token y se le añade al servir), no se
 * manda al navegador y no se escribe en los mensajes de error.
 *
 * Y el token se puede conseguir de dos maneras: creándolo el alumno en su perfil
 * y pegándolo aquí, o dejando que se lo **pidamos a Moodle con su usuario y su
 * contraseña** (`requestMoodleToken`, la misma vía que la app oficial del móvil).
 * En el segundo caso la contraseña se usa una vez y se olvida: no se guarda.
 */

export interface MoodleSiteInfo {
  siteName: string;
  userName: string;
  userId: number;
  release: string | null;
  functions: string[];
}

export interface MoodleCourseInfo {
  moodleId: number;
  fullName: string;
  shortName: string;
}

export interface MoodleMaterialDraft {
  externalId: string;
  sectionName: string;
  name: string;
  moduleType: string;
  moduleName: string | null;
  mimeType: string | null;
  sizeBytes: number;
  modifiedAt: Date | null;
  downloadUrl: string | null;
  webUrl: string | null;
}

export interface MoodleTaskDraft {
  assignmentId: number;
  title: string;
  description: string | null;
  courseMoodleId: number;
  courseName: string;
  dueDate: Date | null;
  submitted: boolean | null;
  graded: boolean;
  grade: number | null;
  webUrl: string;
}

/** Funciones que BrainUp necesita para leer apuntes y tareas. */
export const REQUIRED_MOODLE_FUNCTIONS = [
  'core_webservice_get_site_info',
  'core_enrol_get_users_courses',
  'core_course_get_contents',
  'mod_assign_get_assignments',
  'mod_assign_get_submissions',
] as const;

/* ------------------------------------------------------------------ */
/* Diagnóstico sin token: ¿qué le pasa a esta dirección?              */
/* ------------------------------------------------------------------ */

export type MoodleDiagnosisCode =
  /** El sitio responde a Web Services: solo falta la clave del alumno. */
  | 'ready'
  /** El sitio es Moodle pero tiene los servicios web apagados. */
  | 'services_disabled'
  /** Esa dirección no es un Moodle (o la ruta está mal). */
  | 'wrong_url'
  /** No se ha podido contactar. */
  | 'unreachable';

export interface MoodleDiagnosis {
  code: MoodleDiagnosisCode;
  /** Nombre del sitio, si ha querido decirlo. */
  siteName: string | null;
  /** Provincia de Moodle Centros (Andalucía), si es una de sus ocho instancias. */
  centrosProvince: string | null;
  endpoint: string;
  httpStatus: number | null;
  moodleError: string | null;
  /** Qué pasa, para enseñárselo al alumno. */
  message: string;
  /** Qué tiene que hacer ahora, en pasos concretos. */
  nextStep: string;
}

export const MOODLE_CENTROS_HOST = 'educacionadistancia.juntadeandalucia.es';

const CENTROS_PROVINCES = [
  'almeria',
  'cadiz',
  'cordoba',
  'granada',
  'huelva',
  'jaen',
  'malaga',
  'sevilla',
];

/** Provincias de Moodle Centros con la dirección exacta de cada instancia. */
export const MOODLE_CENTROS_INSTANCES = CENTROS_PROVINCES.map((province) => ({
  province,
  label: province.charAt(0).toUpperCase() + province.slice(1),
  url: `https://${MOODLE_CENTROS_HOST}/centros/${province}`,
}));

/**
 * ¿Es esta dirección una de las ocho instancias de Moodle Centros (Andalucía)?
 * Cada provincia es una plataforma distinta: la dirección tiene que ser la suya.
 */
export function moodleCentrosProvince(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.host !== MOODLE_CENTROS_HOST) return null;
    const match = url.pathname.match(/\/centros\/([a-z]+)/i);
    if (!match) return null;
    const province = match[1].toLowerCase();
    return CENTROS_PROVINCES.includes(province) ? province : null;
  } catch {
    return null;
  }
}

const CENTROS_STEPS =
  'Moodle Centros está dividido en ocho plataformas, una por provincia: comprueba que has puesto la de tu provincia ' +
  '(almeria, cadiz, cordoba, granada, huelva, jaen, malaga o sevilla). Luego, dentro de tu Moodle: tu nombre (arriba a la derecha) → ' +
  'Preferencias → Seguridad → «Claves de seguridad» (o «Fichas»), crea una clave para el servicio «Servicios web móviles» y pégala aquí. ' +
  'Si esa opción no te aparece, es que tu centro no le ha dado permiso de crear claves al alumnado: pídesela a un profesor o al ' +
  'coordinador TIC (pueden generarla por ti) o usa la alternativa del calendario iCal.';

/**
 * Mira si una dirección es un Moodle con los servicios web encendidos, sin
 * necesidad de token. Distingue los cuatro casos reales y dice qué hacer.
 */
export async function diagnoseMoodleSite(rawBaseUrl: string): Promise<MoodleDiagnosis> {
  const base = normalizeMoodleBaseUrl(rawBaseUrl);
  const endpoint = `${base ?? rawBaseUrl}/webservice/rest/server.php`;

  const baseResult: Pick<MoodleDiagnosis, 'endpoint' | 'centrosProvince' | 'httpStatus' | 'moodleError'> = {
    endpoint,
    centrosProvince: base ? moodleCentrosProvince(base) : null,
    httpStatus: null,
    moodleError: null,
  };

  if (!base) {
    return {
      ...baseResult,
      code: 'wrong_url',
      siteName: null,
      message: 'Esa dirección no vale como dirección de un Moodle.',
      nextStep: 'Escribe la dirección completa de tu plataforma, empezando por https:// (por ejemplo, la de tu provincia).',
    };
  }

  let response: Response;
  try {
    response = await fetch(`${base}/webservice/rest/server.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'BrainUpAcademy/1.0 (diagnóstico local de Moodle)',
      },
      body: new URLSearchParams({
        wsfunction: 'tool_mobile_get_public_config',
        moodlewsrestformat: 'json',
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...baseResult,
      code: 'unreachable',
      siteName: null,
      message: `No se ha podido contactar con esa dirección (${detail}).`,
      nextStep: 'Revisa que tienes internet y que la dirección está bien escrita, sin barras de más al final.',
    };
  }

  const httpStatus = response.status;
  const text = await response.text();

  let payload: { sitename?: string; errorcode?: string; message?: string } | null = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  const common = { ...baseResult, httpStatus, moodleError: payload?.errorcode ?? null };
  const isCentros = common.centrosProvince !== null;

  if (payload?.errorcode) {
    if (['wsaccessdisabled', 'enablewsdescription', 'servicerequireslogin'].includes(payload.errorcode)) {
      return {
        ...common,
        code: 'services_disabled',
        siteName: null,
        message: `«${base}» es un Moodle, pero tiene los servicios web apagados (${payload.errorcode}).`,
        nextStep: isCentros
          ? 'En Moodle Centros los servicios web sí están activos: revisa que la dirección sea exactamente la de tu provincia antes de pedir nada.'
          : 'Pide a tu centro que active los servicios web (Administración del sitio → Servicios web → Activar servicios web con protocolo REST). Mientras tanto, la alternativa del calendario iCal sigue disponible abajo.',
      };
    }

    // invalidtoken / accessexception: el servicio responde, así que está encendido.
    return {
      ...common,
      code: 'ready',
      siteName: null,
      message: isCentros
        ? `Buenas noticias: «${base}» (Moodle Centros de ${common.centrosProvince}) tiene los servicios web encendidos y responde.`
        : `Buenas noticias: «${base}» responde a los servicios web de Moodle.`,
      nextStep: isCentros
        ? CENTROS_STEPS
        : 'Lo único que falta es la clave: tu perfil → Preferencias → Seguridad → «Claves de seguridad», servicio «Servicios web móviles». Pégala aquí y conectamos.',
    };
  }

  if (payload && typeof payload.sitename === 'string') {
    return {
      ...common,
      code: 'ready',
      siteName: payload.sitename,
      message: `«${payload.sitename}» tiene los servicios web activos y contesta sin problema.`,
      nextStep: isCentros
        ? CENTROS_STEPS
        : 'Crea tu clave en tu perfil → Preferencias → Seguridad → «Claves de seguridad» (servicio «Servicios web móviles») y pégala aquí.',
    };
  }

  if (httpStatus === 404 || httpStatus === 403) {
    return {
      ...common,
      code: 'wrong_url',
      siteName: null,
      message: `En «${base}» no hay un Moodle con servicios web (HTTP ${httpStatus}).`,
      nextStep: isCentros
        ? CENTROS_STEPS
        : 'Comprueba la dirección: debe ser la del sitio donde entras a tus cursos (sin /login ni /webservice al final).',
    };
  }

  return {
    ...common,
    code: 'wrong_url',
    siteName: null,
    message: `«${base}» no ha devuelto el formato de un Moodle.`,
    nextStep: 'Pega la dirección de la página donde entras a tus cursos (la que ves en el navegador al hacer login).',
  };
}

export class MoodleError extends Error {
  constructor(
    message: string,
    readonly code: string = 'moodle_error'
  ) {
    super(message);
    this.name = 'MoodleError';
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades puras                                                    */
/* ------------------------------------------------------------------ */

/**
 * Deja la URL base en su sitio: acepta que el alumno pegue la URL del servicio
 * REST entera (`.../webservice/rest/server.php`) o la del sitio y se queda con
 * el origen.
 */
export function normalizeMoodleBaseUrl(raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const path = url.pathname.replace(/\/+$/, '');
  const cut = ['/webservice', '/login', '/my', '/index.php'].find((needle) => path.includes(needle));
  const cleanPath = cut ? path.slice(0, path.indexOf(cut)) : path;

  return `${url.protocol}//${url.host}${cleanPath === '/' ? '' : cleanPath}`;
}

/** Quita el token de una URL: es lo que se guarda en la base. */
export function stripTokenFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('token');
    return parsed.toString();
  } catch {
    return url.replace(/([?&])token=[^&#]*/gi, '').replace(/[?&]+$/, '');
  }
}

/** ¿Es una URL de archivo de Moodle y del mismo sitio que tenemos configurado? */
export function isSafeMoodleFileUrl(url: string, baseUrl: string): boolean {
  let file: URL;
  let base: URL;
  try {
    file = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return false;
  }

  if (file.protocol !== 'https:' && file.protocol !== 'http:') return false;
  if (file.host !== base.host) return false;
  return /pluginfile\.php/.test(file.pathname);
}

/** Normaliza para comparar nombres: sin acentos, sin mayúsculas, sin signos. */
export function normalizeMoodleName(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Empareja el curso de Moodle con una asignatura del sistema, si la hay. */
export function matchSubjectForCourse(
  courseName: string,
  subjects: Array<{ id: string; name: string }>
): string | null {
  const course = normalizeMoodleName(courseName);
  if (!course) return null;

  const exact = subjects.find((subject) => normalizeMoodleName(subject.name) === course);
  if (exact) return exact.id;

  const partial = subjects.find((subject) => {
    const other = normalizeMoodleName(subject.name);
    return other.length >= 4 && (course.includes(other) || other.includes(course));
  });
  return partial?.id ?? null;
}

/** HTML del enunciado → texto plano legible. */
export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Módulos de Moodle que NO son material de estudio (se tratan aparte o no). */
const NON_MATERIAL_MODULES = new Set(['assign', 'label', 'attendance', 'choice', 'feedback', 'quiz']);

const MAX_MATERIAL_NAME = 180;

interface MoodleContentFile {
  type?: string;
  filename?: string;
  fileurl?: string;
  filesize?: number;
  mimetype?: string;
  timemodified?: number;
}

interface MoodleModule {
  id?: number;
  name?: string;
  modname?: string;
  url?: string;
  visible?: number;
  contents?: MoodleContentFile[];
}

interface MoodleSection {
  id?: number;
  name?: string;
  section?: number;
  visible?: number;
  modules?: MoodleModule[];
}

/**
 * Convierte `core_course_get_contents` en apuntes: un registro por archivo o
 * recurso, con su tema (sección) y su enlace. Nada inventado: si un módulo no
 * trae contenido, no genera apunte.
 */
export function mapCourseMaterials(sections: MoodleSection[]): MoodleMaterialDraft[] {
  const out: MoodleMaterialDraft[] = [];

  sections.forEach((section, index) => {
    if (section.visible === 0) return;
    const sectionName = (section.name || `Tema ${section.section ?? index + 1}`).trim().slice(0, MAX_MATERIAL_NAME);

    for (const mod of section.modules ?? []) {
      const cmid = mod.id ?? 0;
      const moduleName = (mod.name ?? '').trim();
      const modname = (mod.modname ?? 'resource').trim();
      if (mod.visible === 0) continue;

      const files = (mod.contents ?? []).filter(
        (content) => content.type === 'file' && Boolean(content.fileurl)
      );

      if (files.length > 0) {
        for (const file of files) {
          const fileName = (file.filename || moduleName || modname).trim().slice(0, MAX_MATERIAL_NAME);
          out.push({
            externalId: `${cmid}:${fileName.toLowerCase()}`,
            sectionName,
            name: fileName,
            moduleType: modname,
            moduleName: moduleName || null,
            mimeType: file.mimetype ?? null,
            sizeBytes: Number.isFinite(file.filesize) ? Number(file.filesize) : 0,
            modifiedAt: file.timemodified ? new Date(Number(file.timemodified) * 1000) : null,
            downloadUrl: stripTokenFromUrl(file.fileurl!),
            webUrl: mod.url ?? null,
          });
        }
        continue;
      }

      // Recursos sin archivo (páginas, enlaces, carpetas vacías): apunte con su URL.
      if (NON_MATERIAL_MODULES.has(modname) || !mod.url) continue;
      const name = (moduleName || modname).trim().slice(0, MAX_MATERIAL_NAME);
      out.push({
        externalId: `${cmid}:${name.toLowerCase()}`,
        sectionName,
        name,
        moduleType: modname,
        moduleName: moduleName || null,
        mimeType: null,
        sizeBytes: 0,
        modifiedAt: null,
        downloadUrl: null,
        webUrl: mod.url,
      });
    }
  });

  return out;
}

interface MoodleAssignment {
  id?: number;
  cmid?: number;
  name?: string;
  intro?: string;
  duedate?: number;
  grade?: number;
  nosubmissions?: number;
}

interface MoodleAssignCourse {
  id?: number;
  fullname?: string;
  shortname?: string;
  assignments?: MoodleAssignment[];
}

interface MoodleSubmission {
  userid?: number;
  status?: string;
  graded?: boolean;
  grade?: number | null;
}

interface MoodleSubmissionsAssignment {
  assignmentid?: number;
  submissions?: MoodleSubmission[];
}

/**
 * Convierte las tareas reales de Moodle: `mod_assign_get_assignments` (qué hay
 * que entregar y cuándo) cruzado con `mod_assign_get_submissions` (si el alumno
 * ya lo entregó y si está corregida).
 */
export function mapAssignments(
  courses: MoodleAssignCourse[],
  submissions: MoodleSubmissionsAssignment[],
  userId: number,
  baseUrl: string
): MoodleTaskDraft[] {
  const byAssignment = new Map<number, MoodleSubmissionsAssignment>();
  for (const entry of submissions) {
    if (typeof entry.assignmentid === 'number') byAssignment.set(entry.assignmentid, entry);
  }

  const out: MoodleTaskDraft[] = [];

  for (const course of courses) {
    for (const assignment of course.assignments ?? []) {
      const assignmentId = assignment.id ?? 0;
      if (!assignmentId) continue;

      const mine = (byAssignment.get(assignmentId)?.submissions ?? []).find(
        (submission) => submission.userid === userId
      );

      const due = Number(assignment.duedate ?? 0);
      const intro = htmlToText(assignment.intro ?? '');

      out.push({
        assignmentId,
        title: (assignment.name ?? 'Tarea de Moodle').trim().slice(0, MAX_MATERIAL_NAME),
        description: intro.length > 0 ? intro.slice(0, 2000) : null,
        courseMoodleId: course.id ?? 0,
        courseName: (course.fullname || course.shortname || 'Moodle').trim(),
        dueDate: due > 0 ? new Date(due * 1000) : null,
        submitted: assignment.nosubmissions === 1 ? null : mine ? mine.status === 'submitted' : false,
        graded: Boolean(mine?.graded),
        grade: typeof mine?.grade === 'number' ? mine.grade : null,
        webUrl: `${baseUrl}/mod/assign/view.php?id=${assignment.cmid ?? assignmentId}`,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Cliente REST                                                        */
/* ------------------------------------------------------------------ */

type MoodleParams = Record<string, string | number | boolean>;

interface MoodleRaw {
  exception?: string;
  errorcode?: string;
  message?: string;
}

function flatParams(params: MoodleParams | undefined): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    body.append(key, String(value));
  }
  return body;
}

/**
 * Llama a una función de Web Services de Moodle. El token va en el cuerpo de la
 * petición (nunca en la URL) y los errores de Moodle se convierten en
 * MoodleError con un mensaje que se le pueda enseñar al alumno.
 */
export async function callMoodle<T>(
  baseUrl: string,
  token: string,
  wsfunction: string,
  params?: MoodleParams
): Promise<T> {
  const body = flatParams(params);
  body.append('wstoken', token);
  body.append('wsfunction', wsfunction);
  body.append('moodlewsrestformat', 'json');

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/webservice/rest/server.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'BrainUpAcademy/1.0 (cliente local de Moodle)',
      },
      body,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MoodleError(
      `No se pudo contactar con tu Moodle (${detail}). Comprueba la dirección del sitio y tu conexión.`,
      'network'
    );
  }

  const text = await response.text();

  if (!response.ok) {
    throw new MoodleError(
      `Tu Moodle respondió con HTTP ${response.status}. Comprueba que la dirección es correcta y que los servicios web están activados.`,
      'http_error'
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MoodleError(
      'Tu Moodle no ha devuelto JSON: parece que los servicios web están desactivados o la dirección no es la del sitio. Pide a tu centro que active los servicios web con protocolo REST.',
      'not_json'
    );
  }

  const raw = data as MoodleRaw;
  if (raw && (raw.exception || raw.errorcode)) {
    throw new MoodleError(describeMoodleError(raw.errorcode, raw.message), raw.errorcode ?? 'exception');
  }

  return data as T;
}

function describeMoodleError(errorcode?: string, message?: string): string {
  switch (errorcode) {
    case 'invalidtoken':
      return 'Ese token no es válido (o ha caducado). Genera otro en tu Moodle y vuelve a pegarlo.';
    case 'accessexception':
      return 'Tu token no tiene permiso para esta función. Pide a tu centro que habilite los servicios web para los alumnos.';
    case 'wsaccessdisabled':
    case 'enablewsdescription':
    case 'servicerequireslogin':
      return 'Los servicios web de tu Moodle están desactivados. Pide a tu centro que los activen (Administración del sitio → Servicios web).';
    case 'invalidparameter':
    case 'missingparam':
      return 'Moodle ha rechazado uno de los datos de la petición. Suele ser cosa de permisos del token.';
    default:
      return message ? `Moodle ha devuelto un error: ${message}` : 'Moodle ha devuelto un error inesperado.';
  }
}

/* ------------------------------------------------------------------ */
/* La vía fácil: usuario y contraseña → token                          */
/* ------------------------------------------------------------------ */

/**
 * Servicio de Moodle que usa la app oficial del móvil. Es el que trae las
 * funciones que BrainUp necesita, así que pedimos la clave para este servicio.
 */
export const MOODLE_MOBILE_SERVICE = 'moodle_mobile_app';

export interface MoodleTokenResult {
  token: string;
  /** Token privado de Moodle, si el sitio lo entrega (no lo usamos, no se guarda). */
  privateToken: string | null;
}

/**
 * Mensaje para el alumno según el errorcode que devuelve `login/token.php`.
 * Nunca se reenvía el texto crudo de Moodle: podría llevar datos de la petición.
 */
function describeTokenError(errorcode?: string): string {
  switch (errorcode) {
    case 'invalidlogin':
    case 'usernotloggedin':
    case 'invalidusername':
      return 'Tu usuario o tu contraseña de Moodle no son correctos. Revísalos y vuelve a probar. Ojo: si en tu centro entras con Google, Microsoft u otro acceso único (SSO), esta vía no sirve y tendrás que usar la clave de seguridad.';
    case 'enablewsdescription':
    case 'wsaccessdisabled':
    case 'servicerequireslogin':
      return 'Tu Moodle tiene los servicios web apagados, así que no puede darte una clave. Pide a tu centro que los active (Administración del sitio → Servicios web) o usa la alternativa del calendario iCal.';
    case 'servicedisabled':
      return 'En tu Moodle no está habilitado el servicio «Servicios web móviles», que es el que permite pedir la clave con tu usuario. Pide a tu centro que lo active, o usa la clave de seguridad / el calendario iCal.';
    case 'sitemaintenance':
      return 'Tu Moodle está en mantenimiento ahora mismo. Inténtalo dentro de un rato.';
    case 'missingusername':
    case 'missingpassword':
      return 'Moodle no ha recibido tu usuario o tu contraseña. Vuelve a escribirlos y prueba otra vez.';
    default:
      return errorcode
        ? `Tu Moodle no ha dado la clave (${errorcode}). Revisa la dirección del sitio y tus datos de acceso, o usa la vía de la clave de seguridad.`
        : 'Tu Moodle no ha dado la clave. Revisa la dirección del sitio y tus datos de acceso, o usa la vía de la clave de seguridad.';
  }
}

/**
 * Pide a Moodle un token de Web Services con el usuario y la contraseña del
 * alumno: `POST {sitio}/login/token.php` con `service=moodle_mobile_app`, que
 * es exactamente lo que hace la app oficial de Moodle.
 *
 * REGLA DE LA CONTRASEÑA: se usa aquí y se olvida. No se guarda, no se registra
 * en el log y no se devuelve nunca hacia arriba ni se repite en los mensajes.
 */
export async function requestMoodleToken(
  rawBaseUrl: string,
  username: string,
  password: string,
  service: string = MOODLE_MOBILE_SERVICE
): Promise<MoodleTokenResult> {
  const baseUrl = normalizeMoodleBaseUrl(rawBaseUrl);
  if (!baseUrl) {
    throw new MoodleError(
      'La dirección de tu Moodle no es válida. Debe ser algo como https://moodle.tuinstituto.es',
      'bad_url'
    );
  }

  const user = String(username ?? '').trim();
  if (!user) throw new MoodleError('Escribe tu usuario de Moodle.', 'missingusername');
  if (!String(password ?? '')) {
    throw new MoodleError('Escribe tu contraseña de Moodle.', 'missingpassword');
  }

  const body = new URLSearchParams();
  body.append('username', user);
  body.append('password', String(password));
  body.append('service', service);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/login/token.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'BrainUpAcademy/1.0 (conexión local de Moodle)',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MoodleError(
      `No se pudo contactar con tu Moodle (${detail}). Comprueba la dirección del sitio y tu conexión.`,
      'network'
    );
  }

  if (!response.ok) {
    throw new MoodleError(
      `Tu Moodle respondió con HTTP ${response.status} al pedirle la clave. Comprueba que la dirección es la del sitio donde entras a tus cursos.`,
      'http_error'
    );
  }

  const text = await response.text();

  let payload: { token?: string; privatetoken?: string; errorcode?: string } | null = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!payload) {
    throw new MoodleError(
      'Tu Moodle no ha respondido con el formato esperado al pedirle la clave: puede que en tu centro el acceso con usuario y contraseña esté cerrado. Prueba con la vía de la clave de seguridad.',
      'not_json'
    );
  }

  const token = String(payload.token ?? '').trim();
  if (token) {
    return { token, privateToken: payload.privatetoken ? String(payload.privatetoken) : null };
  }

  throw new MoodleError(describeTokenError(payload.errorcode), payload.errorcode ?? 'token_error');
}

export async function getSiteInfo(baseUrl: string, token: string): Promise<MoodleSiteInfo> {
  const raw = await callMoodle<{
    sitename?: string;
    username?: string;
    userid?: number;
    release?: string;
    functions?: Array<{ name?: string }>;
  }>(baseUrl, token, 'core_webservice_get_site_info');

  return {
    siteName: (raw.sitename ?? 'Moodle').trim(),
    userName: (raw.username ?? '').trim(),
    userId: Number(raw.userid ?? 0),
    release: raw.release ?? null,
    functions: (raw.functions ?? []).map((fn) => fn.name ?? '').filter(Boolean),
  };
}

/** Funciones imprescindibles que le faltan al token (lista para el alumno). */
export function missingMoodleFunctions(site: MoodleSiteInfo): string[] {
  const available = new Set(site.functions);
  return REQUIRED_MOODLE_FUNCTIONS.filter((name) => !available.has(name));
}

export async function getEnrolledCourses(
  baseUrl: string,
  token: string,
  userId: number
): Promise<MoodleCourseInfo[]> {
  const raw = await callMoodle<
    Array<{ id?: number; fullname?: string; shortname?: string }>
  >(baseUrl, token, 'core_enrol_get_users_courses', { userid: userId });

  return (Array.isArray(raw) ? raw : [])
    .filter((course) => typeof course.id === 'number')
    .map((course) => ({
      moodleId: course.id!,
      fullName: (course.fullname ?? 'Curso').trim(),
      shortName: (course.shortname ?? '').trim(),
    }));
}

export async function getCourseContents(
  baseUrl: string,
  token: string,
  courseIds: number[]
): Promise<Map<number, MoodleSection[]>> {
  const out = new Map<number, MoodleSection[]>();
  // `core_course_get_contents` es de un curso por llamada: se pide uno a uno
  // para poder decir exactamente cuál falla si algo va mal.
  for (const courseId of courseIds) {
    const sections = await callMoodle<MoodleSection[]>(baseUrl, token, 'core_course_get_contents', {
      courseid: courseId,
    });
    out.set(courseId, Array.isArray(sections) ? sections : []);
  }
  return out;
}

export async function getAssignments(
  baseUrl: string,
  token: string,
  courseIds: number[]
): Promise<MoodleAssignCourse[]> {
  if (courseIds.length === 0) return [];
  const params: MoodleParams = {};
  courseIds.forEach((id, index) => {
    params[`courseids[${index}]`] = id;
  });

  const raw = await callMoodle<{ courses?: MoodleAssignCourse[] }>(
    baseUrl,
    token,
    'mod_assign_get_assignments',
    params
  );
  return raw.courses ?? [];
}

export async function getSubmissions(
  baseUrl: string,
  token: string,
  assignmentIds: number[]
): Promise<MoodleSubmissionsAssignment[]> {
  if (assignmentIds.length === 0) return [];
  const params: MoodleParams = {};
  assignmentIds.forEach((id, index) => {
    params[`assignmentids[${index}]`] = id;
  });
  params.capabilities = 'submissions';

  const raw = await callMoodle<{ assignments?: MoodleSubmissionsAssignment[] }>(
    baseUrl,
    token,
    'mod_assign_get_submissions',
    params
  );
  return raw.assignments ?? [];
}
