import { AlertTriangle } from 'lucide-react';

/**
 * Aviso de «base de datos lenta».
 *
 * Se pinta cuando un widget del Cuartel ha recibido el respaldo de `safeDb`
 * porque la consulta no llegó a tiempo (P1008, P2024…) y no porque de verdad no
 * hubiera datos. Es la diferencia entre «no tienes exámenes» —mentira— y «no
 * hemos podido leerlos ahora mismo» —verdad—.
 *
 * Es un Server Component puro: no hay JavaScript extra en el móvil y no necesita
 * estado. Además, el diseño va por encima del `Suspense` de cada sección, así que
 * el resto del Cuartel ya está navegable mientras esto se pinta.
 */
export default function DbDegradedNotice({
  compact = false,
  className = '',
}: {
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return (
      <p
        role="status"
        className={`flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300/90 ${className}`}
      >
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span>La base de datos no ha respondido a tiempo: faltan datos en esta sección.</span>
      </p>
    );
  }

  return (
    <div
      role="status"
      className={`glass-card rounded-2xl border border-amber-500/25 p-4 ${className}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div>
          <p className="text-xs font-semibold text-amber-200">Base de datos lenta</p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            Supabase no ha contestado dentro del margen, así que hemos cargado esta sección con
            datos de respaldo para no bloquear el Cuartel. Lo que ves puede estar incompleto: en
            unos segundos se actualiza sola al recargar.
          </p>
        </div>
      </div>
    </div>
  );
}
