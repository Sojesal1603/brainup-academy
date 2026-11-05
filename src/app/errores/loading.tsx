import { RouteSkeleton } from '@/components/ui/Skeletons';

export default function Loading() {
  return <RouteSkeleton label="Preparando el banco de errores" cards={3} panels={2} />;
}
