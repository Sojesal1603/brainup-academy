import { RouteSkeleton } from '@/components/ui/Skeletons';

export default function Loading() {
  return <RouteSkeleton label="Cargando el simulacro PAU" panels={2} />;
}
