/**
 * Contrato puro del `DailyBrief`.
 *
 * Este módulo no importa Prisma, Next ni el motor del plan: recibe la foto que
 * ya calculó `ensureTodayPlan` y la convierte en lo que pinta el Cuartel. Esa
 * separación es la que permite probar el contrato con `verify:perf` sin base de
 * datos, sin red y sin IA.
 *
 * El brief **no decide** nada: headline, minutos y bloques vienen del plan. Solo
 * añade lo que la pantalla necesita para responder en una lectura: riesgos,
 * próximo examen y un resumen de una línea. `narrationStatus` queda en
 * `skipped` porque la apertura no llama a ningún modelo; si más adelante se
 * añade narración en `after()`, el contrato ya tiene su hueco.
 */

import type { StudentState } from './director/studentState';

export type DailyBriefSeverity = 'alta' | 'media' | 'baja';

/** Una foto por minuto: dos aperturas seguidas comparten el mismo brief. */
export const DAILY_BRIEF_BUCKET_MS = 60_000;

export function dailyBriefBucket(now: Date | number): number {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  return Math.floor(ms / DAILY_BRIEF_BUCKET_MS);
}

export interface DailyBriefBlock {
  id: string;
  subjectId: string;
  subjectName: string;
  subjectColor: string;
  topicTitle: string;
  minutes: number;
  objective: string;
  status: string;
  completed: boolean;
}

export interface DailyBriefRisk {
  code: 'exam' | 'reviews' | 'errors' | 'recovery' | 'empty';
  severity: DailyBriefSeverity;
  title: string;
  detail: string;
}

export interface DailyBriefNextExam {
  title: string;
  subjectName: string;
  /** Días naturales hasta el examen; 0 = hoy. */
  days: number;
}

/**
 * Campos del plan que el contrato necesita. Es estructural a propósito: el
 * `DayPlan` real encaja sin conversiones y el test puede construir una foto
 * mínima sin arrastrar el motor.
 */
export interface BriefPlanLike {
  dayKey: string;
  headline: string;
  availableMinutes: number;
  plannedMinutes: number;
  breakMinutes: number;
  completedMinutes: number;
  studiedMinutes: number;
  energy: 'alta' | 'media' | 'baja';
  sessions: Array<{
    id: string;
    subjectId: string;
    subjectName: string;
    subjectColor: string;
    topicTitle: string;
    durationMinutes: number;
    objective: string;
    status: string;
    isCompleted: boolean;
  }>;
  dueReviews: number;
  errorsOpen: number;
  recovery: { active: boolean; headline: string };
  emptyReason: string | null;
  /** Decisión determinista del director; opcional para no romper fixtures. */
  director?: StudentState | null;
}

export interface DailyBrief {
  contractVersion: 1;
  dayKey: string;
  generatedAtIso: string;
  headline: string;
  summary: string;
  availableMinutes: number;
  plannedMinutes: number;
  breakMinutes: number;
  completedMinutes: number;
  studiedMinutes: number;
  energy: 'alta' | 'media' | 'baja';
  blocks: DailyBriefBlock[];
  risks: DailyBriefRisk[];
  nextExam: DailyBriefNextExam | null;
  dueReviews: number;
  errorsOpen: number;
  emptyReason: string | null;
  narration: string | null;
  narrationStatus: 'pending' | 'ready' | 'skipped';
  generatedBy: 'rules';
  /** Estado compartido del alumno y decisión del director (sin IA). */
  director: StudentState | null;
}

export interface BuildDailyBriefExtras {
  generatedAtIso: string;
  nextExam?: DailyBriefNextExam | null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function summaryOf(brief: Pick<DailyBrief, 'blocks' | 'plannedMinutes' | 'availableMinutes' | 'emptyReason'>): string {
  if (brief.blocks.length === 0) {
    return brief.emptyReason ?? 'Sin sesiones pendientes: el plan está al día.';
  }
  const done = brief.blocks.filter((block) => block.completed).length;
  const pending = brief.blocks.length - done;
  return `${plural(pending, 'bloque pendiente', 'bloques pendientes')} · ${brief.plannedMinutes} min planificados · ${brief.availableMinutes} min disponibles`;
}

function risksOf(plan: BriefPlanLike, nextExam: DailyBriefNextExam | null): DailyBriefRisk[] {
  const risks: DailyBriefRisk[] = [];

  if (nextExam) {
    const when =
      nextExam.days <= 0
        ? 'hoy'
        : nextExam.days === 1
          ? 'mañana'
          : `en ${nextExam.days} días`;
    if (nextExam.days <= 7) {
      risks.push({
        code: 'exam',
        severity: nextExam.days <= 3 ? 'alta' : 'media',
        title: `Examen de ${nextExam.subjectName} ${when}`,
        detail: `«${nextExam.title}». El plan ya prioriza lo que más rinde antes de esa fecha.`,
      });
    }
  }

  if (plan.dueReviews > 0) {
    risks.push({
      code: 'reviews',
      severity: plan.dueReviews >= 10 ? 'alta' : 'media',
      title: `${plural(plan.dueReviews, 'repaso vencido', 'repasos vencidos')}`,
      detail: 'Recuperarlos hoy cuesta menos que volver a aprenderlo la semana que viene.',
    });
  }

  if (plan.errorsOpen > 0) {
    risks.push({
      code: 'errors',
      severity: plan.errorsOpen >= 5 ? 'media' : 'baja',
      title: `${plural(plan.errorsOpen, 'error sin corregir', 'errores sin corregir')}`,
      detail: 'El banco de errores alimenta las sesiones de corrección del plan.',
    });
  }

  if (plan.recovery.active) {
    risks.push({
      code: 'recovery',
      severity: 'media',
      title: plan.recovery.headline || 'Vuelta progresiva',
      detail: 'Se retoma con un objetivo pequeño: primero el hábito, después el volumen.',
    });
  }

  if (plan.sessions.length === 0 && plan.availableMinutes >= 10) {
    risks.push({
      code: 'empty',
      severity: 'media',
      title: 'Sin sesiones para hoy',
      detail: plan.emptyReason ?? 'Pulsa «Recalcular» para repartir el tiempo que queda.',
    });
  }

  return risks;
}

/** Construye la foto que se materializa. Determinista: mismas entradas, mismo brief. */
export function buildDailyBrief(plan: BriefPlanLike, extras: BuildDailyBriefExtras): DailyBrief {
  const blocks: DailyBriefBlock[] = plan.sessions.map((session) => ({
    id: session.id,
    subjectId: session.subjectId,
    subjectName: session.subjectName,
    subjectColor: session.subjectColor,
    topicTitle: session.topicTitle,
    minutes: session.durationMinutes,
    objective: session.objective,
    status: session.status,
    completed: session.isCompleted,
  }));

  const nextExam = extras.nextExam ?? null;
  const base = {
    contractVersion: 1 as const,
    dayKey: plan.dayKey,
    generatedAtIso: extras.generatedAtIso,
    headline: plan.headline,
    availableMinutes: plan.availableMinutes,
    plannedMinutes: plan.plannedMinutes,
    breakMinutes: plan.breakMinutes,
    completedMinutes: plan.completedMinutes,
    studiedMinutes: plan.studiedMinutes,
    energy: plan.energy,
    blocks,
    risks: risksOf(plan, nextExam),
    nextExam,
    dueReviews: plan.dueReviews,
    errorsOpen: plan.errorsOpen,
    emptyReason: plan.emptyReason,
    narration: null,
    narrationStatus: 'skipped' as const,
    generatedBy: 'rules' as const,
    director: plan.director ?? null,
  };

  return { ...base, summary: summaryOf(base) };
}
