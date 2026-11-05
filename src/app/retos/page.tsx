import { prisma } from '@/lib/prisma';
import { ensureUserProfile } from '@/lib/userProfile';
import {
  challengeProgress,
  levelFromXp,
  weekKeyOf,
  weekRangeLabel,
  weekStartOf,
  type ChallengeKind,
  isChallengeKind,
} from '@/lib/challenges';
import { currentWeekWindow, loadWeekWorkData } from '@/lib/challengeWeek';
import ChallengeCard from '@/components/retos/ChallengeCard';
import ChallengesWeekBar from '@/components/retos/ChallengesWeekBar';
import { Award, History, Target, Trophy } from 'lucide-react';

export const dynamic = 'force-dynamic';

/**
 * Retos semanales.
 *
 * La página no genera nada al pintarse: los retos los crea la acción
 * (el botón), porque crear filas al renderizar una vista es la forma de llenar
 * la base de duplicados cada vez que alguien pasa por aquí.
 *
 * Lo que SÍ hace es medir con la misma pieza que el motor de cierre
 * (`loadWeekWorkData` + `challengeProgress`): si midiera distinto, un reto
 * podría verse al 90% y cerrarse como conseguido en el mismo segundo.
 */
export default async function ChallengesPage() {
  const now = new Date();
  const weekKey = weekKeyOf(now);
  const weekStart = weekStartOf(now);
  const weekLabel = weekRangeLabel(weekStart);

  const [profile, subjects, weekRows, pastRows, workData] = await Promise.all([
    ensureUserProfile(),
    prisma.subject.findMany({ select: { id: true, name: true } }),
    prisma.weeklyChallenge.findMany({ where: { weekKey }, orderBy: { createdAt: 'asc' } }),
    prisma.weeklyChallenge.findMany({
      where: { weekKey: { not: weekKey } },
      orderBy: [{ weekStart: 'desc' }, { createdAt: 'asc' }],
      take: 60,
    }),
    loadWeekWorkData(currentWeekWindow(now)),
  ]);

  const subjectNameById = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const level = levelFromXp(profile?.challengeXp ?? 0);

  const week = weekRows.map((row) => ({
    challenge: {
      id: row.id,
      kind: row.kind,
      title: row.title,
      description: row.description,
      target: row.target,
      unit: row.unit,
      rewardXp: row.rewardXp,
      status: row.status,
      subjectName: row.subjectId ? subjectNameById.get(row.subjectId) ?? null : null,
    },
    current: challengeProgress(
      (isChallengeKind(row.kind) ? row.kind : 'study_minutes') as ChallengeKind,
      { subjectId: row.subjectId, topicId: row.topicId },
      workData,
      now
    ),
  }));

  const counts = {
    active: weekRows.filter((row) => row.status === 'active').length,
    completed: weekRows.filter((row) => row.status === 'completed').length,
    expired: weekRows.filter((row) => row.status === 'expired').length,
  };

  // Historial: se agrupa por semana para no pintar doce filas sueltas.
  const grouped = new Map<string, { weekStart: Date; completed: number; total: number }>();
  for (const row of pastRows) {
    const entry = grouped.get(row.weekKey) ?? { weekStart: row.weekStart, completed: 0, total: 0 };
    entry.total += 1;
    if (row.status === 'completed') entry.completed += 1;
    grouped.set(row.weekKey, entry);
  }
  const history = [...grouped.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime())
    .slice(0, 8);

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="pb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Target className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
            Retos Semanales
          </h1>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Retos cortos de una semana, construidos con datos reales de tu expediente: los repasos
          que se te han vencido, los errores sin cerrar, el examen que tienes encima y las horas
          que tú mismo declaraste.
        </p>
        <p className="text-xs text-slate-400 mt-1">
          El progreso se <strong className="text-slate-300">mide solo</strong> con lo que registras
          en la app —sesiones de Modo Enfoque, repasos espaciados, errores cerrados y simulacros—:
          aquí no hay casillas que marcar a mano.
        </p>
      </div>

      {/* Nivel y experiencia */}
      <div className="p-6 rounded-3xl bg-gradient-to-br from-[#0c1626] via-[#131825] to-[#070d18] border border-emerald-500/40 shadow-2xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Trophy className="w-5 h-5 text-emerald-400" />
              <span className="text-xs font-mono font-bold uppercase tracking-widest text-emerald-400">
                Expediente de retos
              </span>
            </div>
            <h2 className="text-xl font-black text-slate-100">
              Nivel {level.level} · {level.title}
            </h2>
            <p className="text-xs text-slate-400 max-w-lg leading-relaxed">
              Cada reto conseguido paga su XP y el nivel sale de ahí. El nivel{' '}
              <strong className="text-slate-300">no se guarda</strong>: se calcula con la XP
              acumulada, así no puede quedarse desfasado.
            </p>
          </div>

          <div className="shrink-0 bg-[#060a13]/80 p-4 rounded-2xl border border-slate-800 w-full md:w-64 space-y-2">
            <div className="flex items-baseline justify-between font-mono">
              <span className="text-3xl font-black text-emerald-400">{level.totalXp}</span>
              <span className="text-[10px] uppercase text-slate-500">XP total</span>
            </div>
            <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${level.percent}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-400 font-mono">
              {level.xpInLevel} / {level.xpForNext} XP para el nivel {level.level + 1}
            </p>
          </div>
        </div>
      </div>

      {/* Barra de la semana: la única que pide algo al servidor */}
      <ChallengesWeekBar
        weekLabel={weekLabel}
        weekKey={weekKey}
        counts={counts}
        totalXp={level.totalXp}
        hasChallenges={weekRows.length > 0}
      />

      {/* Retos de esta semana */}
      <div className="space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
          <Award className="w-4 h-4 text-emerald-400" />
          <span>Retos de esta semana</span>
          <span className="text-xs text-slate-500 font-mono">({weekRows.length})</span>
        </h2>

        {weekRows.length === 0 ? (
          <div className="p-6 rounded-2xl glass-card border border-dashed border-white/10 space-y-2">
            <p className="text-xs text-slate-300 font-semibold">
              Esta semana todavía no tiene retos.
            </p>
            <p className="text-[11px] text-slate-400 leading-relaxed max-w-2xl">
              Pulsa <strong className="text-slate-300">«Generar los retos de esta semana»</strong> y
              se construirán con lo que haya en tu expediente: unidades con el repaso vencido,
              errores abiertos en el banco, exámenes con fecha y tus horas semanales. Si aún no hay
              nada de eso, habrá menos retos — no se inventan de relleno.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {week.map((item) => (
              <ChallengeCard
                key={item.challenge.id}
                challenge={item.challenge}
                current={item.current}
              />
            ))}
          </div>
        )}
      </div>

      {/* Historial */}
      {history.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
            <History className="w-4 h-4 text-slate-400" />
            <span>Semanas anteriores</span>
          </h2>

          <div className="rounded-2xl glass-card divide-y divide-[#1e293b]">
            {history.map((entry) => (
              <div
                key={entry.key}
                className="flex items-center justify-between gap-3 px-4 py-3 text-xs"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-slate-500">{entry.key}</span>
                  <span className="text-slate-300">{weekRangeLabel(entry.weekStart)}</span>
                </div>
                <span
                  className={
                    entry.completed === entry.total
                      ? 'font-mono text-emerald-400'
                      : entry.completed > 0
                        ? 'font-mono text-amber-400'
                        : 'font-mono text-slate-500'
                  }
                >
                  {entry.completed}/{entry.total} conseguidos
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
