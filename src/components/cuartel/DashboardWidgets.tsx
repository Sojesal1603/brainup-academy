import { Suspense, cache } from 'react';
import { unstable_cache } from 'next/cache';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock,
  GraduationCap,
  Repeat,
  Sparkles,
  Target,
} from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { ensureUserProfile, getCachedProfileSummary, type ProfileSummary } from '@/lib/userProfile';
import { safeDb } from '@/lib/dbTimeout';
import { buildReviewQueue } from '@/lib/srs';
import { levelFromXp, weekKeyOf } from '@/lib/challenges';
import { ensureTodayPlan } from '@/lib/dayPlan';
import { getTodayClassCheckIn } from '@/lib/temario';
import { StudyMode } from '@/lib/types';
import HoyTocaEsto from './HoyTocaEsto';
import ClassCheckIn from './ClassCheckIn';
import FocusLock from '@/components/enfoque/FocusLock';
import HabitItem from '@/components/dashboard/HabitItem';
import ModeSwitcher from '@/components/dashboard/ModeSwitcher';
import { PanelSkeleton } from '@/components/ui/Skeletons';

/**
 * Secciones del Cuartel.
 *
 * Cada una es un Server Component independiente y se renderiza dentro de su
 * propio `<Suspense>` en `page.tsx`. Así el encabezado, la Sidebar y el grid se
 * pintan al instante y cada bloque llega cuando su consulta termina. Si una
 * consulta falla o tarda más de 4 s, su sección usa datos mínimos y las demás
 * siguen funcionando: una base lenta no vuelve a congelar toda la vista.
 */

const getDashboardUser = cache(() =>
  safeDb<ProfileSummary | null>(
    'cuartel.perfil',
    async () => (await getCachedProfileSummary()) ?? (await ensureUserProfile()),
    null,
    2_500
  )
);

/* ------------------------------------------------------------------ */
/* Consultas compartidas por varios widgets                            */
/* ------------------------------------------------------------------ */

interface TodayBlockPreview {
  isCompleted: boolean;
  durationMinutes: number;
}

const readTodayBlocks = unstable_cache(
  () =>
    prisma.studyBlock.findMany({
      where: {
        date: {
          gte: startOfDay(new Date()),
          lte: endOfDay(new Date()),
        },
      },
      select: { isCompleted: true, durationMinutes: true },
      orderBy: { orderIndex: 'asc' },
    }),
  ['cuartel-bloques-v1'],
  { revalidate: 10, tags: ['cuartel', 'plan'] }
);

const loadTodayBlocks = cache(() =>
  safeDb<TodayBlockPreview[]>('cuartel.bloques', readTodayBlocks, [], 4_000)
);

interface ExamPreview {
  id: string;
  title: string;
  examDate: Date;
  subject: { name: string; color: string; pauWeight: number };
}

const readUpcomingExams = unstable_cache(
  () =>
    prisma.exam.findMany({
      where: { isCompleted: false, examDate: { gte: startOfDay(new Date()) } },
      select: {
        id: true,
        title: true,
        examDate: true,
        subject: { select: { name: true, color: true, pauWeight: true } },
      },
      orderBy: { examDate: 'asc' },
      take: 3,
    }),
  ['cuartel-examenes-v1'],
  { revalidate: 30, tags: ['cuartel', 'examenes'] }
);

const loadUpcomingExams = cache(() =>
  safeDb<ExamPreview[]>('cuartel.examenes', readUpcomingExams, [], 4_000)
);

interface RiskTopicPreview {
  id: string;
  title: string;
  masteryLevel: number;
  subject: { name: string };
  errors: Array<{ id: string }>;
}

interface RiskData {
  measuredUnitsCount: number;
  riskTopics: RiskTopicPreview[];
}

const readRiskData = unstable_cache(
  async (): Promise<RiskData> => {
    const [measuredUnitsCount, riskTopics] = await Promise.all([
      prisma.topic.count({ where: { masterySource: { not: 'sin_medir' } } }),
      prisma.topic.findMany({
        where: {
          masterySource: { not: 'sin_medir' },
          OR: [
            { masteryLevel: { lt: 50 } },
            { errors: { some: { isMastered: false } } },
          ],
        },
        select: {
          id: true,
          title: true,
          masteryLevel: true,
          subject: { select: { name: true } },
          errors: { where: { isMastered: false }, select: { id: true } },
        },
        orderBy: [{ masteryLevel: 'asc' }, { difficulty: 'desc' }],
        take: 4,
      }),
    ]);
    return { measuredUnitsCount, riskTopics };
  },
  ['cuartel-riesgo-v1'],
  { revalidate: 20, tags: ['cuartel', 'temario', 'errores'] }
);

const loadRiskData = cache(() =>
  safeDb<RiskData>(
    'cuartel.riesgo',
    readRiskData,
    { measuredUnitsCount: 0, riskTopics: [] },
    4_000
  )
);

interface FocusTopicPreview {
  id: string;
  title: string;
  subjectName: string;
  color: string;
}

interface FocusData {
  topics: FocusTopicPreview[];
  today: { focusedMinutes: number; tutorMinutes: number; abandoned: number };
}

const readFocusData = unstable_cache(
  async (): Promise<FocusData> => {
    const [rawTopics, aggregate, abandoned] = await Promise.all([
        prisma.topic.findMany({
          where: { subject: { isTracked: true } },
          select: {
            id: true,
            title: true,
            subject: { select: { name: true, color: true } },
          },
          orderBy: [{ subject: { order: 'asc' } }, { unitNumber: 'asc' }],
          take: 60,
        }),
        prisma.focusSession.aggregate({
          where: { startedAt: { gte: startOfDay(new Date()) } },
          _sum: { focusedSeconds: true, tutorSeconds: true },
        }),
        prisma.focusSession.count({
          where: { startedAt: { gte: startOfDay(new Date()) }, status: 'abandoned' },
        }),
      ]);

    return {
      topics: rawTopics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        subjectName: topic.subject.name,
        color: topic.subject.color,
      })),
      today: {
        focusedMinutes: Math.round((aggregate._sum.focusedSeconds ?? 0) / 60),
        tutorMinutes: Math.round((aggregate._sum.tutorSeconds ?? 0) / 60),
        abandoned,
      },
    };
  },
  ['cuartel-enfoque-v1'],
  { revalidate: 15, tags: ['cuartel', 'enfoque'] }
);

const loadFocusData = cache(() =>
  safeDb<FocusData>(
    'cuartel.enfoque',
    readFocusData,
    { topics: [], today: { focusedMinutes: 0, tutorMinutes: 0, abandoned: 0 } },
    4_000
  )
);

interface HabitPreview {
  id: string;
  title: string;
  description: string | null;
  streak: number;
  logs: Array<{ id: string }>;
}

const readHabits = unstable_cache(
  () =>
    prisma.habit.findMany({
      select: {
        id: true,
        title: true,
        description: true,
        streak: true,
        logs: {
          where: { date: { gte: startOfDay(new Date()), lte: endOfDay(new Date()) } },
          select: { id: true },
        },
      },
    }),
  ['cuartel-habitos-v1'],
  { revalidate: 10, tags: ['cuartel', 'habitos'] }
);

const loadHabits = cache(() =>
  safeDb<HabitPreview[]>('cuartel.habitos', readHabits, [], 4_000)
);

interface ReviewData {
  dueReviewsCount: number;
  scheduledCount: number;
  challengesCompleted: number;
  challengesTotal: number;
  level: { level: number; title: string };
}

const readReviewData = unstable_cache(
  async (): Promise<ReviewData> => {
    const user = await getDashboardUser();
      const now = new Date();
      const [srsScheduledTopics, weekChallengeRows] = await Promise.all([
        prisma.topic.findMany({
          where: { lastReviewedAt: { not: null } },
          select: {
            id: true,
            lastReviewedAt: true,
            srsIntervalDays: true,
            srsEaseFactor: true,
          },
        }),
        prisma.weeklyChallenge.findMany({
          where: { weekKey: weekKeyOf(now) },
          select: { status: true },
        }),
      ]);

    return {
      dueReviewsCount: buildReviewQueue(srsScheduledTopics, now, { onlyDue: true }).length,
      scheduledCount: srsScheduledTopics.length,
      challengesCompleted: weekChallengeRows.filter((row) => row.status === 'completed').length,
      challengesTotal: weekChallengeRows.length,
      level: levelFromXp(user?.challengeXp ?? 0),
    };
  },
  ['cuartel-repaso-v1'],
  { revalidate: 15, tags: ['cuartel', 'repaso'] }
);

const loadReviewData = cache(() =>
  safeDb<ReviewData>(
    'cuartel.repaso',
    readReviewData,
    {
      dueReviewsCount: 0,
      scheduledCount: 0,
      challengesCompleted: 0,
      challengesTotal: 0,
      level: { level: 1, title: 'Aprendiz' },
    },
    4_000
  )
);

interface MoodleTaskPreview {
  id: string;
  title: string;
  courseName: string;
  dueDate: Date;
  moodleUrl: string | null;
  submitted: boolean | null;
  subject: { name: string } | null;
}

const readMoodleTasks = unstable_cache(
  () =>
    prisma.moodleTask.findMany({
      where: { isCompleted: false, dueDate: { gte: startOfDay(new Date()) } },
      select: {
        id: true,
        title: true,
        courseName: true,
        dueDate: true,
        moodleUrl: true,
        submitted: true,
        subject: { select: { name: true } },
      },
      orderBy: { dueDate: 'asc' },
      take: 4,
    }),
  ['cuartel-moodle-v1'],
  { revalidate: 30, tags: ['cuartel', 'moodle'] }
);

const loadMoodleTasks = cache(() =>
  safeDb<MoodleTaskPreview[]>('cuartel.moodle', readMoodleTasks, [], 4_000)
);

/**
 * El plan de hoy y el chequeo de clase también se cachean unos segundos.
 * `ensureTodayPlan` lee siete consultas de contexto cada vez que se llama;
 * sin esta foto, el widget seguiría tardando segundos aunque el resto del
 * Cuartel ya estuviera cacheado.
 */
const readDayPlan = unstable_cache(
  async (dayKey: string) => {
    const [year, month, day] = dayKey.split('-').map(Number);
    const now = new Date();
    now.setFullYear(year, month - 1, day);
    return ensureTodayPlan(now);
  },
  ['cuartel-plan-v1'],
  { revalidate: 15, tags: ['cuartel', 'plan'] }
);

const readTodayCheckIn = unstable_cache(
  async (dayKey: string) => {
    const [year, month, day] = dayKey.split('-').map(Number);
    const now = new Date();
    now.setFullYear(year, month - 1, day);
    return getTodayClassCheckIn(now);
  },
  ['cuartel-clase-v1'],
  { revalidate: 15, tags: ['cuartel', 'clase', 'temario'] }
);

/* ------------------------------------------------------------------ */
/* Cabecera del Cuartel                                                */
/* ------------------------------------------------------------------ */

export async function DashboardIntro() {
  const user = await getDashboardUser();
  return (
    <p className="mt-1 text-xs text-slate-400">
      Centro de mando diario. Enfoque absoluto en tu nota de corte PAU (
      {user?.targetGradePau ?? 13.5}/14).
    </p>
  );
}

export async function DashboardMode() {
  const user = await getDashboardUser();
  return <ModeSwitcher currentMode={(user?.studyMode as StudyMode) || 'athlete'} />;
}

/* ------------------------------------------------------------------ */
/* Métricas                                                            */
/* ------------------------------------------------------------------ */

export async function DashboardMetrics() {
  const [todayBlocks, upcomingExams, risk] = await Promise.all([
    loadTodayBlocks(),
    loadUpcomingExams(),
    loadRiskData(),
  ]);

  const completedBlocksCount = todayBlocks.filter((block) => block.isCompleted).length;
  const totalBlocksCount = todayBlocks.length;
  const totalMinutesToday = todayBlocks.reduce(
    (acc, block) => acc + (block.isCompleted ? block.durationMinutes : 0),
    0
  );

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* Progreso de Hoy */}
      <div className="glass-card p-4 rounded-2xl">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">Bloques de Hoy</span>
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="metric-glow text-2xl font-black text-slate-100 font-mono">
            {completedBlocksCount}/{totalBlocksCount}
          </span>
          <span className="text-xs text-slate-400">completados</span>
        </div>
        <div className="w-full h-1.5 rounded-full bg-slate-800 mt-3 overflow-hidden">
          <div
            className="h-full bg-emerald-400 rounded-full transition-all duration-500"
            style={{
              width: `${totalBlocksCount ? (completedBlocksCount / totalBlocksCount) * 100 : 0}%`,
            }}
          />
        </div>
      </div>

      {/* Tiempo Dedicado Hoy */}
      <div className="glass-card p-4 rounded-2xl">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">Tiempo Enfocado</span>
          <Clock className="w-4 h-4 text-blue-400" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="metric-glow text-2xl font-black text-slate-100 font-mono">
            {totalMinutesToday}
          </span>
          <span className="text-xs text-slate-400">minutos hoy</span>
        </div>
        <p className="text-[11px] text-slate-500 mt-3">
          {(totalMinutesToday / 60).toFixed(1)} h de trabajo activo registrado
        </p>
      </div>

      {/* Próximo Examen Crítico */}
      <div className="glass-card p-4 rounded-2xl">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">Próximo Hito</span>
          <GraduationCap className="w-4 h-4 text-amber-400" />
        </div>
        {upcomingExams[0] ? (
          <div>
            <div className="flex items-baseline gap-2">
              <span className="metric-glow text-2xl font-black text-amber-400 font-mono">
                {Math.max(
                  0,
                  Math.ceil(
                    (new Date(upcomingExams[0].examDate).getTime() - Date.now()) /
                      (1000 * 60 * 60 * 24)
                  )
                )}
              </span>
              <span className="text-xs text-slate-400">días restantes</span>
            </div>
            <p className="text-[11px] text-slate-300 truncate mt-3 font-medium">
              {upcomingExams[0].subject.name}: {upcomingExams[0].title}
            </p>
          </div>
        ) : (
          <p className="text-xs text-slate-500 mt-2">Sin exámenes agendados</p>
        )}
      </div>

      {/* Temas en Riesgo */}
      <div className="glass-card p-4 rounded-2xl">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">Temas Críticos</span>
          <AlertTriangle className="w-4 h-4 text-rose-400" />
        </div>
        {risk.measuredUnitsCount === 0 ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-slate-400 font-mono">—</span>
              <span className="text-xs text-slate-400">sin mediciones</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-3">
              Ninguna unidad tiene el nivel medido todavía: no hay temas críticos que inventar.
              Declara tus notas en Ajustes o autoevalúate en el Temario.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="metric-glow text-2xl font-black text-rose-400 font-mono">
                {risk.riskTopics.length}
              </span>
              <span className="text-xs text-slate-400">en zona de riesgo</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-3">
              De {risk.measuredUnitsCount} unidades con nivel medido · dominio &lt; 50% o con
              errores activos
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Enfoque                                                             */
/* ------------------------------------------------------------------ */

export async function DashboardFocus() {
  const focus = await loadFocusData();
  return <FocusLock topics={focus.topics} today={focus.today} />;
}

/* ------------------------------------------------------------------ */
/* Columna principal: clase + plan del día                             */
/* ------------------------------------------------------------------ */

export async function DashboardToday() {
  const dayKey = localDayKey(new Date());
  const [plan, checkInItems] = await Promise.all([
    safeDb<Awaited<ReturnType<typeof ensureTodayPlan>> | null>(
      'cuartel.plan',
      () => readDayPlan(dayKey),
      null,
      5_500
    ),
    safeDb<Awaited<ReturnType<typeof getTodayClassCheckIn>>>(
      'cuartel.clase',
      () => readTodayCheckIn(dayKey),
      [],
      3_500
    ),
  ]);

  return (
    <div className="min-w-0 space-y-4">
      <ClassCheckIn items={checkInItems} />

      {plan ? (
        <HoyTocaEsto plan={plan} />
      ) : (
        <div className="glass-card rounded-2xl border-amber-500/25 p-5">
          <p className="text-sm font-semibold text-slate-100">El plan de hoy aún no está listo</p>
          <p className="mt-1 text-xs text-slate-400">
            La base de datos ha tardado más de lo previsto. El resto del Cuartel sigue disponible y
            el plan se generará en segundo plano.
          </p>
          <Link
            href="/planificador"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] font-semibold text-amber-300"
          >
            Abrir planificador
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}

      {/* Banner Rápido de BrainUp Tutor IA */}
      <div className="glass-card glow-violet relative flex flex-col justify-between gap-4 overflow-hidden border-emerald-500/25 bg-gradient-to-r from-emerald-500/[0.07] via-transparent to-violet-500/[0.06] p-5 shadow-[0_0_28px_rgba(16,185,129,0.10)] sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100">
              ¿Atascado en un problema o concepto?
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Consulta a <strong className="text-slate-200">BrainUp</strong> o a tus{' '}
              <strong className="text-slate-200">Catedráticos IA</strong>. Explicaciones socráticas
              paso a paso con rúbrica PAU.
            </p>
          </div>
        </div>
        <Link
          href="/brainup"
          className="shrink-0 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-4 py-2.5 text-center text-xs font-bold text-white shadow-lg shadow-purple-950/40 transition-all hover:from-blue-500 hover:to-purple-500 hover:shadow-purple-600/30 hover:scale-[1.02]"
        >
          Abrir Tutor IA
        </Link>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Radar lateral                                                       */
/* ------------------------------------------------------------------ */

export function DashboardRadar() {
  return (
    <div className="min-w-0 space-y-6">
      <Suspense fallback={<PanelSkeleton lines={2} />}>
        <ExamsWidget />
      </Suspense>
      <Suspense fallback={<PanelSkeleton lines={2} />}>
        <MoodleWidget />
      </Suspense>
      <Suspense fallback={<PanelSkeleton lines={2} />}>
        <RiskWidget />
      </Suspense>
      <Suspense fallback={<PanelSkeleton lines={2} />}>
        <ReviewWidget />
      </Suspense>
      <Suspense fallback={<PanelSkeleton lines={2} />}>
        <HabitsWidget />
      </Suspense>
    </div>
  );
}

async function ExamsWidget() {
  const exams = await loadUpcomingExams();

  return (
    <div className="glass-card p-4 rounded-2xl space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
          <GraduationCap className="w-4 h-4 text-amber-400" />
          <span>Exámenes y PAU</span>
        </h3>
        <Link
          href="/examenes"
          className="text-[11px] text-amber-400 hover:text-amber-300 font-semibold"
        >
          Gestionar
        </Link>
      </div>

      <div className="space-y-2.5">
        {exams.map((exam) => {
          const daysLeft = Math.max(
            0,
            Math.ceil(
              (new Date(exam.examDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
            )
          );
          return (
            <div
              key={exam.id}
              className="p-3 rounded-lg bg-[#0a0a0c] border border-slate-800/80 flex items-center justify-between"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded border"
                    style={{
                      backgroundColor: `${exam.subject.color}15`,
                      borderColor: `${exam.subject.color}40`,
                      color: exam.subject.color,
                    }}
                  >
                    {exam.subject.name}
                  </span>
                  {exam.subject.pauWeight > 0 && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono">
                      x{exam.subject.pauWeight}
                    </span>
                  )}
                </div>
                <h4 className="text-xs font-semibold text-slate-200 mt-1">{exam.title}</h4>
              </div>

              <div className="text-right pl-3 font-mono">
                <span
                  className={`text-sm font-bold ${
                    daysLeft <= 7 ? 'text-rose-400' : 'text-amber-400'
                  }`}
                >
                  {daysLeft}d
                </span>
                <p className="text-[9px] text-slate-500">restantes</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

async function MoodleWidget() {
  const moodleTasks = await loadMoodleTasks();

  return (
    <div className="glass-card p-4 rounded-2xl space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
          <ClipboardList className="w-4 h-4 text-blue-400" />
          <span>Entregas y Tareas</span>
        </h3>
        <Link
          href="/ajustes"
          className="text-[11px] text-blue-400 hover:text-blue-300 font-semibold"
        >
          Sincronizar
        </Link>
      </div>

      {moodleTasks.length === 0 ? (
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Sin entregas pendientes. Conecta tu calendario de Moodle en Ajustes para verlas aquí.
        </p>
      ) : (
        <div className="space-y-2">
          {moodleTasks.map((task) => {
            const daysLeft = Math.max(
              0,
              Math.ceil((new Date(task.dueDate).getTime() - Date.now()) / 86400000)
            );
            return (
              <div
                key={task.id}
                className="p-2.5 rounded-lg bg-[#0a0a0c] border border-slate-800/80 text-xs flex items-center justify-between gap-2"
              >
                <div className="min-w-0 truncate">
                  <p className="flex items-center gap-1.5 truncate text-[10px] font-medium text-slate-400">
                    <span className="truncate">{task.subject?.name || task.courseName}</span>
                    {task.submitted === true && (
                      <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-emerald-300">
                        entregada
                      </span>
                    )}
                  </p>
                  {task.moodleUrl ? (
                    <a
                      href={task.moodleUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate font-semibold text-slate-200 hover:text-emerald-300"
                    >
                      {task.title}
                    </a>
                  ) : (
                    <p className="truncate font-semibold text-slate-200">{task.title}</p>
                  )}
                </div>
                <div className="text-right shrink-0 font-mono">
                  <span
                    className={`text-xs font-bold ${
                      daysLeft <= 2
                        ? 'text-rose-400'
                        : daysLeft <= 7
                          ? 'text-amber-400'
                          : 'text-slate-300'
                    }`}
                  >
                    {daysLeft}d
                  </span>
                  <p className="text-[9px] text-slate-500">entrega</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

async function RiskWidget() {
  const risk = await loadRiskData();

  return (
    <div className="glass-card p-4 rounded-2xl space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 text-rose-400" />
          <span>Temas en Riesgo</span>
        </h3>
        <Link
          href="/errores"
          className="text-[11px] text-rose-400 hover:text-rose-300 font-semibold"
        >
          Banco de Errores
        </Link>
      </div>

      <div className="space-y-2">
        {risk.riskTopics.length === 0 && (
          <p className="text-[11px] text-slate-500 leading-relaxed">
            {risk.measuredUnitsCount === 0
              ? 'Todavía no hay ninguna medición real de tu nivel. Declara tus notas en Ajustes o autoevalúa unidades en el Temario y esta lista empezará a decir algo cierto.'
              : 'Ninguna unidad medida está en zona de riesgo. Buen trabajo.'}
          </p>
        )}
        {risk.riskTopics.map((topic) => (
          <div
            key={topic.id}
            className="p-2.5 rounded-lg bg-[#0a0a0c] border border-slate-800/80 text-xs flex items-center justify-between"
          >
            <div className="truncate mr-2">
              <p className="text-[10px] font-medium text-slate-400">{topic.subject.name}</p>
              <p className="font-semibold text-slate-200 truncate">{topic.title}</p>
            </div>
            <div className="text-right shrink-0">
              <span
                className={`font-mono text-xs font-bold ${
                  topic.masteryLevel < 40 ? 'text-rose-400' : 'text-amber-400'
                }`}
              >
                {topic.masteryLevel}%
              </span>
              {topic.errors.length > 0 && (
                <p className="text-[9px] text-rose-400 font-mono">
                  {topic.errors.length} fallos
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

async function ReviewWidget() {
  const review = await loadReviewData();

  return (
    <div className="glass-card p-4 rounded-2xl space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
          <Repeat className="w-4 h-4 text-cyan-400" />
          <span>Repaso y Retos</span>
        </h3>
        <Link
          href="/retos"
          className="text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold"
        >
          Ver retos
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Link
          href="/repaso"
          className="p-2.5 rounded-lg bg-[#0a0a0c] border border-slate-800/80 space-y-1 transition-colors hover:border-cyan-500/40"
        >
          <p className="text-[9px] uppercase tracking-wider text-slate-500 font-mono">
            Repasos de hoy
          </p>
          <p
            className={`text-lg font-black font-mono ${
              review.dueReviewsCount > 0 ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            {review.dueReviewsCount}
          </p>
          <p className="text-[10px] text-slate-500 leading-tight">
            {review.scheduledCount === 0
              ? 'Sin calendario todavía: empieza en Repaso Espaciado.'
              : review.dueReviewsCount === 0
                ? 'Al día: nada vencido ahora mismo.'
                : 'Empieza por lo más vencido.'}
          </p>
        </Link>

        <Link
          href="/retos"
          className="p-2.5 rounded-lg bg-[#0a0a0c] border border-slate-800/80 space-y-1 transition-colors hover:border-cyan-500/40"
        >
          <p className="text-[9px] uppercase tracking-wider text-slate-500 font-mono flex items-center gap-1">
            <Target className="w-2.5 h-2.5" />
            Retos de la semana
          </p>
          <p className="text-lg font-black font-mono text-slate-100">
            {review.challengesCompleted}/{review.challengesTotal}
          </p>
          <p className="text-[10px] text-slate-500 leading-tight">
            {review.challengesTotal === 0
              ? 'Genéralos desde Retos Semanales.'
              : `Nivel ${review.level.level} · ${review.level.title}`}
          </p>
        </Link>
      </div>
    </div>
  );
}

async function HabitsWidget() {
  const habits = await loadHabits();
  const habitItems = habits.map((habit) => ({
    id: habit.id,
    title: habit.title,
    description: habit.description,
    streak: habit.streak,
    isCompletedToday: habit.logs.length > 0,
  }));

  return (
    <div className="glass-card p-4 rounded-2xl space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
          Hábitos y Disciplina
        </h3>
        <span className="text-[11px] text-emerald-400 font-mono font-semibold">
          {habitItems.filter((habit) => habit.isCompletedToday).length}/{habitItems.length}
        </span>
      </div>

      <div className="space-y-2">
        {habitItems.map((habit) => (
          <HabitItem key={habit.id} habit={habit} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Utilidades de fecha                                                 */
/* ------------------------------------------------------------------ */

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}
