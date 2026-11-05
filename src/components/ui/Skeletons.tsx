import clsx from 'clsx';

/**
 * Esqueletos de carga.
 *
 * Son componentes de servidor puros: no llevan estado ni efectos, así que no
 * añaden JavaScript al móvil. Se usan en dos sitios:
 *
 * - el `loading.tsx` de cada sección, que Next pinta al instante mientras el
 *   servidor consulta la base (antes se veía la pantalla anterior congelada);
 * - el `loading` de los `next/dynamic`, para que un módulo pesado (el chat, el
 *   cuaderno, el tablero del temario) no deje un hueco en blanco mientras baja
 *   su código.
 *
 * Regla: el esqueleto imita la forma real de la vista (cabecera, tarjetas,
 * paneles) para que al llegar el contenido no salte nada de sitio.
 */

/** Barra gris con la animación de pulso. */
export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={clsx('block animate-pulse rounded-lg bg-white/[0.06]', className)}
    />
  );
}

/** Cabecera de sección: icono, título y una línea de descripción. */
export function HeaderSkeleton() {
  return (
    <div className="space-y-3 border-b border-white/10 pb-4">
      <div className="flex items-center gap-2">
        <SkeletonBlock className="h-6 w-6 rounded-lg" />
        <SkeletonBlock className="h-6 w-64 max-w-[60%]" />
      </div>
      <SkeletonBlock className="h-3 w-full max-w-2xl" />
      <SkeletonBlock className="h-3 w-2/3 max-w-xl" />
    </div>
  );
}

/** Tarjetas de métricas (la fila de cuatro del Cuartel, por ejemplo). */
export function MetricCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="glass-card space-y-3 rounded-2xl p-4">
          <SkeletonBlock className="h-3 w-24" />
          <SkeletonBlock className="h-7 w-16" />
          <SkeletonBlock className="h-1.5 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Panel con título y varias filas: listas, tablas ligeras, tarjetas. */
export function PanelSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={clsx('glass-card space-y-3 rounded-2xl p-4', className)}>
      <SkeletonBlock className="h-3 w-40" />
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} className="space-y-1.5 rounded-xl border border-slate-800/60 p-3">
          <SkeletonBlock className="h-3 w-1/2" />
          <SkeletonBlock className="h-2.5 w-3/4" />
        </div>
      ))}
    </div>
  );
}

/** Sala de chat: burbujas alternas y una barra de escritura. */
export function ChatSkeleton({ className }: { className?: string }) {
  return (
    <div className={clsx('glass-card space-y-4 rounded-2xl p-4', className)}>
      <div className="flex items-center gap-3">
        <SkeletonBlock className="h-10 w-10 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <SkeletonBlock className="h-3 w-40" />
          <SkeletonBlock className="h-2.5 w-24" />
        </div>
      </div>
      <div className="space-y-3 pt-2">
        <SkeletonBlock className="h-16 w-4/5 rounded-2xl" />
        <SkeletonBlock className="ml-auto h-12 w-3/5 rounded-2xl" />
        <SkeletonBlock className="h-20 w-11/12 rounded-2xl" />
        <SkeletonBlock className="ml-auto h-10 w-1/2 rounded-2xl" />
      </div>
      <SkeletonBlock className="h-11 w-full rounded-xl" />
    </div>
  );
}

/** Editor / cuaderno: barra lateral de secciones y hoja en blanco. */
export function EditorSkeleton({ className }: { className?: string }) {
  return (
    <div className={clsx('glass-card grid gap-4 rounded-2xl p-4 md:grid-cols-[220px_1fr]', className)}>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <SkeletonBlock key={index} className="h-8 w-full" />
        ))}
      </div>
      <div className="space-y-3 rounded-xl border border-slate-800/60 p-4">
        <SkeletonBlock className="h-6 w-2/3" />
        <SkeletonBlock className="h-3 w-full" />
        <SkeletonBlock className="h-3 w-11/12" />
        <SkeletonBlock className="h-3 w-4/5" />
        <SkeletonBlock className="h-24 w-full" />
      </div>
    </div>
  );
}

/** Tablero de unidades: filas agrupadas por asignatura. */
export function BoardSkeleton({ className }: { className?: string }) {
  return (
    <div className={clsx('space-y-4', className)}>
      {Array.from({ length: 3 }).map((_, section) => (
        <div key={section} className="glass-card space-y-2 rounded-2xl p-4">
          <SkeletonBlock className="h-4 w-48" />
          {Array.from({ length: 3 }).map((_, row) => (
            <div key={row} className="flex items-center gap-3 rounded-xl border border-slate-800/60 p-3">
              <SkeletonBlock className="h-6 w-6 rounded-md" />
              <SkeletonBlock className="h-3 flex-1" />
              <SkeletonBlock className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Modal de formulario que aún no ha llegado. */
export function ModalSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <div className="glass-card flex w-full max-w-lg items-center gap-3 rounded-2xl p-6">
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-emerald-400/30 border-t-emerald-400"
        />
        <p className="text-xs text-slate-300">{label}…</p>
      </div>
    </div>
  );
}

/**
 * Esqueleto de página completa, para los `loading.tsx` de cada sección.
 *
 * `variant` cambia la forma del cuerpo para que se parezca a lo que va a llegar:
 * una lista de paneles, una parrilla de tarjetas, un chat o un tablero.
 */
export function RouteSkeleton({
  label,
  variant = 'panels',
  cards = 0,
  panels = 2,
}: {
  label: string;
  variant?: 'panels' | 'grid' | 'chat' | 'board' | 'editor';
  cards?: number;
  panels?: number;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-6">
      <span className="sr-only">{label}</span>
      <HeaderSkeleton />
      {cards > 0 && <MetricCardsSkeleton count={cards} />}

      {variant === 'chat' && <ChatSkeleton />}
      {variant === 'editor' && <EditorSkeleton />}
      {variant === 'board' && <BoardSkeleton />}
      {variant === 'grid' && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <PanelSkeleton key={index} lines={2} />
          ))}
        </div>
      )}
      {variant === 'panels' && (
        <div className="space-y-4">
          {Array.from({ length: panels }).map((_, index) => (
            <PanelSkeleton key={index} />
          ))}
        </div>
      )}
    </div>
  );
}
