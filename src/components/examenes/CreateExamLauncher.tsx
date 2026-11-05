'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ModalSkeleton } from '@/components/ui/Skeletons';

/**
 * Botón que carga el formulario de examen **solo al pulsarlo**.
 *
 * El formulario importa las acciones del servidor y pesa más que toda la
 * página; quien entra a mirar la lista de exámenes no necesita descargarlo.
 * Aquí solo viaja el botón (un icono y una etiqueta) y el modal baja en el
 * momento del clic, con su esqueleto mientras llega.
 */
const CreateExamModal = dynamic(() => import('./CreateExamModal'), {
  ssr: false,
  loading: () => <ModalSkeleton label="Abriendo el formulario de examen" />,
});

export default function CreateExamLauncher({
  subjects,
}: {
  subjects: Array<{ id: string; name: string }>;
}) {
  const [opened, setOpened] = useState(false);

  if (!opened) {
    return (
      <button
        type="button"
        onClick={() => setOpened(true)}
        className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-all shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:scale-105"
      >
        <Plus className="w-4 h-4 stroke-[3]" />
        <span>Añadir Examen o Simulacro</span>
      </button>
    );
  }

  return <CreateExamModal subjects={subjects} initialOpen />;
}
