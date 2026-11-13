import { db } from './db';
import { resolveBackgroundUserId } from './backgroundUser';
import { loadMaintenanceInput } from './maintenanceData';
import {
  SRS_MAX_EASE,
  SRS_MAX_INTERVAL_DAYS,
  SRS_MIN_EASE,
  VIGILANTE_ACTIONS,
  claimsUnmeasuredReading,
  normalizeTitle,
  parseAuditReply,
  tidyTitle,
  type MaintenanceFinding,
  type MaintenanceFix,
  type MaintenanceInput,
  type MaintenanceOperation,
  type MaintenanceTopicRow,
} from './maintenance';
import { allFixes, scanAll } from './maintenanceScan';
import { applyFixPlan, applyMaintenanceFixes } from './maintenanceApply';
import {
  getConfiguredProviders,
  getCooldownSeconds,
  getCandidateChain,
  hasAiProvider,
  isQuotaTight,
  runAiText,
} from './aiEngine';
import { MEMORY_SCOPE_MAINTENANCE, loadMemoryBlock, saveDayMemory } from './agentMemory';
import { triageReportedIssues as runIssueTriage } from './issueTriage';
import { healMoodleConnection } from './moodleSelfHeal';
import { snapshotTemarioIfStale } from './temarioRestore';

/**
 * El vigilante: la ronda de mantenimiento que se hace sola.
 *
 * Esto es lo que responde a la pregunta «¿y si yo no estoy delante?». El motor de
 * `maintenance.ts` dice qué no cuadra; aquí se decide qué se arregla sin
 * preguntar, qué necesita a la IA y qué se apunta como incidencia para que el
 * alumno lo vea en el taller.
 *
 * El reparto de responsabilidades es deliberado:
 *
 *   1. **Las reglas arreglan lo reversible**: renombrar, renumerar, acotar un
 *      rango, quitar una unidad duplicada que no tiene nada colgando. Nunca
 *      borra nada con datos dentro.
 *   2. **La IA solo entra donde las reglas no llegan** (una unidad que no
 *      pertenece a esa asignatura, un temario sin orden lógico) y **propone en
 *      un vocabulario cerrado**: líneas `ACCION | id | dato` que se validan una a
 *      una antes de tocar nada. La IA no escribe código ni frases libres en la
 *      base: elige entre las operaciones que ya existen.
 *   3. **Lo que no se puede arreglar se cuenta**: se abre una incidencia, con el
 *      resumen que dé la IA si lo hay, y se cierra sola cuando la comprobación
 *      deja de detectarla.
 *
 * Todo lo de este fichero se ejecuta también fuera de una petición de Next (es
 * lo que hace `npm run vigilante`), así que no puede depender de `next/cache`
 * ni de nada exclusivo del servidor de Next.
 */

export interface VigilanteHealth {
  reachable: boolean;
  ok: boolean;
  detail: string;
  responseMs: number;
  database: string;
  aiProviders: string[];
}

export interface VigilanteReport {
  startedAt: string;
  finishedAt: string;
  health: VigilanteHealth;
  findingsBefore: MaintenanceFinding[];
  findingsAfter: MaintenanceFinding[];
  applied: Array<{ id: string; label: string; count: number }>;
  problems: string[];
  ai: {
    configured: boolean;
    providers: string[];
    asked: boolean;
    model: string | null;
    proposals: Array<{ action: string; target: string; reason: string }>;
    applied: number;
    summary: string | null;
    error: string | null;
  };
  issues: { opened: string[]; resolved: string[] };
  notes: string[];
  /** Una frase para el log: qué ha pasado en esta ronda. */
  headline: string;
}

export interface VigilanteOptions {
  /** Cuenta cuyos datos se revisan. Sin esto se resuelve el único perfil. */
  userId?: string;
  /** Dónde preguntar por la salud de la app. */
  serverUrl?: string;
  /** Aplicar los arreglos marcados como seguros. Por defecto, sí. */
  autoFix?: boolean;
  /** Pedir a la IA un plan para lo que las reglas no cubren. Por defecto, sí. */
  askAi?: boolean;
  /** Mirar sin tocar nada (diagnóstico). */
  dry?: boolean;
  /** Cómo se cuentan las cosas: el script lo escribe en su log. */
  log?: (line: string) => void;
}

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';
/** Tope de cambios de la IA por ronda: una IA desbocada no puede tocar 60 unidades. */
const MAX_AI_OPERATIONS = 25;
/** Cuántas unidades se le enseñan a la IA como mucho. */
const AI_LISTING_LIMIT = 80;

/* ------------------------------------------------------------------ */
/* Salud de la app                                                     */
/* ------------------------------------------------------------------ */

/** Pregunta a `/api/salud`. Nunca lanza: un fallo de red es un dato, no una excepción. */
export async function checkHealth(serverUrl: string = DEFAULT_SERVER_URL): Promise<VigilanteHealth> {
  const startedAt = Date.now();
  const url = `${serverUrl.replace(/\/$/, '')}/api/salud`;

  try {
    const response = await fetch(url, {
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      headers: { 'Cache-Control': 'no-store' },
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      database?: { ok?: boolean; detail?: string; counts?: { subjects?: number; topics?: number; notes?: number } };
      ai?: { providers?: string[] };
    };

    const counts = body.database?.counts;
    const detail = body.ok
      ? `${counts?.topics ?? 0} unidades · ${counts?.subjects ?? 0} materias · ${counts?.notes ?? 0} apuntes`
      : body.database?.detail || `la app responde HTTP ${response.status} con ok=false`;

    return {
      reachable: true,
      ok: response.status === 200 && body.ok === true,
      detail,
      responseMs: Date.now() - startedAt,
      database: body.database?.ok ? 'ok' : detail,
      aiProviders: body.ai?.providers ?? [],
    };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      responseMs: Date.now() - startedAt,
      database: 'sin contacto',
      aiProviders: [],
    };
  }
}

/* ------------------------------------------------------------------ */
/* Qué unidades están señaladas y qué se le puede proponer a la IA     */
/* ------------------------------------------------------------------ */

/**
 * Las unidades de las que hablan los hallazgos.
 *
 * Los hallazgos llevan ejemplos entre comillas («Título») y, a veces, la materia
 * entre paréntesis. Se usan justo para esto: para no mandarle a la IA el
 * expediente entero cuando el problema está en cuatro unidades.
 *
 * Devuelve además si se ha reconocido **alguna** unidad. Eso importa: si los
 * hallazgos no señalan a nada concreto (materias sin temario, por ejemplo) no hay
 * nada que la IA pueda decidir, y preguntarle con el expediente entero delante
 * sería invitarla a tocar unidades que no tienen ningún problema.
 */
export function collectInvolvedTopics(
  topics: MaintenanceTopicRow[],
  findings: MaintenanceFinding[]
): { topics: MaintenanceTopicRow[]; recognized: boolean } {
  const byNormalizedTitle = new Map<string, MaintenanceTopicRow[]>();
  for (const topic of topics) {
    const key = normalizeTitle(topic.title);
    byNormalizedTitle.set(key, [...(byNormalizedTitle.get(key) ?? []), topic]);
  }

  const involved = new Map<string, MaintenanceTopicRow>();
  const subjectsNamed = new Set<string>();

  for (const finding of findings) {
    for (const sample of finding.samples) {
      for (const match of sample.matchAll(/«([^»]+)»/g)) {
        const title = normalizeTitle(match[1].replace(/\s*\([^)]*\)\s*$/, ''));
        for (const topic of byNormalizedTitle.get(title) ?? []) involved.set(topic.id, topic);
      }
      for (const match of sample.matchAll(/\(([^)]+)\)\s*$/g)) {
        subjectsNamed.add(normalizeTitle(match[1]));
      }
    }
  }

  for (const topic of topics) {
    if (subjectsNamed.has(normalizeTitle(topic.subjectName))) involved.set(topic.id, topic);
  }

  const recognized = involved.size > 0;
  // Si no se ha reconocido nada (un hallazgo de sistema, por ejemplo), se le
  // enseña el expediente entero por si el hallazgo habla de algo que se lee
  // distinto; quien decide si se pregunta o no es `runVigilanteCycle`.
  const list = recognized ? [...involved.values()] : topics;
  return { topics: list.slice(0, AI_LISTING_LIMIT), recognized };
}

/** Una línea por unidad: lo que la IA necesita para decidir sin adivinar. */
function formatTopicLine(topic: MaintenanceTopicRow): string {
  const attached = topic.attached;
  const attachedTotal =
    attached.notes + attached.errors + attached.blocks + attached.sessions + attached.reviews;

  return [
    topic.id,
    topic.subjectName,
    topic.unitNumber ?? '-',
    tidyTitle(topic.title),
    topic.status,
    `nivel:${topic.masteryLevel}(${topic.masterySource})`,
    `srs:${topic.srsIntervalDays}d/${topic.srsEaseFactor}`,
    `datos:${attachedTotal}`,
  ].join(' | ');
}

const AI_SYSTEM_INSTRUCTION = [
  'Eres el técnico de mantenimiento de BrainUp Academy, una app de estudio para un alumno de Bachillerato.',
  'Recibes (1) lo que han detectado las comprobaciones automáticas y (2) las unidades afectadas, con su id.',
  'Tu trabajo es decidir qué unidades hay que tocar para que el temario quede ordenado y coherente, y explicarlo.',
  '',
  'FORMATO DE SALIDA — SOLO estas líneas, sin texto alrededor:',
  'ACCION | id_de_la_unidad | dato',
  'RESUMEN | una frase en castellano, para el alumno, sobre qué estaba mal y qué has hecho o qué haría falta',
  '',
  'Acciones admitidas (el id tiene que estar en la lista que recibes, jamás lo inventes):',
  '- renombrar | id | poner: Título nuevo   → solo si el título está mal escrito, cortado o lleva un prefijo de sobra',
  '- renumerar | id | 3                      → solo si la numeración está repetida o rota',
  '- limpiar | id                            → quitar espacios dobles y puntos finales del título',
  '- estado | id | pendiente|en_curso|visto|repasado  → solo si el estado no cuadra con lo que hay registrado',
  '- nivel | id                              → devolver el nivel a neutro (solo si está puesto sin ninguna medición detrás)',
  '- srs | id | días | facilidad             → acotar un intervalo imposible (días 1-180, facilidad 1.3-2.8)',
  '- dudar | id | motivo                     → si no está claro; no se aplica nada, solo se anota',
  '',
  'REGLAS QUE NO SE ROMPEN:',
  '- No inventes unidades: solo puedes hablar de las que aparecen en la lista con su id.',
  '- Nunca propongas borrar datos. Tú ordenas, no eliminas.',
  '- Si una unidad tiene datos (datos>0), no le cambies el título por capricho: solo si está claramente roto.',
  '- Si no hay nada que arreglar, escribe solo la línea RESUMEN diciendo que el temario está bien.',
  '- Máximo una línea por unidad. Como mucho 25 líneas.',
].join('\n');

/** Convierte lo que ha dicho la IA en un plan de operaciones **validado**. */
export function buildAiFix(
  raw: string,
  topics: MaintenanceTopicRow[]
): { fix: MaintenanceFix | null; proposals: Array<{ action: string; target: string; reason: string }>; summary: string | null } {
  const proposals = parseAuditReply(raw, VIGILANTE_ACTIONS);
  const summaryMatch = /^\s*RESUMEN\s*\|\s*(.+)$/im.exec(raw ?? '');
  const summary = summaryMatch ? summaryMatch[1].trim().slice(0, 400) : null;

  const byId = new Map(topics.map((topic) => [topic.id, topic] as const));
  const byTitle = new Map(topics.map((topic) => [normalizeTitle(topic.title), topic] as const));

  const operations: MaintenanceOperation[] = [];
  const touched = new Set<string>();

  for (const proposal of proposals) {
    if (proposal.action === 'dudar') continue;

    // El id manda; si la IA ha puesto el título, se acepta como cortesía.
    const topic = byId.get(proposal.target.trim()) ?? byTitle.get(normalizeTitle(proposal.target));
    if (!topic || touched.has(topic.id)) continue;
    if (operations.length >= MAX_AI_OPERATIONS) break;

    if (proposal.action === 'renombrar') {
      const match = proposal.reason.match(/poner\s*:\s*(.+)$/i);
      const newTitle = tidyTitle(match ? match[1].replace(/^[«"']|[»"']$/g, '') : '');
      if (newTitle.length > 0 && newTitle.length <= 180 && newTitle !== topic.title) {
        operations.push({ kind: 'rename_topic', topicId: topic.id, title: newTitle });
        touched.add(topic.id);
      }
      continue;
    }

    if (proposal.action === 'renumerar') {
      const match = proposal.reason.match(/(\d{1,3})/);
      const number = match ? Number(match[1]) : NaN;
      if (Number.isFinite(number) && number >= 1 && number <= 99 && number !== topic.unitNumber) {
        operations.push({ kind: 'renumber_topic', topicId: topic.id, unitNumber: number });
        touched.add(topic.id);
      }
      continue;
    }

    if (proposal.action === 'borrar') {
      // El vigilante no borra unidades: no hay forma de demostrar por texto libre
      // que una fila está vacía. Se queda como propuesta para el taller.
      continue;
    }

    if (proposal.action === 'limpiar') {
      const clean = tidyTitle(topic.title);
      if (clean.length > 0 && clean !== topic.title) {
        operations.push({ kind: 'rename_topic', topicId: topic.id, title: clean });
        touched.add(topic.id);
      }
      continue;
    }

    if (proposal.action === 'estado') {
      const status = proposal.reason.trim().replace(/^poner\s*:\s*/i, '').replace(/[^\wáéíóúñ]/g, '');
      if (['pendiente', 'en_curso', 'visto', 'repasado'].includes(status) && status !== topic.status) {
        operations.push({ kind: 'fix_topic_status', topicId: topic.id, status });
        touched.add(topic.id);
      }
      continue;
    }

    if (proposal.action === 'nivel') {
      // Solo se toca lo que aparenta una medición que no existe (ver el motor).
      if (claimsUnmeasuredReading(topic)) {
        operations.push({ kind: 'reset_mastery', topicId: topic.id });
        touched.add(topic.id);
      }
      continue;
    }

    if (proposal.action === 'srs') {
      const numbers = proposal.reason.match(/\d+(?:[.,]\d+)?/g) ?? [];
      const days = Number(numbers[0]?.replace(',', '.'));
      const ease = Number(numbers[1]?.replace(',', '.'));
      if (Number.isFinite(days) && days >= 1 && days <= SRS_MAX_INTERVAL_DAYS) {
        operations.push({
          kind: 'clamp_srs',
          topicId: topic.id,
          intervalDays: Math.round(days),
          easeFactor: Number.isFinite(ease) ? Math.min(SRS_MAX_EASE, Math.max(SRS_MIN_EASE, ease)) : topic.srsEaseFactor,
        });
        touched.add(topic.id);
      }
      continue;
    }
  }

  if (operations.length === 0) return { fix: null, proposals, summary };

  return {
    fix: {
      id: 'ia_vigilante',
      label: 'Ordenar el temario (IA de guardia)',
      description: `Cambia ${operations.length} unidad(es) siguiendo el plan de la IA. Todo lo aplicado es reversible y queda en el log.`,
      count: operations.length,
      // No es «seguro» por definición: son decisiones sobre contenido.
      safe: false,
      operations,
    },
    proposals,
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* Incidencias: abrir las que aparecen, cerrar las que ya no están     */
/* ------------------------------------------------------------------ */

interface IssueRow {
  id: string;
  title: string;
  contextJson: string | null;
}

function issueTitleFor(finding: MaintenanceFinding): string {
  return `[auto] ${finding.title}`;
}

/**
 * Una incidencia abierta por hallazgo crítico que no se ha podido arreglar.
 *
 * Se emparejan por el id de la comprobación (guardado en `contextJson`), no por
 * el título: así un cambio de redacción en el motor no abre diecisiete
 * incidencias nuevas.
 */
export async function syncIssues(
  userId: string,
  findings: MaintenanceFinding[],
  options: { aiSummary?: string | null; dry?: boolean; log?: (line: string) => void } = {}
): Promise<{ opened: string[]; resolved: string[] }> {
  const prisma = db(userId);
  const log = options.log ?? (() => {});
  const opened: string[] = [];
  const resolved: string[] = [];

  const relevant = findings.filter((finding) => finding.severity !== 'info');
  const relevantIds = new Set(relevant.map((finding) => finding.id));

  let existing: IssueRow[] = [];
  try {
    existing = await prisma.systemIssue.findMany({
      where: { source: 'vigilante', status: { not: 'resuelto' } },
      select: { id: true, title: true, contextJson: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  } catch (error) {
    log(`no se han podido leer las incidencias: ${error instanceof Error ? error.message : String(error)}`);
    return { opened, resolved };
  }

  const openByFindingId = new Map<string, IssueRow>();
  for (const issue of existing) {
    try {
      const context = JSON.parse(issue.contextJson ?? '{}') as { findingId?: string };
      if (context.findingId) openByFindingId.set(context.findingId, issue);
    } catch {
      // Una incidencia sin contexto legible no se toca: no sabemos de qué habla.
    }
  }

  for (const finding of relevant) {
    const already = openByFindingId.get(finding.id);
    if (already) continue;

    if (options.dry) {
      log(`(simulación) abriría la incidencia: ${issueTitleFor(finding)}`);
      opened.push(issueTitleFor(finding));
      continue;
    }

    try {
      const detail = [finding.detail, finding.samples.length > 0 ? `Ejemplos: ${finding.samples.join(' · ')}` : '']
        .filter(Boolean)
        .join('\n\n');

      await prisma.systemIssue.create({
        data: {
          title: issueTitleFor(finding),
          detail,
          contextJson: JSON.stringify({
            findingId: finding.id,
            severity: finding.severity,
            count: finding.count,
            detectedAt: new Date().toISOString(),
          }).slice(0, 4000),
          source: 'vigilante',
          status: 'abierto',
          resolution: options.aiSummary ? `Plan de la IA: ${options.aiSummary}`.slice(0, 1000) : null,
        },
      });
      opened.push(issueTitleFor(finding));
      log(`incidencia abierta: ${issueTitleFor(finding)}`);
    } catch (error) {
      log(`no se ha podido abrir la incidencia «${finding.title}»: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Las que ya no se detectan se cierran solas: es la otra mitad del trabajo.
  for (const [findingId, issue] of openByFindingId) {
    if (relevantIds.has(findingId)) continue;

    if (options.dry) {
      log(`(simulación) cerraría la incidencia: ${issue.title}`);
      resolved.push(issue.title);
      continue;
    }

    try {
      await prisma.systemIssue.update({
        where: { id: issue.id },
        data: {
          status: 'resuelto',
          resolution: 'Resuelto solo: la comprobación ya no detecta este problema.',
        },
      });
      resolved.push(issue.title);
      log(`incidencia cerrada: ${issue.title}`);
    } catch (error) {
      log(`no se ha podido cerrar «${issue.title}»: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { opened, resolved };
}

/* ------------------------------------------------------------------ */
/* La ronda                                                           */
/* ------------------------------------------------------------------ */

function headlineOf(report: Omit<VigilanteReport, 'headline'>): string {
  const parts: string[] = [];

  parts.push(
    report.health.ok
      ? `app OK (${report.health.responseMs} ms)`
      : report.health.reachable
        ? `app responde pero con problemas: ${report.health.detail}`
        : 'la app no responde'
  );

  if (report.applied.length > 0) {
    parts.push(`${report.applied.reduce((sum, item) => sum + item.count, 0)} arreglo(s) automático(s)`);
  }

  if (report.ai.asked) {
    parts.push(
      report.ai.error
        ? `IA sin respuesta (${report.ai.error.slice(0, 80)})`
        : `${report.ai.proposals.length} propuesta(s) de la IA, ${report.ai.applied} aplicada(s)`
    );
  }

  if (report.findingsAfter.length === 0) parts.push('sistema limpio');
  else parts.push(`${report.findingsAfter.length} hallazgo(s) pendiente(s)`);

  if (report.issues.opened.length > 0) parts.push(`${report.issues.opened.length} incidencia(s) nueva(s)`);
  if (report.issues.resolved.length > 0) parts.push(`${report.issues.resolved.length} cerrada(s)`);

  return parts.join(' · ');
}

/**
 * Una ronda completa: mirar, arreglar lo seguro, preguntar a la IA por lo demás
 * y dejar constancia de lo que queda.
 *
 * No lanza excepciones: lo que falle se cuenta en `problems` y en `notes`. Un
 * vigilante que se cae con un error se queda sin vigilar, que es justo el
 * problema que existe para resolver.
 */
export async function runVigilanteCycle(options: VigilanteOptions = {}): Promise<VigilanteReport> {
  const userId = options.userId ?? (await resolveBackgroundUserId());
  const log = options.log ?? (() => {});
  const startedAt = new Date();
  const dry = options.dry === true;
  const autoFix = options.autoFix !== false && !dry;
  const askAi = options.askAi !== false && !dry;

  const notes: string[] = [];
  const problems: string[] = [];
  let applied: Array<{ id: string; label: string; count: number }> = [];
  let findingsBefore: MaintenanceFinding[] = [];
  let findingsAfter: MaintenanceFinding[] = [];
  let input: MaintenanceInput | null = null;

  const health = await checkHealth(options.serverUrl);
  if (!health.reachable) {
    notes.push('La app no contesta al parte de salud: el script del vigilante es quien decide si hay que levantarla.');
  }

  /**
   * El rastro que trae el cargador no sabe si la app responde (eso se pregunta
   * desde fuera, que es justo lo que hace esta ronda). Se lo ponemos: así la
   * comprobación de «la app no responde» la ve el motor con el dato de verdad, y
   * el taller y el vigilante no pueden discrepar.
   */
  const loadInput = async (): Promise<MaintenanceInput> => {
    const loaded = await loadMaintenanceInput(userId, startedAt);
    if (loaded.trace) {
      loaded.trace.health = { reachable: health.reachable, ok: health.ok, detail: health.detail };
    }
    return loaded;
  };

  try {
    input = await loadInput();
    findingsBefore = scanAll(input);
    log(`revisión: ${findingsBefore.length} hallazgo(s)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push(`no se ha podido revisar la base: ${message}`);
    log(`ERROR al cargar los datos: ${message}`);

    const base = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      health,
      findingsBefore,
      findingsAfter,
      applied,
      problems,
      ai: {
        configured: hasAiProvider(),
        providers: getConfiguredProviders(),
        asked: false,
        model: null,
        proposals: [],
        applied: 0,
        summary: null,
        error: null,
      },
      issues: { opened: [], resolved: [] },
      notes,
    };

    return { ...base, headline: headlineOf(base) };
  }

  // 1. Lo que arreglan las reglas, sin preguntar a nadie.
  //
  // Se usa **el mismo camino que la página** (`applyMaintenanceFixes`), que
  // recalcula el plan entre arreglo y arreglo. Aplicándolos todos de golpe, el
  // plan que renumera el temario sigue hablando de la unidad repetida que otro
  // plan acaba de borrar, y el temario termina con un hueco (1, 2, 4).
  if (autoFix && input) {
    const safeFixes = allFixes(input).filter((fix) => fix.safe);
    if (safeFixes.length > 0) {
      const result = await applyMaintenanceFixes(userId);
      applied = result.applied;
      problems.push(...result.problems);
      if (result.applied.length > 0) {
        log(
          `arreglado solo: ${result.applied.map((item) => `${item.label} (${item.count})`).join(' | ')}`
        );
      }
    } else {
      log('nada que arreglar con las reglas');
    }
    input = await loadInput();
    findingsAfter = scanAll(input);
  } else {
    findingsAfter = findingsBefore;
  }

  // 2. Lo que no cubren las reglas: se le pide un plan a la IA.
  const ai: VigilanteReport['ai'] = {
    configured: hasAiProvider(),
    providers: getConfiguredProviders(),
    asked: false,
    model: null,
    proposals: [],
    applied: 0,
    summary: null,
    error: null,
  };

  // A la IA solo se le pregunta por lo que de verdad hay que decidir: hallazgos
  // con gravedad y que señalen unidades concretas. Los avisos informativos (por
  // ejemplo, «esta materia no tiene temario») no son un problema de la IA, y
  // preguntarle con el expediente entero delante solo invitaría a tocar unidades
  // que están bien.
  const relevantFindings = findingsAfter.filter((finding) => finding.severity !== 'info');
  const involvedResult = input ? collectInvolvedTopics(input.topics, relevantFindings) : null;

  if (!askAi) {
    // Nada que hacer: la ronda va solo con las reglas.
  } else if (findingsAfter.length === 0) {
    log('el sistema está limpio: no hay nada que preguntarle a la IA');
  } else if (!ai.configured) {
    ai.error = 'Sin claves de IA configuradas: el vigilante arregla lo que puede con las reglas.';
    log(ai.error);
  } else if (relevantFindings.length === 0) {
    log('solo hay avisos informativos: no hace falta la IA');
  } else if (!involvedResult || !involvedResult.recognized) {
    log('los hallazgos no señalan ninguna unidad concreta: la IA no tiene nada que decidir');
  } else if (isQuotaTight()) {
    // La ronda es mantenimiento: si el cupo gratuito está en las últimas, se
    // aparta para no quitarle la respuesta al alumno. No es un fallo y no se
    // apunta como incidencia: la ronda sigue con sus reglas y la IA volverá.
    log('cupo de IA justo: la ronda se aparta para no competir con el alumno (la IA vuelve en la próxima)');
  } else {
    const involved = involvedResult.topics;
    const findingsText = relevantFindings
      .map(
        (finding) =>
          `- [${finding.severity}] ${finding.id}: ${finding.title} (×${finding.count}). ${finding.detail}${
            finding.samples.length > 0 ? ` Ejemplos: ${finding.samples.join(' · ')}` : ''
          }`
      )
      .join('\n');

    const message = [
      'COMPROBACIONES QUE HAN SALTADO:',
      findingsText,
      '',
      'UNIDADES AFECTADAS (id | materia | nº | título | estado | nivel | srs | datos):',
      involved.map(formatTopicLine).join('\n'),
      '',
      '¿Qué unidades hay que tocar? Responde solo con las líneas ACCION | id | dato y la línea RESUMEN.',
    ].join('\n');

    try {
      ai.asked = true;
      // La memoria del mantenimiento: cómo quedó el sistema en la ronda anterior y
      // qué se decidió no tocar. Sin esto, cada vuelta vuelve a proponer lo mismo
      // sobre los mismos hallazgos y no se avanza.
      const memoryBlock = await loadMemoryBlock(userId, MEMORY_SCOPE_MAINTENANCE);
      const reply = await runAiText({
        systemInstruction: memoryBlock
          ? `${AI_SYSTEM_INSTRUCTION}\n\n${memoryBlock}`
          : AI_SYSTEM_INSTRUCTION,
        message,
        maxTokens: 1200,
        priority: 'fondo',
      });
      ai.model = `${reply.provider}/${reply.model}`;

      const plan = buildAiFix(reply.text, involved);
      ai.proposals = plan.proposals;
      ai.summary = plan.summary;

      if (plan.fix) {
        const result = await applyFixPlan(userId, [plan.fix]);
        ai.applied = result.applied.reduce((sum, item) => sum + item.count, 0);
        problems.push(...result.problems);
        log(`plan de la IA aplicado (${ai.model}): ${ai.applied} cambio(s)`);

        input = await loadMaintenanceInput(userId, startedAt);
        findingsAfter = scanAll(input);
      } else {
        log(`la IA no propone cambios (${ai.model})`);
      }
    } catch (error) {
      ai.error = error instanceof Error ? error.message : String(error);
      log(`la IA no ha podido ayudar: ${ai.error}`);
    }
  }

  // 3. Lo que has reportado tú, atendido: la IA empareja cada reporte con un
  // arreglo del taller y el arreglo se aplica si es de los seguros.
  //
  // Va **antes** de abrir incidencias a propósito: si el reporte se arregla aquí,
  // la comprobación correspondiente deja de saltar y no se abre una incidencia
  // nueva por algo que acaba de quedar resuelto.
  let triage: Awaited<ReturnType<typeof runIssueTriage>> | null = null;
  if (askAi && !dry) {
    try {
      triage = await runIssueTriage(userId, { log });
      if (triage.success && triage.reviewed > 0) {
        notes.push(`reportes del alumno atendidos: ${triage.reviewed}`);
        if (triage.applied > 0) {
          input = await loadInput();
          findingsAfter = scanAll(input);
        }
      } else if (!triage.success && triage.error) {
        notes.push(`no se han podido atender los reportes: ${triage.error.slice(0, 120)}`);
      }
    } catch (error) {
      problems.push(
        `no se han podido atender los reportes: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 4. La conexión de Moodle: se comprueba la clave y, si los datos se han
  // quedado viejos, se sincroniza sola. Los dos fallos son silenciosos (la clave
  // caduca y la sincronización se queda atrás), así que se cuidan aquí: la
  // comprobación lleva enfriamiento para no llamar a Moodle en cada ronda.
  if (!dry) {
    try {
      const moodle = await healMoodleConnection(userId, { log });
      if (moodle.synced || moodle.tokenState === 'caducado') notes.push(moodle.note);
    } catch (error) {
      notes.push(
        `no se ha podido cuidar la conexión de Moodle: ${
          error instanceof Error ? error.message.slice(0, 140) : String(error)
        }`
      );
    }
  }

  // 4b. La copia del temario del día.
  //
  // Es la red que permite que un temario perdido se pueda reponer: sin copia, el
  // taller solo puede decirte que no hay temario. Se guarda una vez al día (el
  // módulo mira cuándo fue la última) y **nunca** puede hacer fallar la ronda:
  // esto es una precaución de fondo, no una tarea de la que dependa nada.
  if (!dry) {
    try {
      const snapshot = await snapshotTemarioIfStale(userId);
      if (snapshot) notes.push(`copia del temario del día: ${snapshot}`);
    } catch (error) {
      notes.push(
        `no se ha podido guardar la copia del temario: ${
          error instanceof Error ? error.message.slice(0, 120) : String(error)
        }`
      );
    }
  }

  // 5. Lo que sigue mal, apuntado (y lo que ya no está, cerrado).
  const issues = await syncIssues(userId, findingsAfter, { aiSummary: ai.summary, dry, log });

  // 6. La ronda queda escrita para la próxima: es la memoria del mantenimiento.
  //
  // No es una conversación, así que su recuerdo no sale de mensajes: sale de cómo
  // ha quedado el sistema (qué se arregló, qué sigue abierto, qué decidió no
  // tocarse la IA). Se escribe por reglas y sin gastar cuota. Se queda la última
  // ronda del día: lo que mañana importa es cómo quedó todo, no la lista de vueltas.
  if (!dry) {
    try {
      const parts: string[] = [
        health.ok
          ? `La app quedó bien (${health.responseMs} ms).`
          : health.reachable
            ? `La app respondía con avisos: ${health.detail}.`
            : 'La app no respondía al parte de salud.',
      ];
      const fixed = applied.reduce((sum, item) => sum + item.count, 0);
      if (fixed > 0) {
        parts.push(`Se arregló solo: ${applied.map((item) => `${item.label} (${item.count})`).join(', ')}.`);
      }
      if (ai.applied > 0) parts.push(`La IA cambió ${ai.applied} cosa(s).`);
      if (triage && triage.reviewed > 0) {
        parts.push(
          `Se atendieron ${triage.reviewed} reporte(s) del alumno (${triage.applied} cambio(s)).`
        );
      }
      if (issues.opened.length > 0) parts.push(`Se abrieron incidencias: ${issues.opened.join(', ')}.`);
      if (issues.resolved.length > 0) parts.push(`Se cerraron: ${issues.resolved.join(', ')}.`);
      if (findingsAfter.length === 0) parts.push('El sistema quedó limpio.');
      else {
        parts.push(
          `Quedan ${findingsAfter.length} hallazgo(s): ${findingsAfter
            .slice(0, 4)
            .map((finding) => finding.title)
            .join(', ')}.`
        );
      }
      if (ai.error) parts.push(`La IA no pudo ayudar: ${ai.error.slice(0, 120)}.`);

      await saveDayMemory(userId, {
        scope: MEMORY_SCOPE_MAINTENANCE,
        summary: parts.join(' ').slice(0, 900),
        facts: [
          { label: 'hallazgos pendientes', value: String(findingsAfter.length) },
          { label: 'arreglos aplicados', value: String(fixed) },
          {
            label: 'incidencias abiertas',
            value: issues.opened.length > 0 ? issues.opened.slice(0, 2).join(' / ') : 'ninguna',
          },
        ],
      });
      notes.push('memoria del mantenimiento escrita');
    } catch (error) {
      problems.push(
        `no se ha podido escribir la memoria del mantenimiento: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    health,
    findingsBefore,
    findingsAfter,
    applied,
    problems,
    ai,
    issues,
    notes,
  };

  const headline = headlineOf(report);
  log(headline);

  return { ...report, headline };
}

/** ¿Merece la pena despertar a alguien por esta ronda? */
export function hasCritical(report: Pick<VigilanteReport, 'findingsAfter'>): boolean {
  return report.findingsAfter.some((finding) => finding.severity === 'critico');
}

/** Cuántos modelos de IA quedan libres (para no pedir ayuda a un proveedor en enfriamiento). */
export async function aiCapacity(): Promise<{ available: number; coolingDown: number }> {
  try {
    const chain = await getCandidateChain();
    let available = 0;
    let coolingDown = 0;
    for (const candidate of chain) {
      if (getCooldownSeconds(candidate.key) === 0) available += 1;
      else coolingDown += 1;
    }
    return { available, coolingDown };
  } catch {
    return { available: 0, coolingDown: 0 };
  }
}
