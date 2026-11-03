'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Bug, Loader2, Send } from 'lucide-react';
import { reportSystemIssue } from '@/lib/maintenanceActions';

/**
 * «Esto me ha fallado».
 *
 * Lo que se anota aquí queda guardado con contexto (la ruta desde la que se
 * escribe) para poder ir a por la causa en vez de adivinar. El vigilante lee
 * esas incidencias abiertas en cada pasada.
 */

export default function ReportIssueForm({ pathname }: { pathname?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (isPending) return;
    setMessage('');
    setError('');

    startTransition(async () => {
      const response = await reportSystemIssue({
        title,
        detail,
        source: 'alumno',
        context: {
          ruta: pathname ?? '/mantenimiento',
          cuando: new Date().toISOString(),
        },
      });

      if (!response.success) {
        setError(response.error ?? 'No se ha podido anotar el fallo.');
        return;
      }

      setTitle('');
      setDetail('');
      setMessage('Anotado. Queda en la lista de abajo, sin revisar.');
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="p-5 rounded-2xl glass-card space-y-3"
    >
      <div className="flex items-center gap-2">
        <Bug className="w-4 h-4 text-rose-400" />
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-200">
            He visto un fallo
          </p>
          <p className="text-[11px] text-slate-400">
            Cuéntalo aquí en vez de aguantarlo: queda escrito con la hora y la vista donde estaba.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <input
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Qué pasa, en una línea (p. ej. «Al abrir /repaso sale una pantalla en blanco»)"
          className="w-full bg-[#080d18] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
        />
        <textarea
          rows={3}
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
          placeholder="Qué estabas haciendo, qué esperabas y qué pasó (opcional, pero ayuda muchísimo)"
          className="w-full bg-[#080d18] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending || title.trim().length < 3}
          className="inline-flex items-center gap-2 rounded-lg bg-rose-500 px-3.5 py-2 text-xs font-bold text-slate-950 transition-all hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Anotando…</span>
            </>
          ) : (
            <>
              <Send className="w-3.5 h-3.5" />
              <span>Anotar el fallo</span>
            </>
          )}
        </button>

        <p className="text-[11px] text-slate-500">
          Escribe al menos tres letras para poder anotarlo.
        </p>
      </div>

      {error && <p className="text-[11px] text-rose-400">{error}</p>}
      {message && <p className="text-[11px] text-emerald-300">{message}</p>}
    </form>
  );
}
