'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ModalSkeleton } from '@/components/ui/Skeletons';

/**
 * Botón que carga el formulario de errores **solo al pulsarlo**.
 *
 * Es el componente más pesado de la página (dos áreas de texto grandes, la
 * rejilla de causas y las acciones del servidor). Nadie que entre a revisar el
 * banco lo necesita hasta que va a registrar un fallo.
 */
const CreateErrorModal = dynamic(() => import('./CreateErrorModal'), {
  ssr: false,
  loading: () => <ModalSkeleton label="Abriendo el registro de errores" />,
});

export default function CreateErrorLauncher({
  subjects,
}: {
  subjects: Array<{
    id: string;
    name: string;
    topics: Array<{ id: string; title: string }>;
  }>;
}) {
  const [opened, setOpened] = useState(false);

  if (!opened) {
    return (
      <button
        type="button"
        onClick={() => setOpened(true)}
        className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 text-slate-950 font-bold text-xs transition-all shadow-[0_0_15px_rgba(244,63,94,0.3)] hover:scale-105"
      >
        <Plus className="w-4 h-4 stroke-[3]" />
        <span>Registrar Error Quirúrgico</span>
      </button>
    );
  }

  return <CreateErrorModal subjects={subjects} initialOpen />;
}
