'use client';

import { useRouter } from 'next/navigation';
import { SUBJECT_MODES, SUBJECT_MODE_META } from '@/lib/subjects/modes';

/**
 * Atajo de entrada al catedrático con un modo de trabajo ya elegido.
 *
 * El hub es un componente de servidor; este selector solo navega a la misma
 * consulta con `?mode=`, que el chat lee al montar. No guarda nada.
 */
export default function ModeShortcuts({ href }: { href: string }) {
  const router = useRouter();

  return (
    <select
      value=""
      onChange={(event) => {
        const mode = event.target.value;
        if (!mode) return;
        router.push(`${href}?mode=${mode}`);
      }}
      title="Empezar la consulta en un modo de trabajo concreto"
      className="w-full cursor-pointer rounded-lg border border-white/10 bg-[#0c0c0e] px-2 py-1.5 text-[10px] font-semibold text-stone-400 outline-none transition-colors hover:border-white/25 hover:text-stone-200 focus:border-emerald-500/50"
    >
      <option value="">Empezar en un modo…</option>
      {SUBJECT_MODES.map((mode) => (
        <option key={mode} value={mode}>
          {SUBJECT_MODE_META[mode].label} — {SUBJECT_MODE_META[mode].description}
        </option>
      ))}
    </select>
  );
}
