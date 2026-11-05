import { RouteSkeleton } from '@/components/ui/Skeletons';

export default function Loading() {
  return <RouteSkeleton label="Calculando el planificador" cards={3} panels={3} />;
}
