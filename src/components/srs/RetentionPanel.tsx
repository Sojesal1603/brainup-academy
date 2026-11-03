import clsx from 'clsx';
import { Activity, BarChart3, Gauge, Info, TrendingDown } from 'lucide-react';
import { SRS_RATINGS, SRS_RATING_ORDER, type RetentionAnalytics } from '@/lib/srs';

/**
 * Analítica de retención.
 *
 * Todo lo que se enseña aquí viene de repasos **registrados**. Es la única parte
 * del sistema que no estima nada: qué has recordado y qué no. Por eso, cuando no
 * hay historial, este panel no dibuja un gráfico vacío ni un «0%»: lo dice.
 *
 * Es presentacional (sin estado ni 'use client'): el servidor ya le pasa la
 * analítica calculada por `buildRetentionAnalytics`.
 */

interface RetentionPanelProps {
  analytics: RetentionAnalytics;
  /** Días hacia atrás que cubre el historial (para el texto, no para calcular). */
  windowDays: number;
}

/** Color de la barra según la tasa de recuerdo del tramo. */
function recallColor(rate: number): string {
  if (rate >= 85) return 'bg-emerald-500';
  if (rate >= 70) return 'bg-sky-500';
  if (rate >= 50) return 'bg-amber-500';
  return 'bg-rose-500';
}

export default function RetentionPanel({ analytics, windowDays }: RetentionPanelProps) {
  const activeBuckets = analytics.buckets.filter((bucket) => bucket.reviews > 0);
  const maxActivity = Math.max(1, ...analytics.activity.map((day) => day.reviews));
  const ratedTotal = SRS_RATING_ORDER.reduce((acc, rating) => acc + analytics.byRating[rating], 0);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-emerald-400" />
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">
          Analítica de retención
        </h3>
      </div>

      {/* La lectura honesta del estado, en una frase */}
      <p className="text-xs text-slate-300 leading-relaxed border-l-2 border-emerald-500/40 pl-3">
        {analytics.summary}
      </p>

      {!analytics.hasData ? (
        <div className="p-6 rounded-2xl glass-card flex items-start gap-3">
          <Info className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" />
          <p className="text-xs text-slate-400 leading-relaxed">
            Aún no hay ningún repaso en los últimos {windowDays} días, así que no hay retención real
            que mostrar. No es un gráfico a cero: es que el dato todavía no existe. En cuanto
            registres repasos (con los botones de arriba), aquí aparecerá tu curva de recuerdo por
            tramo de intervalo, tu facilidad media y si sostienes el ritmo.
          </p>
        </div>
      ) : (
        <>
          {/* Resumen numérico */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-2xl glass-card space-y-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                Facilidad media
              </span>
              <p className="text-2xl font-black font-mono text-sky-400">
                {analytics.avgEaseAfter === null ? '—' : analytics.avgEaseAfter.toFixed(2)}
              </p>
              <p className="text-[11px] text-slate-500">
                Bajo 2.2 significa que estas unidades te cuestan retenerlas.
              </p>
            </div>

            <div className="p-4 rounded-2xl glass-card space-y-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                Intervalo medio
              </span>
              <p className="text-2xl font-black font-mono text-violet-400">
                {analytics.avgIntervalDays === null
                  ? '—'
                  : `${analytics.avgIntervalDays.toFixed(1)} d`}
              </p>
              <p className="text-[11px] text-slate-500">
                Cuánto llevabas programado de media en los repasos hechos.
              </p>
            </div>

            <div className="p-4 rounded-2xl glass-card space-y-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                Repasos registrados
              </span>
              <p className="text-2xl font-black font-mono text-emerald-400">
                {analytics.totalReviews}
              </p>
              <p className="text-[11px] text-slate-500">
                {analytics.recalled} recordados · {analytics.totalReviews - analytics.recalled}{' '}
                olvidados.
              </p>
            </div>
          </div>

          {/* Dónde se rompe el recuerdo: la tasa por tramo de intervalo */}
          <div className="p-6 rounded-2xl glass-card space-y-4">
            <div className="flex items-center gap-2">
              <Gauge className="w-4 h-4 text-amber-400" />
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                Tasa de recuerdo por intervalo
              </h4>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Si en un tramo recuerdas poco, ese salto es demasiado largo para ti; el motor lo
              corrige cuando un repaso falla, pero aquí lo ves venir.
            </p>

            <div className="space-y-3">
              {activeBuckets.map((bucket) => (
                <div key={bucket.key} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-semibold text-slate-200">{bucket.label}</span>
                    <span className="font-mono text-slate-400">
                      {bucket.recallRate ?? 0}% · {bucket.recalled}/{bucket.reviews}
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className={clsx('h-full rounded-full transition-all', recallColor(bucket.recallRate ?? 0))}
                      style={{ width: `${bucket.recallRate ?? 0}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {(() => {
              const weak = activeBuckets
                .filter((bucket) => (bucket.recallRate ?? 100) < 70)
                .sort((a, b) => (a.recallRate ?? 0) - (b.recallRate ?? 0))[0];
              if (!weak) return null;
              return (
                <p className="text-[11px] text-amber-400/90 flex items-start gap-1.5">
                  <TrendingDown className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    En «{weak.label}» solo recuerdas el {weak.recallRate}%: ahí es donde se te
                    escapa. Repasos más cortos en ese tramo rentan más que estudiar de nuevo.
                  </span>
                </p>
              );
            })()}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Ritmo: repasos de las últimas dos semanas */}
            <div className="p-6 rounded-2xl glass-card space-y-4">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-violet-400" />
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  Ritmo de repaso (14 días)
                </h4>
              </div>
              <p className="text-[11px] text-slate-500">
                Altura = repasos registrados. La parte verde es lo que recordabas.
              </p>

              <div className="flex items-end gap-1 h-24">
                {analytics.activity.map((day) => (
                  <div
                    key={day.date}
                    title={`${day.label}: ${day.reviews} repasos (${day.recalled} recordados)`}
                    className="flex-1 flex flex-col justify-end gap-0.5 h-full"
                  >
                    {day.reviews > 0 && (
                      <>
                        <div
                          className="w-full rounded-t bg-emerald-500/70"
                          style={{ height: `${(day.recalled / maxActivity) * 100}%` }}
                        />
                        <div
                          className="w-full bg-rose-500/50"
                          style={{
                            height: `${((day.reviews - day.recalled) / maxActivity) * 100}%`,
                          }}
                        />
                      </>
                    )}
                    {day.reviews === 0 && <div className="w-full h-0.5 bg-slate-800 rounded" />}
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[10px] font-mono text-slate-500">
                <span>{analytics.activity[0]?.label}</span>
                <span>{analytics.activity[analytics.activity.length - 1]?.label}</span>
              </div>
            </div>

            {/* Cómo valoras: el reparto dice si el calendario te queda justo */}
            <div className="p-6 rounded-2xl glass-card space-y-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                Cómo has valorado
              </h4>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Mucho «con esfuerzo» y poco «lo tenía» quiere decir que los intervalos van justos.
              </p>

              <div className="space-y-2">
                {SRS_RATING_ORDER.map((rating) => {
                  const meta = SRS_RATINGS[rating];
                  const count = analytics.byRating[rating];
                  const pct = ratedTotal > 0 ? Math.round((count / ratedTotal) * 100) : 0;
                  return (
                    <div key={rating} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="font-semibold text-slate-200">{meta.label}</span>
                        <span className="font-mono text-slate-400">
                          {count} ({pct}%)
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className={clsx(
                            'h-full rounded-full transition-all',
                            rating === 'again'
                              ? 'bg-rose-500'
                              : rating === 'hard'
                                ? 'bg-amber-500'
                                : rating === 'good'
                                  ? 'bg-emerald-500'
                                  : 'bg-cyan-500'
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
