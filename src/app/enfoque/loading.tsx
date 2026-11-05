import { RouteSkeleton } from '@/components/ui/Skeletons';

export default function Loading() {
  return <RouteSkeleton label="Preparando la sala de enfoque" panels={2} />;
}
