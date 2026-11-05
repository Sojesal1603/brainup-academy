import { RouteSkeleton } from '@/components/ui/Skeletons';

export default function Loading() {
  return <RouteSkeleton label="Revisando el sistema" cards={4} panels={3} />;
}
