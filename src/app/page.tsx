import { Suspense } from 'react';
import SetupCard from '@/components/dashboard/SetupCard';
import { MetricCardsSkeleton, PanelSkeleton } from '@/components/ui/Skeletons';
import {
  DashboardFocus,
  DashboardIntro,
  DashboardMetrics,
  DashboardMode,
  DashboardRadar,
  DashboardToday,
} from '@/components/cuartel/DashboardWidgets';

/**
 * Cuartel General.
 *
 * La página es síncrona: devuelve el esqueleto completo (cabecera, métricas,
 * columnas) sin esperar a Prisma. Cada widget es un Server Component aparte
 * dentro de su propio Suspense, así que Next puede enviar el HTML y completar
 * las secciones por streaming. La Sidebar y el Header del layout ya no esperan
 * a la base para aparecer.
 */
export const dynamic = 'force-dynamic';

export default function DashboardPage() {
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
          <Suspense fallback={<p className="mt-1 text-xs text-slate-500">Cargando tu objetivo…</p>}>
            <DashboardIntro />
          </Suspense>
        </div>

        {/* Selector de modo y recálculo */}
        <Suspense
          fallback={
            <div
              aria-hidden="true"
              className="h-10 w-full max-w-xs animate-pulse rounded-xl bg-white/[0.06]"
            />
          }
        >
          <DashboardMode />
        </Suspense>
      </div>

      {/* Puesta a punto: qué falta por montar y acceso directo a la entrevista. */}
      <Suspense fallback={<PanelSkeleton lines={1} />}>
        <SetupCard />
      </Suspense>

      {/* Tarjetas de Métricas Rápidas */}
      <Suspense fallback={<MetricCardsSkeleton />}>
        <DashboardMetrics />
      </Suspense>

      {/* Focus & Lock */}
      <Suspense
        fallback={<div className="glass-card h-44 animate-pulse rounded-2xl bg-white/[0.03]" />}
      >
        <DashboardFocus />
      </Suspense>

      {/* Grid Principal: en tablet apaisada, dos columnas; en escritorio ancho,
          bloques de hoy (2 cols) + radar lateral (1 col). */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3 xl:gap-8">
        <div className="min-w-0 md:col-span-1 xl:col-span-2">
          <Suspense fallback={<PanelSkeleton lines={3} />}>
            <DashboardToday />
          </Suspense>
        </div>

        <DashboardRadar />
      </div>
    </div>
  );
}
