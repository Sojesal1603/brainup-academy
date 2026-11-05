import { RouteSkeleton } from '@/components/ui/Skeletons';

export default function Loading() {
  return <RouteSkeleton label="Cargando NotebookLM Studio" panels={3} />;
}
