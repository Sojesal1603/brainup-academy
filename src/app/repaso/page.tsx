import { prisma } from '@/lib/prisma';
import {
  buildRetentionAnalytics,
  buildReviewQueue,
  estimateRetention,
  retentionTone,
  type SrsReviewRow,
} from '@/lib/srs';
import nextDynamic from 'next/dynamic';
import type { ReviewItemView } from '@/components/srs/ReviewQueue';
import { PanelSkeleton } from '@/components/ui/Skeletons';

// La cola y la analítica son interactivas y se cargan después de los KPIs.
const ReviewQueue = nextDynamic(() => import('@/components/srs/ReviewQueue'), {
  loading: () => <PanelSkeleton lines={4} />,
});
const RetentionPanel = nextDynamic(() => import('@/components/srs/RetentionPanel'), {
  loading: () => <PanelSkeleton lines={3} />,
});
import { AlertTriangle, Gauge, History, Repeat, Target } from 'lucide-react';

export const dynamic = 'force-dynamic';

/** Ventana de repasos que entra en la analítica (más atrás ya no es un patrón, es historia). */
const ANALYSIS_WINDOW_DAYS = 90;

/** Cuántas unidades sin calendario se ofrecen para empezarlo. */
const STARTER_LIMIT = 8;

/** «toca hoy» / «en 4 días» / «vencida hace 3 días». */
function daysLabel(days: number): string {
  if (days < 0) {
    const late = Math.abs(days);
    return `vencida hace ${late} ${late === 1 ? 'día' : 'días'}`;
  }
  if (days === 0) return 'toca hoy';
  return `en ${days} ${days === 1 ? 'día' : 'días'}`;
}

/** «hace 3 días», para decir la última vez que se tocó la unidad. */
function agoLabel(date: Date, now: Date): string {
  const days = Math.max(
    0,
    Math.round((now.getTime() - new Date(date).getTime()) / 86400000)
  );
  if (days === 0) return 'hoy';
  if (days === 1) return 'ayer';
  return `hace ${days} días`;
}

export default async function RepasoPage() {
  const now = new Date();
  const windowStart = new Date(now.getTime() - ANALYSIS_WINDOW_DAYS * 86400000);

  const [scheduledTopics, starterTopics, reviewRows] = await Promise.all([
    // Unidades con calendario: las que ya se han repasado alguna vez.
    prisma.topic.findMany({
      where: { lastReviewedAt: { not: null } },
      include: { subject: { select: { id: true, name: true, color: true } } },
      orderBy: { lastReviewedAt: 'asc' },
    }),
    // Unidades que ya se han dado en clase pero nunca han pasado por el SRS:
    // aquí se les da la primera pasada. No se ofrecen las pendientes (mentira).
    prisma.topic.findMany({
      where: { lastReviewedAt: null, status: { in: ['visto', 'en_curso'] } },
      include: { subject: { select: { id: true, name: true, color: true } } },
      orderBy: [{ seenInClassAt: 'desc' }, { unitNumber: 'asc' }],
      take: STARTER_LIMIT,
    }),
    prisma.srsReview.findMany({
      where: { reviewedAt: { gte: windowStart } },
      orderBy: { reviewedAt: 'desc' },
      take: 500,
      select: {
        reviewedAt: true,
        rating: true,
        quality: true,
        recalled: true,
        intervalBeforeDays: true,
        intervalAfterDays: true,
        easeAfter: true,
        overdueDays: true,
      },
    }),
  ]);

  const queue = buildReviewQueue(scheduledTopics, now);

  const toView = (item: (typeof queue)[number]): ReviewItemView => ({
    topicId: item.topic.id,
    title: item.topic.title,
    unitLabel: item.topic.unitNumber ? `U${item.topic.unitNumber}` : null,
    subjectName: item.topic.subject.name,
    subjectColor: item.topic.subject.color,
    due: item.due,
    daysUntil: item.daysUntil,
    overdue: item.overdue,
    retention: item.retention,
    scheduleLabel: daysLabel(item.daysUntil),
    lastReviewedLabel: item.topic.lastReviewedAt ? agoLabel(item.topic.lastReviewedAt, now) : null,
  });

  const due = queue.filter((item) => item.due).map(toView);
  // Lo que viene después: se enseña para que el calendario no sea una caja negra.
  const upcoming = queue.filter((item) => !item.due).slice(0, STARTER_LIMIT).map(toView);

  const starters: ReviewItemView[] = starterTopics.map((topic) => ({
    topicId: topic.id,
    title: topic.title,
    unitLabel: topic.unitNumber ? `U${topic.unitNumber}` : null,
    subjectName: topic.subject.name,
    subjectColor: topic.subject.color,
    due: false,
    daysUntil: 0,
    overdue: 0,
    retention: null,
    scheduleLabel: 'sin calendario todavía',
    lastReviewedLabel: null,
  }));

  const analytics = buildRetentionAnalytics(reviewRows as SrsReviewRow[], now);

  // Retención estimada media: solo sobre unidades con calendario. Sin ninguna,
  // es `null` y se pinta un guion, no un 0 que parecería un dato.
  const retentions = scheduledTopics
    .map((topic) => estimateRetention(topic, now))
    .filter((value): value is number => value !== null);
  const avgRetention =
    retentions.length > 0
      ? Math.round(retentions.reduce((acc, value) => acc + value, 0) / retentions.length)
      : null;

  // La que peor se recuerda ya: es la que más urge, y merece decirse con nombre.
  const worst = scheduledTopics
    .map((topic) => ({ topic, retention: estimateRetention(topic, now) }))
    .filter((row): row is { topic: (typeof scheduledTopics)[number]; retention: number } =>
      row.retention !== null
    )
    .sort((a, b) => a.retention - b.retention)[0];

  const worstTone = worst ? retentionTone(worst.retention) : null;

  const kpis = [
    {
      label: 'Repasos vencidos o de hoy',
      value: String(due.length),
      hint:
        due.length === 0
          ? 'El calendario está al día. Nada que repasar ahora mismo.'
          : 'Empieza por el primero: lo más vencido y peor recordado.',
      icon: AlertTriangle,
      accent: due.length > 0 ? 'text-amber-400' : 'text-emerald-400',
    },
    {
      label: 'Retención estimada media',
      value: avgRetention === null ? '—' : `${avgRetention}%`,
      hint:
        avgRetention === null
          ? 'Sin unidades repasadas todavía: no hay nada que estimar.'
          : 'Estimación de la curva del olvido sobre las unidades ya repasadas.',
      icon: Gauge,
      accent: 'text-sky-400',
    },
    {
      label: 'Recuerdo real',
      value: analytics.recallRate === null ? '—' : `${analytics.recallRate}%`,
      hint:
        analytics.recallRate === null
          ? 'Se calcula cuando registres repasos: son los que dicen qué recuerdas de verdad.'
          : `${analytics.recalled} de ${analytics.totalReviews} repasos recordados.`,
      icon: Target,
      accent:
        analytics.recallRate === null
          ? 'text-slate-500'
          : analytics.recallRate >= 85
            ? 'text-emerald-400'
            : analytics.recallRate >= 70
              ? 'text-sky-400'
              : 'text-rose-400',
    },
    {
      label: 'Repasos esta semana',
      value: String(analytics.reviewsThisWeek),
      hint: 'Cada repaso registrado afina el intervalo y la analítica.',
      icon: History,
      accent: 'text-violet-400',
    },
  ];

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="pb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Repeat className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
            Repaso Espaciado & Retención
          </h1>
        </div>
        <p className="text-xs text-slate-400 mt-1 max-w-3xl">
          El calendario es un <strong className="text-slate-300">SM-2</strong>: cada repaso alarga el
          intervalo si lo recuerdas y vuelve a un día si no, así que se ajusta a ti solo. Aquí ves
          qué toca repasar, cuánto se está enfriando cada unidad y —esto es lo único que no es una
          estimación— <strong className="text-slate-300">qué has recordado de verdad</strong>, que
          sale de los repasos que registras.
        </p>
      </div>

      {/* Indicadores */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div
              key={kpi.label}
              className="p-5 rounded-2xl glass-card space-y-1.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                  {kpi.label}
                </span>
                <Icon className={`w-4 h-4 ${kpi.accent}`} />
              </div>
              <p className={`text-3xl font-black font-mono ${kpi.accent}`}>{kpi.value}</p>
              <p className="text-[11px] text-slate-500 leading-relaxed">{kpi.hint}</p>
            </div>
          );
        })}
      </div>

      {/* Aviso de la unidad que peor se recuerda: un dato, no una alarma */}
      {worst && worstTone && (
        <div className="p-4 rounded-2xl border border-white/10 bg-[#0c1322] flex items-start gap-3">
          <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${worstTone.className}`} />
          <p className="text-xs text-slate-300 leading-relaxed">
            La que peor llevas es{' '}
            <strong className="text-slate-100">
              {worst.topic.subject.name}
              {worst.topic.unitNumber ? ` · U${worst.topic.unitNumber}` : ''} «{worst.topic.title}»
            </strong>
            : retención estimada del <span className="font-mono">{worst.retention}%</span> (
            {worstTone.label.toLowerCase()}).{' '}
            {worst.retention < 45
              ? 'Repásala hoy mismo: a este ritmo lo que queda se pierde antes del examen.'
              : 'Entra en la cola con prioridad, pero no está perdida.'}
          </p>
        </div>
      )}

      {/* Cola del día + primeras pasadas */}
      <ReviewQueue due={due} upcoming={upcoming} starters={starters} />

      {/* Analítica de retención */}
      <RetentionPanel analytics={analytics} windowDays={ANALYSIS_WINDOW_DAYS} />

      <p className="text-[11px] text-slate-500 leading-relaxed">
        {scheduledTopics.length === 0
          ? 'Todavía no hay ninguna unidad con calendario: empieza por una de las primeras pasadas de arriba y el calendario se construye solo.'
          : `Unidades con calendario activo: ${scheduledTopics.length}.`}{' '}
        El SRS no toca tu nivel de dominio: repasar no es lo mismo que saber, y el nivel lo siguen
        moviendo las sesiones de estudio y los simulacros.
      </p>
    </div>
  );
}
