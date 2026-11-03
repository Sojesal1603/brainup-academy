import { prisma } from '@/lib/prisma';
import { calculateRequiredHoursForTopic } from '@/lib/planner';
import { reviewDayProgress } from '@/lib/dayPlan';
import { StudyMode } from '@/lib/types';
import ModeSwitcher from '@/components/dashboard/ModeSwitcher';
import PlannerControls from '@/components/planificador/PlannerControls';
import { AlertTriangle, CalendarDays, CheckCircle2, Clock, Repeat, Target } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/** Clave de día en hora LOCAL: los bloques se guardan a medianoche local y
 * `toISOString()` los movía al día anterior en España (UTC+1/+2). */
function localDayKey(date: Date): string {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default async function PlannerPage() {
  const user = await prisma.userProfile.findUnique({
    where: { id: 'user_default' },
  });

  // Foto del avance real del día: es la misma que usa el motor al recalcular,
  // así que la tarjeta y el plan nuevo no pueden contar cosas distintas.
  const review = await reviewDayProgress();

  const subjects = await prisma.subject.findMany({
    include: {
      topics: {
        include: {
          errors: { where: { isMastered: false } },
        },
      },
      exams: {
        where: { isCompleted: false },
        orderBy: { examDate: 'asc' },
      },
    },
    orderBy: { order: 'asc' },
  });

  // Horas necesarias totales por asignatura y en global.
  let totalRequiredHoursAllSubjects = 0;
  for (const subj of subjects) {
    for (const topic of subj.topics) {
      totalRequiredHoursAllSubjects += calculateRequiredHoursForTopic(topic, subj.targetGrade);
    }
  }

  // Bloques de los próximos 7 días, agrupados por día.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const sevenDaysLater = new Date(todayStart.getTime() + 7 * 86400000);

  const upcomingBlocks = await prisma.studyBlock.findMany({
    where: { date: { gte: todayStart, lte: sevenDaysLater } },
    include: { topic: { include: { subject: true } } },
    orderBy: [{ date: 'asc' }, { orderIndex: 'asc' }],
  });

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(todayStart.getTime() + i * 86400000);
    const key = localDayKey(date);
    const blocks = upcomingBlocks.filter((block) => localDayKey(new Date(block.date)) === key);
    return {
      key,
      date,
      blocks,
      minutes: blocks.reduce((total, block) => total + block.durationMinutes, 0),
    };
  });

  const weeksDays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  // Próximo examen por asignatura: es lo que decide el orden de las sesiones.
  const nextExams = subjects
    .map((subject) => ({ subject, exam: subject.exams[0] ?? null }))
    .filter((row) => row.exam !== null)
    .sort(
      (a, b) =>
        (a.exam?.examDate.getTime() ?? 0) - (b.exam?.examDate.getTime() ?? 0)
    )
    .slice(0, 4);

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-white/10">
        <div>
          <div className="flex items-center gap-2">
            <CalendarDays className="w-6 h-6 text-emerald-400" />
            <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
              Planificador Estratégico
            </h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Sesiones de 10 a 90 minutos según el tiempo real, la dificultad, tu nivel y el examen.
            Cada día revisa lo completado y lo retrasado antes de repartir lo que queda.
          </p>
        </div>

        <ModeSwitcher currentMode={(user?.studyMode as StudyMode) || 'athlete'} />
      </div>

      {/* Revisión diaria: qué se ha hecho, qué queda y qué se retrasó */}
      <div className="glass-card p-4 rounded-2xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-300">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            Cómo va el día
          </h2>
          <span className="font-mono text-[10px] text-slate-500">{review.dayKey}</span>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2">
            <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">
              Completado
            </p>
            <p className="mt-0.5 font-mono text-lg font-black text-emerald-400">
              {review.completedBlocks}
            </p>
            <p className="text-[10px] text-slate-500">{review.completedMinutes} min cerrados</p>
          </div>

          <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2">
            <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">
              Pendiente hoy
            </p>
            <p className="mt-0.5 font-mono text-lg font-black text-amber-400">
              {review.pendingBlocks + review.inProgressBlocks}
            </p>
            <p className="text-[10px] text-slate-500">{review.remainingMinutes} min por hacer</p>
          </div>

          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
            <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">
              Retrasado
            </p>
            <p
              className={`mt-0.5 font-mono text-lg font-black ${
                review.delayedBlocks > 0 ? 'text-rose-400' : 'text-slate-300'
              }`}
            >
              {review.delayedBlocks}
            </p>
            <p className="text-[10px] text-slate-500">de días anteriores</p>
          </div>

          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
            <p className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-slate-500">
              <Repeat className="h-2.5 w-2.5" /> Repaso vencido
            </p>
            <p className="mt-0.5 font-mono text-lg font-black text-cyan-300">
              {review.dueReviews}
            </p>
            <p className="text-[10px] text-slate-500">{review.availableMinutes} min reales hoy</p>
          </div>
        </div>

        {review.delayedTopics.length > 0 && (
          <div className="space-y-1">
            <p className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-500">
              <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
              Se quedó atrás (vuelve al plan si cabe)
            </p>
            {review.delayedTopics.slice(0, 3).map((topic) => (
              <div
                key={`${topic.subjectName}-${topic.title}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
              >
                <span className="truncate text-[11px] text-slate-300">
                  <span style={{ color: topic.subjectColor }}>{topic.subjectName}</span>:{' '}
                  {topic.title}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-rose-400">
                  {topic.daysLate}d
                </span>
              </div>
            ))}
          </div>
        )}

        {review.exams.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {review.exams.map((exam) => (
              <span
                key={exam.id}
                className="rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300"
              >
                <span style={{ color: exam.subjectColor }}>{exam.subjectName}</span> ·{' '}
                {exam.format === 'desarrollo'
                  ? 'Desarrollo'
                  : exam.format === 'practico'
                    ? 'Práctico'
                    : 'Test'}{' '}
                ·{' '}
                <span className={exam.days <= 7 ? 'text-rose-400' : 'text-amber-400'}>
                  {exam.days}d
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Generador: tiempo disponible y plan calculado */}
      <PlannerControls />

      {/* Capacidad vs horas necesarias */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="glass-card p-4 rounded-2xl">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-xs font-semibold uppercase">Horas Requeridas Estimadas</span>
            <Clock className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="metric-glow text-2xl font-black text-slate-100 font-mono">
              {Math.round(totalRequiredHoursAllSubjects)}h
            </span>
            <span className="text-xs text-slate-400">para dominar el temario al 100%</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            Calculado en base a dificultad 1-5 y dominio actual
          </p>
        </div>

        <div className="glass-card p-4 rounded-2xl">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-xs font-semibold uppercase">Disponibilidad Semanal</span>
            <Target className="w-4 h-4 text-blue-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="metric-glow text-2xl font-black text-blue-400 font-mono">
              {user?.weeklyHoursCap}h
            </span>
            <span className="text-xs text-slate-400">por semana configuradas</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            Horas que puedes dedicar por semana
          </p>
        </div>

        <div className="glass-card p-4 rounded-2xl">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-xs font-semibold uppercase">Planificado esta Semana</span>
            <CalendarDays className="w-4 h-4 text-violet-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="metric-glow text-2xl font-black text-violet-300 font-mono">
              {Math.round(upcomingBlocks.reduce((total, block) => total + block.durationMinutes, 0) / 60)}h
            </span>
            <span className="text-xs text-slate-400">en los próximos 7 días</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            {upcomingBlocks.length} {upcomingBlocks.length === 1 ? 'sesión viva' : 'sesiones vivas'}
          </p>
        </div>
      </div>

      {/* Próximos exámenes: los que mandan en el reparto */}
      {nextExams.length > 0 && (
        <div className="glass-card p-4 rounded-2xl space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Próximos exámenes que ordenan el plan
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {nextExams.map(({ subject, exam }) => {
              const daysLeft = Math.max(
                0,
                Math.ceil(((exam?.examDate.getTime() ?? Date.now()) - Date.now()) / 86400000)
              );
              return (
                <div
                  key={`${subject.id}-${exam?.id}`}
                  className="p-3 rounded-xl bg-[#080d17] border border-slate-800/80 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase" style={{ color: subject.color }}>
                      {subject.name}
                    </p>
                    <p className="text-xs font-semibold text-slate-200 truncate">{exam?.title}</p>
                  </div>
                  <span
                    className={`shrink-0 font-mono text-sm font-bold ${
                      daysLeft <= 7 ? 'text-rose-400' : 'text-amber-400'
                    }`}
                  >
                    {daysLeft}d
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-500">
            ¿Falta una fecha o su formato (test, desarrollo, práctico)?{' '}
            <Link href="/examenes" className="text-emerald-400 hover:text-emerald-300 font-semibold">
              Añádela en Exámenes
            </Link>
            .
          </p>
        </div>
      )}

      {/* Calendario de 7 días */}
      <div className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200">
          Los próximos 7 días
        </h2>

        {upcomingBlocks.length === 0 ? (
          <div className="glass-card p-6 text-center space-y-2">
            <p className="text-sm text-slate-300 font-semibold">Todavía no hay sesiones vivas.</p>
            <p className="text-xs text-slate-500">
              Genera el plan arriba o completa tu puesta a punto para que el motor sepa qué te toca.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {days.map((day) => (
              <div key={day.key} className="glass-card p-4 space-y-2">
                <div className="flex items-baseline justify-between">
                  <p className="text-xs font-bold text-slate-200">
                    {weeksDays[day.date.getDay()]}{' '}
                    <span className="text-slate-500 font-mono">
                      {String(day.date.getDate()).padStart(2, '0')}/{String(day.date.getMonth() + 1).padStart(2, '0')}
                    </span>
                  </p>
                  <span className="text-[10px] font-mono text-slate-500">{day.minutes} min</span>
                </div>

                {day.blocks.length === 0 ? (
                  <p className="text-[11px] text-slate-600">Descanso</p>
                ) : (
                  <div className="space-y-1.5">
                    {day.blocks.map((block) => (
                      <Link
                        key={block.id}
                        href={`/enfoque?block=${block.id}`}
                        className="block rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 transition-colors hover:border-emerald-500/40"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold" style={{ color: block.topic.subject.color }}>
                            {block.topic.subject.name}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500">
                            {block.durationMinutes}m
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-300 truncate">{block.topic.title}</p>
                        {block.isCompleted && (
                          <p className="text-[10px] text-emerald-400 font-mono">completada</p>
                        )}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
