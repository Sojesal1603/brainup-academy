import { prisma } from './prisma';
import { runAiText, hasAiProvider, TutorError } from './aiEngine';
import { loadMaintenanceInput } from './maintenanceData';
import { applyFixPlan } from './maintenanceApply';
import { allFixes, scanAll } from './maintenanceScan';
import { MEMORY_SCOPE_MAINTENANCE, loadMemoryBlock } from './agentMemory';
import type { MaintenanceFix, MaintenanceFinding } from './maintenance';

/**
 * Que la IA atienda lo que le cuentas tú.
 *
 * Hasta ahora había dos caminos que no se hablaban:
 *
 *   - **Tú reportas** un fallo («no me salen retos», «el temario está desordenado»)
 *     y eso quedaba apuntado como incidencia, esperando a que alguien lo mirara.
 *   - **El sistema detecta** lo que no cuadra y sabe arreglarlo, pero solo lo hacía
 *     con lo que él mismo encontraba.
 *
 * Este módulo une los dos: coge los reportes tuyos, le pone delante las
 * comprobaciones que han saltado y los arreglos que existen, y le pide a la IA que
 * diga **qué arreglo corresponde a tu queja**. Con esa decisión:
 *
 *   1. **Se arregla**, si el taller ya considera ese arreglo seguro (renombrar,
 *      renumerar, acotar rangos, quitar una unidad repetida que está vacía). Todo
 *      lo que se aplica es reversible o está demostrablemente vacío.
 *   2. **Se te explica**, siempre: el reporte deja de estar «abierto sin revisar»
 *      y pasa a «revisado» con el diagnóstico de la IA escrito dentro.
 *
 * Dos decisiones que importan:
 *
 *   - **La IA no escribe en la base.** Elige entre los arreglos que ya existen, en
 *     un vocabulario cerrado (`arreglo | reporte | arreglo | motivo` o
 *     `no | reporte | motivo`), y cada id se valida contra la lista real. Un id
 *     inventado no hace nada.
 *   - **Lo que borraría datos con valor no se hace solo.** Si el único arreglo que
 *     encaja no es seguro, se queda diagnosticado y se te dice en el propio
 *     reporte: lo aplicas tú en el taller, con la lista de cambios delante.
 *
 * Vive fuera de `maintenanceActions.ts` (que es donde están las acciones de Next)
 * por la misma razón que `maintenanceApply.ts`: el vigilante también revisa lo
 * reportado, y el vigilante corre fuera de una petición de Next.
 */

/** Cuántos reportes se atienden por pasada: la IA no se atasca con veinte. */
export const TRIAGE_BATCH = 5;
const TRIAGE_MAX_TOKENS = 700;

export interface TriageDecision {
  issueId: string;
  action: 'arreglar' | 'no';
  fixId: string | null;
  reason: string;
}

export interface IssueTriageOutcome {
  id: string;
  title: string;
  /** «resuelto» si se ha arreglado, «revisado» si solo hay diagnóstico. */
  status: 'resuelto' | 'revisado';
  fixId: string | null;
  fixLabel: string | null;
  reason: string;
  applied: number;
}

export interface IssueTriageResult {
  success: boolean;
  error?: string;
  model: string;
  reviewed: number;
  applied: number;
  outcomes: IssueTriageOutcome[];
  problems: string[];
}

interface IssueRow {
  id: string;
  title: string;
  detail: string | null;
  contextJson: string | null;
}

function clean(text: string, max: number): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function withoutAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

interface TriageIssueRef {
  id: string;
  title: string;
}

/**
 * A qué reporte se refiere una línea.
 *
 * El modelo copia ids largos y a veces los corta, así que se acepta el id exacto
 * o **un principio inequívoco** del id (mínimo 8 caracteres y un solo candidato):
 * adivinar entre dos reportes sería peor que no hacer nada.
 */
function resolveIssueRef(raw: string, issues: TriageIssueRef[]): TriageIssueRef | null {
  const value = clean(raw, 60).toLowerCase().replace(/[«»"'`]/g, '');
  if (value.length === 0) return null;

  const exact = issues.find((issue) => issue.id.toLowerCase() === value);
  if (exact) return exact;

  if (value.length < 8) return null;
  const matches = issues.filter((issue) => issue.id.toLowerCase().startsWith(value));
  return matches.length === 1 ? matches[0] : null;
}

function resolveFix(raw: string, fixes: MaintenanceFix[], known?: Map<string, MaintenanceFix>): MaintenanceFix | null {
  const value = clean(raw, 80).replace(/[«»"'`]/g, '');
  if (value.length === 0) return null;

  const exact = known?.get(value.toLowerCase());
  if (exact) return exact;

  const byId = fixes.find((fix) => fix.id.toLowerCase() === value.toLowerCase());
  if (byId) return byId;

  if (value.length < 6) return null;
  const matches = fixes.filter((fix) => fix.id.toLowerCase().startsWith(value.toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Elige la lista de la respuesta de la IA.
 *
 * Es una función pura a propósito: se puede probar con textos reales sin base de
 * datos ni claves (es lo que hace la verificación del taller).
 */
export function parseTriageReply(
  text: string,
  issues: TriageIssueRef[],
  fixes: MaintenanceFix[]
): TriageDecision[] {
  const known = new Map(fixes.map((fix) => [fix.id.toLowerCase(), fix] as const));
  const decisions: TriageDecision[] = [];
  const seen = new Set<string>();

  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim().replace(/^[-*·]\s*/, '');
    if (line.length === 0 || !line.includes('|')) continue;

    const fields = line.split('|').map((field) => field.trim());
    if (fields.length < 3) continue;

    const action = withoutAccents(fields[0]).replace(/[^a-z]/g, '');
    const issue = resolveIssueRef(fields[1], issues);
    if (!issue || seen.has(issue.id)) continue;

    if (action === 'arreglo' || action === 'arreglar' || action === 'fix') {
      if (fields.length < 4) continue;
      const fix = resolveFix(fields[2], fixes, known);
      // Un arreglo que no está en la lista no es un arreglo: es un id inventado.
      if (!fix) continue;
      decisions.push({ issueId: issue.id, action: 'arreglar', fixId: fix.id, reason: clean(fields[3], 400) });
      seen.add(issue.id);
      continue;
    }

    if (action === 'no' || action === 'nada' || action === 'ninguno' || action === 'sinarreglo') {
      decisions.push({
        issueId: issue.id,
        action: 'no',
        fixId: null,
        reason: clean(fields.slice(2).join(' '), 400),
      });
      seen.add(issue.id);
    }
  }

  return decisions;
}

function buildTriageSystemInstruction(): string {
  return [
    'Eres el tallerista de mantenimiento de BrainUp Academy (una app de estudio que corre en el ordenador del alumno).',
    'Recibes dos listas: cosas que el ALUMNO ha reportado como fallos, y las comprobaciones que el sistema ha detectado con los arreglos que existen.',
    '',
    'Tu trabajo es decir, para cada reporte, si hay un arreglo que le corresponda.',
    '',
    'CÓMO DECIDIR:',
    '- Un reporte solo se arregla si encaja con un arreglo de la lista y el arreglo toca de verdad lo que cuenta (la misma materia, la misma unidad, el mismo síntoma).',
    '- Decir «no» NO es no atenderle: es decirle que eso no lo arregla el taller. El motivo tiene que servirle de algo: dos frases, qué crees que le está pasando y qué puede hacer él (o qué se ha revisado y está bien).',
    '- Si el reporte no encaja con nada, si es una pregunta, o si habla de algo que el sistema no controla (su centro, su Moodle, su profe), contesta «no» con esa explicación útil.',
    '- Si la memoria de abajo dice que eso ya se miró ayer, dilo: «esto ya lo revisamos y estaba bien por nuestra parte».',
    '- Si dudas entre dos arreglos, contesta «no»: es mejor explicarle que equivocarse tocando su temario.',
    '',
    'FORMATO DE SALIDA: solo estas líneas, una por reporte, sin texto adicional:',
    'arreglo | id del reporte | id del arreglo | motivo (máximo 140 caracteres)',
    'no | id del reporte | motivo (máximo 200 caracteres)',
    '',
    'NUNCA inventes ids: los dos tienen que estar copiados de las listas tal cual. Si un reporte no aparece en tu respuesta, se queda sin revisar.',
  ].join('\n');
}

function buildTriageMessage(input: {
  issues: IssueRow[];
  findings: MaintenanceFinding[];
  fixes: MaintenanceFix[];
  memory: string;
}): string {
  const lines: string[] = [];

  lines.push('REPORTES DEL ALUMNO (id | título | detalle):');
  for (const issue of input.issues) {
    lines.push(
      `- ${issue.id} | ${clean(issue.title, 140)} | ${clean(issue.detail ?? 'sin detalle', 300)}`
    );
  }

  lines.push('');
  lines.push('COMPROBACIONES QUE HAN SALTADO (id | gravedad | título | detalle):');
  if (input.findings.length === 0) lines.push('- (ninguna: el sistema no ve nada raro por dentro)');
  else {
    for (const finding of input.findings.slice(0, 25)) {
      lines.push(
        `- ${finding.id} | ${finding.severity} | ${clean(finding.title, 140)} (×${finding.count}) | ${clean(
          finding.detail,
          260
        )}`
      );
    }
  }

  lines.push('');
  lines.push('ARRECLOS DISPONIBLES (id | qué hace | cambios | ¿seguro para aplicarlo solo?):');
  if (input.fixes.length === 0) lines.push('- (ninguno: no hay nada que el taller pueda cambiar ahora mismo)');
  else {
    for (const fix of input.fixes) {
      lines.push(`- ${fix.id} | ${clean(fix.label, 140)} | ${fix.count} | ${fix.safe ? 'sí' : 'no'}`);
    }
  }

  if (input.memory.trim().length > 0) {
    lines.push('');
    lines.push(input.memory.trim());
  }

  lines.push('');
  lines.push('Responde solo con las líneas arreglo | ... o no | ...');
  return lines.join('\n');
}

/**
 * Revisa los reportes del alumno que están sin atender.
 *
 * Se llama desde dos sitios: el botón del taller («que la IA revise lo
 * reportado») y la ronda del vigilante, para que un reporte tuyo no dependa de
 * que alguien esté delante.
 */
export async function triageReportedIssues(
  options: { limit?: number; log?: (line: string) => void } = {}
): Promise<IssueTriageResult> {
  const log = options.log ?? (() => {});
  const limit = Math.max(1, Math.min(options.limit ?? TRIAGE_BATCH, 20));

  const empty: IssueTriageResult = {
    success: true,
    model: '',
    reviewed: 0,
    applied: 0,
    outcomes: [],
    problems: [],
  };

  let issues: IssueRow[] = [];
  try {
    issues = await prisma.systemIssue.findMany({
      where: { source: 'alumno', status: 'abierto' },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, title: true, detail: true, contextJson: true },
    });
  } catch (error) {
    return {
      ...empty,
      success: false,
      error: `No se han podido leer los reportes: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (issues.length === 0) return empty;

  const input = await loadMaintenanceInput();
  const findings = scanAll(input);
  const fixes = allFixes(input);

  const problems: string[] = [];

  // Sin nada que arreglar y sin nada raro por dentro, la respuesta honesta se
  // sabe sin preguntarle a nadie: no se gasta cuota del alumno en un «no».
  if (fixes.length === 0 && findings.length === 0) {
    const outcomes: IssueTriageOutcome[] = [];
    for (const issue of issues) {
      const reason =
        'El sistema se ha mirado por dentro y no ve ningún error que le corresponda, así que no hay nada que arreglar por su parte. Si te vuelve a pasar, cuenta qué estabas haciendo justo antes.';
      await prisma.systemIssue.update({
        where: { id: issue.id },
        data: { status: 'revisado', resolution: reason.slice(0, 1000) },
      });
      outcomes.push({
        id: issue.id,
        title: issue.title,
        status: 'revisado',
        fixId: null,
        fixLabel: null,
        reason,
        applied: 0,
      });
    }
    log(`reportes revisados sin IA (no hay nada que arreglar): ${issues.length}`);
    return { ...empty, model: 'sin IA (nada que arreglar)', reviewed: issues.length, outcomes, problems };
  }

  if (!hasAiProvider()) {
    return {
      ...empty,
      success: false,
      error: 'Para diagnosticar tus reportes hace falta una clave de IA (GEMINI_API_KEY o GROQ_API_KEY).',
    };
  }

  let model = '';
  let decisions: TriageDecision[] = [];

  try {
    const memory = await loadMemoryBlock(MEMORY_SCOPE_MAINTENANCE);
    const reply = await runAiText({
      systemInstruction: buildTriageSystemInstruction(),
      message: buildTriageMessage({
        issues,
        findings,
        fixes,
        memory,
      }),
      maxTokens: TRIAGE_MAX_TOKENS,
      // Atender los reportes puede esperar a la próxima ronda: si el cupo está
      // justo, no se le quita el turno al alumno que está escribiendo.
      priority: 'fondo',
    });

    model = `${reply.provider}/${reply.model}`;
    decisions = parseTriageReply(reply.text, issues, fixes);
  } catch (error) {
    const message =
      error instanceof TutorError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error('[mantenimiento] el diagnóstico de los reportes no ha podido hacerse:', message);
    return { ...empty, success: false, error: message };
  }

  if (decisions.length === 0) {
    log('la IA no ha sabido emparejar ningún reporte con un arreglo: se dejan como están');
    return { ...empty, model, reviewed: 0, problems };
  }

  const byId = new Map(issues.map((issue) => [issue.id, issue] as const));
  const outcomes: IssueTriageOutcome[] = [];
  let appliedTotal = 0;

  for (const decision of decisions) {
    const issue = byId.get(decision.issueId);
    if (!issue) continue;

    if (decision.action === 'no' || !decision.fixId) {
      const reason = decision.reason.length > 0 ? decision.reason : 'No hay nada que arreglar por su parte.';
      await prisma.systemIssue.update({
        where: { id: issue.id },
        data: { status: 'revisado', resolution: reason.slice(0, 1000) },
      });
      outcomes.push({
        id: issue.id,
        title: issue.title,
        status: 'revisado',
        fixId: null,
        fixLabel: null,
        reason,
        applied: 0,
      });
      log(`reporte revisado sin arreglo: ${issue.title} → ${reason.slice(0, 90)}`);
      continue;
    }

    const fix = fixes.find((candidate) => candidate.id === decision.fixId) ?? null;
    if (!fix) continue;

    // Solo se aplica solo lo que el taller ya considera seguro. Lo demás se queda
    // diagnosticado con el arreglo a mano: lo aplica el alumno desde el taller.
    if (!fix.safe) {
      const reason = [
        decision.reason.length > 0 ? decision.reason : 'Encaja con un arreglo del taller.',
        `Lo he localizado, pero cambia ${fix.count} cosa(s) que prefiero que veas antes: «${fix.label}» (arreglo «${fix.id}»). Aplícalo desde el taller cuando quieras.`,
      ].join(' ');
      await prisma.systemIssue.update({
        where: { id: issue.id },
        data: { status: 'revisado', resolution: reason.slice(0, 1000) },
      });
      outcomes.push({
        id: issue.id,
        title: issue.title,
        status: 'revisado',
        fixId: fix.id,
        fixLabel: fix.label,
        reason,
        applied: 0,
      });
      log(`reporte diagnosticado (arreglo no automático): ${issue.title} → ${fix.label}`);
      continue;
    }

    const result = await applyFixPlan([fix]);
    problems.push(...result.problems);
    const applied = result.applied.reduce((sum, item) => sum + item.count, 0);
    appliedTotal += applied;

    const reason = [
      decision.reason.length > 0 ? decision.reason : 'Encaja con un arreglo del taller.',
      applied > 0 ? `Arreglado: ${fix.label} (${applied} cambio(s)).` : 'El arreglo ya no hacía falta.',
    ].join(' ');

    await prisma.systemIssue.update({
      where: { id: issue.id },
      data: { status: applied > 0 ? 'resuelto' : 'revisado', resolution: reason.slice(0, 1000) },
    });

    outcomes.push({
      id: issue.id,
      title: issue.title,
      status: applied > 0 ? 'resuelto' : 'revisado',
      fixId: fix.id,
      fixLabel: fix.label,
      reason,
      applied,
    });

    log(`reporte arreglado (${model}): ${issue.title} → ${fix.label} (${applied})`);
  }

  console.log(
    `[mantenimiento] reportes revisados: ${outcomes.length} de ${issues.length} · ${appliedTotal} cambio(s) · ${model}`
  );

  return {
    success: true,
    model,
    reviewed: outcomes.length,
    applied: appliedTotal,
    outcomes,
    problems,
  };
}

/** Cuántos reportes tuyos están esperando a que alguien los mire. */
export async function countPendingReports(): Promise<number> {
  try {
    return await prisma.systemIssue.count({ where: { source: 'alumno', status: 'abierto' } });
  } catch {
    return 0;
  }
}
