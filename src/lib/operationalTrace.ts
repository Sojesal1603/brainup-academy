/**
 * Los rastros de funcionamiento del sistema.
 *
 * El taller ya miraba **los datos** (títulos, numeración, calendarios de repaso…).
 * Lo que no miraba era **cómo va la app por dentro**: cuándo se ha caído, cuántas
 * veces, si el servidor dejó de responder, si los modelos de IA están fallando.
 * Todo eso se estaba escribiendo en `data/logs/` y nadie lo leía: por eso había
 * fallos (una página en blanco, un corte) que el alumno veía y el sistema no.
 *
 * Este módulo lee ese texto y lo convierte en hallazgos con su causa, en el mismo
 * formato que el resto del motor. Es **puro** a propósito: recibe texto y devuelve
 * datos, así que se puede probar con un log de mentira y no depende de que la app
 * esté en marcha (cuando la app está caída es justo cuando más falta hace).
 *
 * Tres reglas:
 *
 *   1. **La causa, no el síntoma.** Un hallazgo de estos no dice «algo fue mal»:
 *      dice «el servidor se ha caído 6 veces desde las 18:40 y el motivo que
 *      reporta es código 3221225794».
 *   2. **Nada de falsos positivos.** Un log antiguo no es un fallo de ahora: lo
 *      que pasó hace tres horas se cuenta como historial y no dispara arreglos.
 *   3. **El arreglo tiene que estar justificado.** Reiniciar la app solo se
 *      propone cuando hay un bucle **reciente** y repetido; si no, se cuenta y se
 *      deja en paz.
 */

import type { MaintenanceFinding, MaintenanceFix, MaintenanceSeverity } from './maintenance';

/* ------------------------------------------------------------------ */
/* Tipos                                                              */
/* ------------------------------------------------------------------ */

export interface TraceEntry {
  /** Hora de la línea, en ISO (los logs escriben en UTC). */
  at: string;
  text: string;
}

export interface AiFailureEntry extends TraceEntry {
  provider: string;
  model: string;
  /** «quota», «error», «timeout»… según lo que apunte el motor de IA. */
  kind: string;
  attempts: number | null;
  httpStatus: number | null;
}

export interface OperationalTrace {
  /** ¿Se ha podido leer cada log? (que no exista no es un fallo: puede ser nuevo). */
  serverLogFound: boolean;
  vigilanteLogFound: boolean;
  /** Última hora escrita en cada log (para saber si el sistema sigue vivo). */
  serverLogAt: string | null;
  vigilanteLogAt: string | null;
  /** Caídas y reinicios del servidor de la app (los que NO ha pedido el mantenimiento). */
  crashes: TraceEntry[];
  /**
   * Reinicios que ha pedido el propio mantenimiento (un arreglo). Se cuentan
   * aparte a propósito: si se contaran como caídas, el sistema se reiniciaría a sí
   * mismo en bucle, porque cada reinicio suyo parecería una caída nueva. Es el
   * error de diseño que se vio al probarlo y por eso están separados.
   */
  intentionalRestarts: TraceEntry[];
  /** «salud: sin respuesta»: la app no contestaba. */
  healthFailures: TraceEntry[];
  /** El vigilante avisó de que los reinicios se estaban espaciando (tormenta). */
  storms: TraceEntry[];
  /** Fallos de los proveedores de IA. */
  aiFailures: AiFailureEntry[];
  /** Cosas que una ronda del vigilante no pudo terminar. */
  roundProblems: TraceEntry[];
  /** Errores de ejecución o compilación de la app. */
  appErrors: TraceEntry[];
  /**
   * La última noticia de salud que hay en el log del servidor: `ok`, `fail` (no
   * contestaba) o `null` (no hay noticias). Es lo que permite detectar un bucle
   * de caídas desde dentro de la app, sin preguntarle a nadie.
   */
  lastHealthState: 'ok' | 'fail' | null;
  /** Lo que da la app cuando se le pregunta por su salud (lo rellena el vigilante). */
  health: { reachable: boolean; ok: boolean; detail: string } | null;
}

/** Ventanas de tiempo: lo viejo es historial, no un fallo de ahora. */
export const SERVER_WINDOW_MS = 6 * 60 * 60 * 1000;
/** La IA falla por cupos que se recuperan rápido: mirar más atrás solo hace ruido. */
export const AI_WINDOW_MS = 2 * 60 * 60 * 1000;
/** A partir de aquí se considera «pasa ahora» (y un arreglo está justificado). */
export const RECENT_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Lectura del texto                                                  */
/* ------------------------------------------------------------------ */

/**
 * Los logs escriben `[2026-10-14 15:26:36]` con `toISOString()`, así que la hora
 * es UTC. Se parsea como tal para no desplazar los fallos dos horas (que es
 * exactamente lo que haría una comparación en hora local).
 */
function parseStamp(line: string): string | null {
  const match = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Parte un log en líneas con su hora. Las líneas que no traen sello (las de Next,
 * por ejemplo) heredan la hora de la última que sí lo traía: siguen siendo útiles
 * como causa aunque no sepan cuándo pasaron.
 */
function splitLines(text: string): TraceEntry[] {
  const out: TraceEntry[] = [];
  let lastAt: string | null = null;

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) continue;

    const stamp = parseStamp(line);
    if (stamp) lastAt = stamp;
    if (!lastAt) continue; // antes del primer sello no se puede colocar en el tiempo

    out.push({ at: lastAt, text: line.trim() });
  }

  return out;
}

function within(entry: TraceEntry, now: Date, windowMs: number): boolean {
  return now.getTime() - new Date(entry.at).getTime() <= windowMs;
}

function lastStamp(entries: TraceEntry[]): string | null {
  return entries.length > 0 ? entries[entries.length - 1].at : null;
}

/* ------------------------------------------------------------------ */
/* Reconocimiento de líneas                                           */
/* ------------------------------------------------------------------ */

const CRASH_RE = /el servidor ha terminado|el servidor se ha ca[íi]do/i;
/**
 * Marca que escribe `serverControl` justo antes de reiniciar a propósito. Cualquier
 * parada del servidor que venga detrás (hasta tres minutos después) es un arreglo,
 * no una caída.
 */
const INTENTIONAL_RE = /reinicio pedido por el mantenimiento/i;
const INTENTIONAL_WINDOW_MS = 3 * 60 * 1000;
const HEALTH_FAIL_RE = /salud:\s*(sin respuesta|HTTP [45]\d\d)/i;
const HEALTH_OK_RE = /la app vuelve a responder|Ready in \d/i;
const STORM_RE = /muchas ca[íi]das seguidas|tres comprobaciones sin responder/i;
/**
 * `[ia] gemini:gemini-3.8-flash falló (error, HTTP 502) tras 3 intentos: …`
 *
 * Ojo: estas líneas las escribe el motor de IA **sin hora delante** (heredan la de
 * la última línea con sello), así que el patrón tiene que valer tanto con hora
 * como sin ella. Exigir el sello fue el primer error de este parser.
 */
const AI_FAIL_RE = /(?:^|\]\s)\[ia\]\s+([^:\s]+):(\S+)\s+fall[óo]\s*\(([^)]*)\)(?:\s+tras\s+(\d+)\s+intentos?)?\s*:\s*(.*)$/i;
const ROUND_PROBLEM_RE = /ERROR al cargar los datos|la IA no ha podido ayudar|no se ha podido (abrir|cerrar) la incidencia|no se ha podido revisar/i;
/** Errores de la app: los que pinta Next (`⨯`), excepciones sin capturar, fallos de compilación. */
const APP_ERROR_RE = /^\s*⨯|Unhandled|Module not found|TypeError:|ReferenceError:|SyntaxError:|Failed to compile|Error: ENOENT/i;

/** «código 3221225794», «señal SIGKILL»… para poder citar el motivo exacto. */
export function crashCause(entry: TraceEntry): string {
  const code = entry.text.match(/c[óo]digo\s+([^\s,)]+)/i);
  const signal = entry.text.match(/se[ñn]al\s+([^\s,)]+)/i);
  const parts: string[] = [];
  if (code) parts.push(`código ${code[1]}`);
  if (signal && signal[1] !== '-') parts.push(`señal ${signal[1]}`);
  return parts.join(' · ');
}

/** El código 3221225794 es 0xC0000142 en Windows: el proceso no llegó a arrancar. */
export function describeExitCode(entry: TraceEntry): string | null {
  if (/3221225794/.test(entry.text)) {
    return 'el proceso no llegó a arrancar (0xC0000142 en Windows)';
  }
  if (/3221225786|STATUS_CONTROL_C_EXIT/.test(entry.text)) {
    return 'alguien cerró el proceso (Ctrl+C o cierre de la consola)';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Construcción del rastro                                            */
/* ------------------------------------------------------------------ */

export function buildTrace(input: {
  serverLog?: string | null;
  vigilanteLog?: string | null;
  /**
   * `errores-app.log`: lo que escribe la propia app cuando una petición revienta
   * (ver `src/instrumentation.ts`). Aquí **cada línea es un error por
   * construcción**, así que no hay que adivinar: se cuentan todas.
   */
  appLog?: string | null;
  now?: Date;
}): OperationalTrace {
  const now = input.now ?? new Date();
  const serverEntries = input.serverLog ? splitLines(input.serverLog) : [];
  const vigilanteEntries = input.vigilanteLog ? splitLines(input.vigilanteLog) : [];
  const appEntries = input.appLog ? splitLines(input.appLog) : [];

  const crashes: TraceEntry[] = [];
  const intentionalRestarts: TraceEntry[] = [];
  const healthFailures: TraceEntry[] = [];
  const storms: TraceEntry[] = [];
  const appErrors: TraceEntry[] = [];
  let lastHealthState: 'ok' | 'fail' | null = null;
  let intentionalAt: number | null = null;

  // Los errores que registra la propia app van primero: son los de verdad.
  for (const entry of appEntries) appErrors.push(entry);

  for (const entry of serverEntries) {
    const at = new Date(entry.at).getTime();

    if (INTENTIONAL_RE.test(entry.text)) {
      intentionalAt = at;
      continue;
    }

    if (CRASH_RE.test(entry.text)) {
      // ¿Lo hemos pedido nosotros hace un momento? Entonces es un arreglo.
      if (intentionalAt !== null && Math.abs(at - intentionalAt) <= INTENTIONAL_WINDOW_MS) {
        intentionalRestarts.push(entry);
      } else {
        crashes.push(entry);
      }
    }
    if (HEALTH_FAIL_RE.test(entry.text)) {
      healthFailures.push(entry);
      lastHealthState = 'fail';
    } else if (HEALTH_OK_RE.test(entry.text)) {
      lastHealthState = 'ok';
    }
    if (STORM_RE.test(entry.text)) storms.push(entry);
    if (APP_ERROR_RE.test(entry.text)) appErrors.push(entry);
  }

  const aiFailures: AiFailureEntry[] = [];
  const roundProblems: TraceEntry[] = [];

  for (const entry of vigilanteEntries) {
    const ai = entry.text.match(AI_FAIL_RE);
    if (ai) {
      const http = ai[3].match(/HTTP\s+(\d{3})/i);
      aiFailures.push({
        at: entry.at,
        text: entry.text,
        provider: ai[1],
        model: ai[2],
        kind: (ai[3].split(',')[0] || 'error').trim().toLowerCase(),
        attempts: ai[4] ? Number(ai[4]) : null,
        httpStatus: http ? Number(http[1]) : null,
      });
      continue;
    }
    if (ROUND_PROBLEM_RE.test(entry.text)) roundProblems.push(entry);
  }

  return {
    serverLogFound: serverEntries.length > 0,
    vigilanteLogFound: vigilanteEntries.length > 0,
    serverLogAt: lastStamp(serverEntries),
    vigilanteLogAt: lastStamp(vigilanteEntries),
    crashes,
    intentionalRestarts,
    healthFailures,
    storms,
    aiFailures,
    roundProblems,
    appErrors,
    lastHealthState,
    health: null,
  };
}

/* ------------------------------------------------------------------ */
/* Las comprobaciones                                                 */
/* ------------------------------------------------------------------ */

/** ¿Se ha caído la app hace poco? (Lo viejo es historial, no un fallo de ahora.) */
export function crashedRecently(trace: OperationalTrace, now: Date): boolean {
  const last = trace.crashes[trace.crashes.length - 1];
  return Boolean(last) && within(last, now, RECENT_MS);
}

/**
 * ¿Merece la pena reiniciar la app ahora mismo?
 *
 * Tres condiciones, y las tres hacen falta:
 *
 *   1. **Dos caídas o más** en la ventana: una sola caída ya la levanta el
 *      servidor vigilado solo, y reiniciar por eso sería moverse por nada.
 *   2. **La última es reciente** (media hora): un bucle de esta mañana ya no está
 *      pasando, así que se cuenta como historial y no se toca nada.
 *   3. **No lo hemos intentado ya hace poco.** Esto es lo que evita el bucle: el
 *      reinicio del mantenimiento queda marcado en el diario, y sin esta condición
 *      cada arreglo parecería un problema nuevo y el sistema se reiniciaría
 *      indefinidamente. Como mucho, un reinicio automático cada media hora.
 */
export function restartIsJustified(trace: OperationalTrace, now: Date): boolean {
  const crashes = trace.crashes.filter((entry) => within(entry, now, SERVER_WINDOW_MS));
  if (crashes.length < 2) return false;

  const last = crashes[crashes.length - 1];
  if (!within(last, now, RECENT_MS)) return false;

  const lastIntentional = trace.intentionalRestarts[trace.intentionalRestarts.length - 1];
  if (lastIntentional && within(lastIntentional, now, RECENT_MS)) return false;

  return true;
}

/**
 * Hallazgos de funcionamiento. Mismo formato que los del temario, para que el
 * taller, las incidencias y la IA los traten igual que cualquier otro problema.
 */
export function runOperationalChecks(trace: OperationalTrace, now: Date = new Date()): MaintenanceFinding[] {
  const findings: MaintenanceFinding[] = [];

  /* --- La app no responde --- */
  const noResponde =
    (trace.health !== null && !trace.health.reachable) ||
    (trace.health === null && trace.lastHealthState === 'fail');
  if (noResponde) {
    findings.push({
      id: 'servidor_caido',
      severity: 'critico',
      title: 'La app no está respondiendo',
      detail:
        trace.health && !trace.health.reachable
          ? `El servidor local no contesta al parte de salud (${trace.health.detail}). Mientras no responda, el navegador te enseñará eso de «no se puede acceder a este sitio web».`
          : 'El servidor local dejó de contestar al parte de salud y no hay constancia de que se haya recuperado. El vigilante lo levanta solo; si no vuelve, aquí queda anotado.',
      count: Math.max(1, trace.healthFailures.length),
      fixable: true,
      fixLabel: 'Levantar la app (servidor vigilado)',
      samples: trace.healthFailures.slice(-2).map((entry) => entry.text),
    });
  }

  /* --- Bucle de caídas --- */
  const crashes = trace.crashes.filter((entry) => within(entry, now, SERVER_WINDOW_MS));
  if (crashes.length > 0) {
    const recent = crashedRecently(trace, now);
    const severity: MaintenanceSeverity = crashes.length >= 3 && recent ? 'critico' : 'aviso';
    const causes = [...new Set(crashes.map((entry) => describeExitCode(entry) ?? crashCause(entry)).filter(Boolean))];
    const horas = Math.round(SERVER_WINDOW_MS / 3600000);

    findings.push({
      id: 'servidor_inestable',
      severity,
      title: crashes.length === 1 ? 'El servidor se ha caído una vez' : `El servidor se ha caído ${crashes.length} veces`,
      detail: [
        `El servidor de la app se ha caído ${crashes.length} vez(ces) en las últimas ${horas} horas${
          recent ? ' y la última es de hace menos de media hora' : '; la última ya tiene un rato'
        }.`,
        causes.length > 0 ? `Motivo que reporta: ${causes.join(' · ')}.` : '',
        crashes.length >= 3 && recent
          ? 'Con tantas seguidas la app te da ratos sin servicio aunque se reinicie sola: se reinicia limpia y queda anotado.'
          : 'El servidor vigilado lo levanta solo, así que la app vuelve; se cuenta para saber que pasa.',
      ]
        .filter(Boolean)
        .join(' '),
      count: crashes.length,
      fixable: restartIsJustified(trace, now),
      fixLabel: restartIsJustified(trace, now) ? 'Reiniciar la app' : undefined,
      samples: crashes.slice(-3).map((entry) => `${entry.at.slice(11, 19)} · ${entry.text.slice(0, 120)}`),
    });
  }

  /* --- Reinicios que ha pedido el mantenimiento (a la vista, no a escondidas) --- */
  const pedidos = trace.intentionalRestarts.filter((entry) => within(entry, now, SERVER_WINDOW_MS));
  if (pedidos.length > 0) {
    findings.push({
      id: 'reinicios_pedidos',
      severity: 'info',
      title: pedidos.length === 1 ? 'Reinicio de la app pedido por el mantenimiento' : `Reinicios de la app pedidos por el mantenimiento (${pedidos.length})`,
      detail:
        'El mantenimiento ha reiniciado la app a propósito (un arreglo, no una caída). Se cuenta para que el registro cuadre: nada de lo que hace el sistema se hace a escondidas.',
      count: pedidos.length,
      fixable: false,
      samples: pedidos.slice(-2).map((entry) => `${entry.at.slice(11, 19)} · ${entry.text.slice(0, 110)}`),
    });
  }

  /* --- Tormenta de reinicios (el propio vigilante avisó) --- */
  const storms = trace.storms.filter((entry) => within(entry, now, SERVER_WINDOW_MS));
  if (storms.length > 0 && crashes.length < 3) {
    findings.push({
      id: 'servidor_tormenta',
      severity: 'aviso',
      title: 'Reinicios espaciados por caídas repetidas',
      detail:
        'El servidor vigilado se ha visto obligado a espaciar los reinicios porque se caía una y otra vez. Se levanta solo, pero la causa sigue ahí: aquí queda el aviso.',
      count: storms.length,
      fixable: false,
      samples: storms.slice(-2).map((entry) => entry.text.slice(0, 140)),
    });
  }

  /* --- Errores de la propia app --- */
  const appErrors = trace.appErrors.filter((entry) => within(entry, now, SERVER_WINDOW_MS));
  if (appErrors.length > 0) {
    const repeated = appErrors.length >= 3;
    findings.push({
      id: 'errores_de_app',
      severity: repeated ? 'critico' : 'aviso',
      title: repeated ? `Errores repetidos en la app (${appErrors.length})` : 'Errores anotados en la app',
      detail: repeated
        ? `La app ha soltado ${appErrors.length} errores de ejecución o compilación en las últimas horas: uno suelto se puede ignorar, repetido significa que algo está roto de verdad.`
        : 'Se ha anotado algún error de ejecución o compilación. Un error suelto puede ser de una petición mala; si se repite, aquí se verá.',
      count: appErrors.length,
      fixable: repeated && restartIsJustified(trace, now),
      fixLabel: repeated && restartIsJustified(trace, now) ? 'Reiniciar la app' : undefined,
      samples: appErrors.slice(-3).map((entry) => entry.text.slice(0, 140)),
    });
  }

  /* --- La IA fallando --- */
  const aiFailures = trace.aiFailures.filter((entry) => within(entry, now, AI_WINDOW_MS));
  if (aiFailures.length > 0) {
    const quotas = aiFailures.filter((entry) => entry.kind.includes('quota')).length;
    const porProveedor = new Map<string, number>();
    for (const entry of aiFailures) porProveedor.set(entry.provider, (porProveedor.get(entry.provider) ?? 0) + 1);
    const reparto = [...porProveedor.entries()].map(([provider, count]) => `${provider} ×${count}`).join(' · ');
    const modelos = [...new Set(aiFailures.map((entry) => entry.model))];

    findings.push({
      id: 'ia_fallando',
      severity: aiFailures.length >= 6 ? 'aviso' : 'info',
      title: `La IA ha fallado ${aiFailures.length} vez(ces)`,
      detail: [
        `Los modelos de IA han rechazado ${aiFailures.length} llamada(s) en las últimas horas (${reparto}).`,
        quotas > 0 ? `${quotas} de ellas por cupo agotado: es lo normal en las claves gratuitas a ciertas horas y se recupera solo.` : '',
        'La app va saltando de modelo y, si no queda ninguno libre, responde en modo local: no se queda muda, pero se nota en la espera. Con una clave de Groq de respaldo (gratis) se tapa casi siempre.',
      ]
        .filter(Boolean)
        .join(' '),
      count: aiFailures.length,
      fixable: false,
      samples: modelos.slice(0, 4).map((model) => model),
    });
  }

  /* --- Lo que una ronda no pudo terminar --- */
  const roundProblems = trace.roundProblems.filter((entry) => within(entry, now, SERVER_WINDOW_MS));
  if (roundProblems.length > 0) {
    findings.push({
      id: 'ronda_incompleta',
      severity: 'aviso',
      title: 'Una revisión de mantenimiento no terminó',
      detail:
        'Alguna ronda del vigilante se quedó a medias (no pudo cargar los datos o no pudo anotar algo). Se cuenta aquí porque una ronda que no termina es una revisión que no se ha hecho.',
      count: roundProblems.length,
      fixable: false,
      samples: roundProblems.slice(-2).map((entry) => entry.text.slice(0, 140)),
    });
  }

  const order: Record<MaintenanceSeverity, number> = { critico: 0, aviso: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

/* ------------------------------------------------------------------ */
/* Los arreglos                                                       */
/* ------------------------------------------------------------------ */

/**
 * Los arreglos que se pueden hacer sin preguntar: levantar la app si está caída y
 * reiniciarla si está en bucle. Los dos son reversibles y no tocan ni un dato.
 *
 * Si no hay nada que justifique un reinicio, no se propone nada: el motor no
 * inventa trabajo.
 */
export function buildOperationalFixes(
  trace: OperationalTrace,
  findings: MaintenanceFinding[],
  now: Date = new Date()
): MaintenanceFix[] {
  const fixes: MaintenanceFix[] = [];
  const byId = new Map(findings.map((finding) => [finding.id, finding] as const));

  const caido = byId.get('servidor_caido');
  if (caido?.fixable) {
    fixes.push({
      id: 'servidor_caido',
      label: caido.fixLabel ?? 'Levantar la app (servidor vigilado)',
      description:
        'Arranca el servidor vigilado si no está en marcha. Es lo mismo que haría el vigilante por su cuenta: la app vuelve a responder sin que nadie toque nada.',
      count: 1,
      safe: true,
      operations: [{ kind: 'start_server' }],
    });
  }

  const inestable = byId.get('servidor_inestable');
  if (inestable?.fixable) {
    fixes.push({
      id: 'servidor_inestable',
      label: inestable.fixLabel ?? 'Reiniciar la app',
      description:
        'Cierra el proceso del servidor para que el servidor vigilado lo levante limpio (tarda un par de segundos). No toca la base: nada de lo tuyo se pierde.',
      count: 1,
      safe: true,
      operations: [{ kind: 'restart_server' }],
    });
  }

  const errores = byId.get('errores_de_app');
  if (errores?.fixable && !inestable?.fixable && trace.crashes.length === 0) {
    fixes.push({
      id: 'errores_de_app',
      label: errores.fixLabel ?? 'Reiniciar la app',
      description:
        'Reinicia el servidor para que arranque limpio después de una racha de errores repetidos. No toca ningún dato.',
      count: 1,
      safe: true,
      operations: [{ kind: 'restart_server' }],
    });
  }

  return fixes;
}
