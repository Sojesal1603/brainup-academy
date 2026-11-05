import { RouteSkeleton } from '@/components/ui/Skeletons';

export default function Loading() {
  return <RouteSkeleton label="Cargando los ajustes" panels={3} />;
}
