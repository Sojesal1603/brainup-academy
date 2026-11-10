import { Suspense } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  GraduationCap,
  Sparkles,
  ArrowRight,
  Clock,
  CheckCircle2,
  ClipboardList,
  Repeat,
  Target,
} from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { ensureUserProfile } from '@/lib/userProfile';
import { buildReviewQueue } from '@/lib/srs';
import { levelFromXp, weekKeyOf } from '@/lib/challenges';
import HoyTocaEsto from '@/components/cuartel/HoyTocaEsto';
import HabitItem from '@/components/dashboard/HabitItem';
import { ensureTodayPlan } from '@/lib/dayPlan';
import ModeSwitcher from '@/components/dashboard/ModeSwitcher';
import ClassCheckIn from '@/components/cuartel/ClassCheckIn';
import { getTodayClassCheckIn } from '@/lib/temario';
import SetupCard from '@/components/dashboard/SetupCard';
import FocusLock from '@/components/enfoque/FocusLock';
import { PanelSkeleton } from '@/components/ui/Skeletons';
import { StudyMode } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  // 1. Perfil (memoizado con `cache()`: la consulta que ya hizo el Header en
  // esta misma petición no se repite) y plan del día.
  const user = await ensureUserProfile();
  const dayPlan = await ensureTodayPlan();

  // 2. Bloques de HOY
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  // 2. Bloques de HOY. En serie a propósito: con el pooler de Supabase
  // (`connection_limit=1`) todas las consultas comparten una conexión, así que
  // lanzarlas a la vez no ahorra tiempo y sí puede agotar el `pool_timeout`.
  const todayBlocks = await prisma.studyBlock.findMany({
    where: {
      date: {
        gte: startOfDay,
        lte: endOfDay,
      },
    },
    include: {
      topic: {
        include: {
          subject: true,
        },
      },
    },
    orderBy: { orderIndex: 'asc' },
  });

  // 3. Exámenes próximos con cuenta atrás
  const upcomingExams = await prisma.exam.findMany({
    where: { isCompleted: false, examDate: { gte: startOfDay } },
    include: { subject: true },
    orderBy: { examDate: 'asc' },
    take: 3,
  });

  // 3b. Entregas y tareas sincronizadas de Moodle
  const moodleTasks = await prisma.moodleTask.findMany({
    where: { isCompleted: false, dueDate: { gte: startOfDay } },
    include: { subject: true },
    orderBy: { dueDate: 'asc' },
    take: 4,
  });

  // 4. Hábitos de hoy
  const habits = await prisma.habit.findMany({
    include: { logs: { where: { date: { gte: startOfDay, lte: endOfDay } } } },
  });

  // 4b. Chequeo de clase: qué asignaturas has tenido hoy y qué unidad se dio.
  // Es lo que mantiene el temario actualizado sin pedirte que abras un libro.
  const checkInItems = await getTodayClassCheckIn();

  const completedBlocksCount = todayBlocks.filter((b) => b.isCompleted).length;
  const totalBlocksCount = todayBlocks.length;
  const totalMinutesToday = todayBlocks.reduce(
    (acc, b) => acc + (b.isCompleted ? b.durationMinutes : 0),
    0
  );

  const habitItems = habits.map((h) => ({
    id: h.id,
    title: h.title,
    description: h.description,
    streak: h.streak,
    isCompletedToday: h.logs.length > 0,
  }));

  // 5. Repaso espaciado y retos: el Cuartel dice lo que toca hoy sin obligar a
  // entrar en las páginas. Los repasos vencidos se cuentan con el mismo motor
  // SRS que la cola de `/repaso`, no con una consulta propia que pudiera diferir.
  const [srsScheduledTopics, weekChallengeRows] = await Promise.all([
    prisma.topic.findMany({
      where: { lastReviewedAt: { not: null } },
      select: { id: true, lastReviewedAt: true, srsIntervalDays: true, srsEaseFactor: true },
    }),
    prisma.weeklyChallenge.findMany({
      where: { weekKey: weekKeyOf(new Date()) },
      select: { status: true },
    }),
  ]);

  const dueReviewsCount = buildReviewQueue(srsScheduledTopics, new Date(), { onlyDue: true }).length;
  const challengesCompleted = weekChallengeRows.filter((row) => row.status === 'completed').length;
  const challengeLevel = levelFromXp(user?.challengeXp ?? 0);

  // 5b. Temas en Riesgo. Solo cuentan las unidades con nivel MEDIDO: un tema sin
  // medir no es un punto flojo, es una incógnita (y así se muestra).
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
      include: {
        subject: true,
        errors: { where: { isMastered: false } },
      },
      orderBy: [{ masteryLevel: 'asc' }, { difficulty: 'desc' }],
      take: 4,
    }),
  ]);

  // 6. Catedráticos IA disponibles para acceso rápido
  const agents = await prisma.aiAgent.findMany({
    include: { subject: true },
    take: 3,
  });

  // 6b. Focus & Lock: unidades para elegir bloque y métricas de tiempo real.
  const focusTopicsRaw = await prisma.topic.findMany({
    where: { subject: { isTracked: true } },
    select: {
      id: true,
      title: true,
      subject: { select: { name: true, color: true } },
    },
    orderBy: [{ subject: { order: 'asc' } }, { unitNumber: 'asc' }],
    take: 60,
  });

  const [focusAggregate, focusAbandoned] = await Promise.all([
    prisma.focusSession.aggregate({
      where: { startedAt: { gte: startOfDay } },
      _sum: { focusedSeconds: true, tutorSeconds: true },
    }),
    prisma.focusSession.count({
      where: { startedAt: { gte: startOfDay }, status: 'abandoned' },
    }),
  ]);

  const focusTopics = focusTopicsRaw.map((topic) => ({
    id: topic.id,
    title: topic.title,
    subjectName: topic.subject.name,
    color: topic.subject.color,
  }));

  const focusToday = {
    focusedMinutes: Math.round((focusAggregate._sum.focusedSeconds ?? 0) / 60),
    tutorMinutes: Math.round((focusAggregate._sum.tutorSeconds ?? 0) / 60),
    abandoned: focusAbandoned,
  };

  return (
    <div className="space-y-8">
      {/* Cabecera Táctica del Cuartel */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-white/10">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
            <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
              Cuartel General
            </h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Centro de mando diario. Enfoque absoluto en tu nota de corte PAU ({user?.targetGradePau}/14).
          </p>
        </div>

        {/* Selector de modo y recálculo */}
        <ModeSwitcher currentMode={(user?.studyMode as StudyMode) || 'athlete'} />
      </div>

      {/* Puesta a punto: qué falta por montar y acceso directo a la entrevista.
          Va en su propio Suspense: su cálculo no retrasa el resto del Cuartel. */}
      <Suspense fallback={<PanelSkeleton lines={1} />}>
        <SetupCard />
      </Suspense>

      {/* Tarjetas de Métricas Rápidas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Progreso de Hoy */}
        <div className="glass-card p-4 rounded-2xl">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider">
              Bloques de Hoy
            </span>
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
            <span className="text-xs font-semibold uppercase tracking-wider">
              Tiempo Enfocado
            </span>
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
            <span className="text-xs font-semibold uppercase tracking-wider">
              Próximo Hito
            </span>
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
            <span className="text-xs font-semibold uppercase tracking-wider">
              Temas Críticos
            </span>
            <AlertTriangle className="w-4 h-4 text-rose-400" />
          </div>
          {measuredUnitsCount === 0 ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-black text-slate-400 font-mono">—</span>
                <span className="text-xs text-slate-400">sin mediciones</span>
              </div>
              <p className="text-[11px] text-slate-500 mt-3">
                Ninguna unidad tiene el nivel medido todavía: no hay temas críticos que
                inventar. Declara tus notas en Ajustes o autoevalúate en el Temario.
              </p>
            </>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="metric-glow text-2xl font-black text-rose-400 font-mono">
                  {riskTopics.length}
                </span>
                <span className="text-xs text-slate-400">en zona de riesgo</span>
              </div>
              <p className="text-[11px] text-slate-500 mt-3">
                De {measuredUnitsCount} unidades con nivel medido · dominio &lt; 50% o con errores
                activos
              </p>
            </>
          )}
        </div>
      </div>

      <FocusLock topics={focusTopics} today={focusToday} />

      {/* Grid Principal: Bloques de Hoy (2 cols) + Radar Lateral (1 col) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Columna Izquierda / Central: Bloques de Hoy */}
        <div className="lg:col-span-2 space-y-4">
          <ClassCheckIn items={checkInItems} />

          <HoyTocaEsto plan={dayPlan} />

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

        {/* Columna Derecha: Exámenes Próximos, Temas en Riesgo & Hábitos */}
        <div className="space-y-6">
          {/* Exámenes con Cuenta Atrás */}
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
              {upcomingExams.map((exam) => {
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
                      <h4 className="text-xs font-semibold text-slate-200 mt-1">
                        {exam.title}
                      </h4>
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

          {/* Entregas y Tareas de Moodle */}
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

          {/* Temas en Riesgo */}
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
              {riskTopics.length === 0 && (
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  {measuredUnitsCount === 0
                    ? 'Todavía no hay ninguna medición real de tu nivel. Declara tus notas en Ajustes o autoevalúa unidades en el Temario y esta lista empezará a decir algo cierto.'
                    : 'Ninguna unidad medida está en zona de riesgo. Buen trabajo.'}
                </p>
              )}
              {riskTopics.map((topic) => (
                <div
                  key={topic.id}
                  className="p-2.5 rounded-lg bg-[#0a0a0c] border border-slate-800/80 text-xs flex items-center justify-between"
                >
                  <div className="truncate mr-2">
                    <p className="text-[10px] font-medium text-slate-400">
                      {topic.subject.name}
                    </p>
                    <p className="font-semibold text-slate-200 truncate">
                      {topic.title}
                    </p>
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

          {/* Repaso espaciado y retos: las dos cosas que se miden solas */}
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
                    dueReviewsCount > 0 ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  {dueReviewsCount}
                </p>
                <p className="text-[10px] text-slate-500 leading-tight">
                  {srsScheduledTopics.length === 0
                    ? 'Sin calendario todavía: empieza en Repaso Espaciado.'
                    : dueReviewsCount === 0
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
                  {challengesCompleted}/{weekChallengeRows.length}
                </p>
                <p className="text-[10px] text-slate-500 leading-tight">
                  {weekChallengeRows.length === 0
                    ? 'Genéralos desde Retos Semanales.'
                    : `Nivel ${challengeLevel.level} · ${challengeLevel.title}`}
                </p>
              </Link>
            </div>
          </div>

          {/* Hábitos Diarios */}
          <div className="glass-card p-4 rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                Hábitos y Disciplina
              </h3>
              <span className="text-[11px] text-emerald-400 font-mono font-semibold">
                {habitItems.filter((h) => h.isCompletedToday).length}/{habitItems.length}
              </span>
            </div>

            <div className="space-y-2">
              {habitItems.map((habit) => (
                <HabitItem key={habit.id} habit={habit} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
