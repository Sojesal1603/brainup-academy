import { RouteSkeleton } from '@/components/ui/Skeletons';

/**
 * Fallback de navegación del Cuartel.
 *
 * No es una pantalla centrada de «Cargando la vista»: imita la estructura real
 * (cabecera, cuatro métricas y paneles) para que el layout y la Sidebar se
 * puedan usar mientras llegan los datos. La página `/` ya devuelve su shell al
 * instante; esto cubre las navegaciones a secciones que aún no tienen su propio
 * `loading.tsx`.
 */
export default function Loading() {
  return <RouteSkeleton label="Cargando el Cuartel" variant="grid" cards={4} panels={2} />;
}
