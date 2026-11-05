import { RouteSkeleton } from '@/components/ui/Skeletons';

export default function Loading() {
  return <RouteSkeleton label="Cargando el temario" variant="board" cards={4} />;
}
