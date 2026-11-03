'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';

/**
 * Componente «Neural Loader».
 *
 * Se enseña **mientras la IA trabaja de verdad** (redactar apuntes, responder el
 * catedrático, generar un simulacro, recalcular el plan): un cerebro vectorial
 * con pulsos radiantes en neón púrpura/azul, mensajes tácticos que rotan cada
 * 2,5 s y una barra de progreso con brillo fluido.
 *
 * No promete un porcentaje que no conoce: la barra es indeterminada (barrido),
 * porque fingir un 63 % de progreso sería exactamente el tipo de dato inventado
 * que la app no se permite. Los mensajes describen lo que el sistema hace, no lo
 * que le gustaría estar haciendo.
 *
 * Respeta `prefers-reduced-motion`: con movimiento reducido, el cerebro y los
 * mensajes se quedan quietos (siguen rotando el texto, pero sin animaciones).
 */

export const NEURAL_MESSAGES = [
  'Cruzando apuntes con el temario oficial...',
  'Analizando el historial de errores del alumno...',
  'Sintetizando estructura socrática...',
  'Optimizando planificación inversa...',
  'Comprobando que todo sale de tus fuentes...',
];

interface NeuralLoaderProps {
  title?: string;
  messages?: string[];
  /** Versión pequeña, para huecos de botón o tarjetas. */
  compact?: boolean;
  className?: string;
}

export default function NeuralLoader({
  title = 'La IA está trabajando',
  messages = NEURAL_MESSAGES,
  compact = false,
  className,
}: NeuralLoaderProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (messages.length <= 1) return;
    const intervalid = setInterval(() => {
      setIndex((current) => (current + 1) % messages.length);
    }, 2500);
    return () => clearInterval(intervalid);
  }, [messages.length]);

  const message = messages[index] ?? messages[0] ?? '';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={clsx(
        'card-glass relative overflow-hidden rounded-2xl text-center shadow-[0_0_35px_rgba(139,92,246,0.12)]',
        compact ? 'p-4' : 'p-8',
        className
      )}
    >
      {/* Aura de neón: dos pulsos que se expanden y se desvanecen */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-500/20 blur-2xl motion-safe:animate-pulse"
      />

      <div className={clsx('relative flex flex-col items-center gap-2', compact && 'gap-1.5')}>
        <span
          className={clsx(
            'relative flex items-center justify-center',
            compact ? 'h-14 w-14' : 'h-24 w-24'
          )}
        >
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full border border-violet-400/30 motion-safe:animate-ping [animation-duration:2.6s]"
          />
          <span
            aria-hidden="true"
            className="absolute inset-2 rounded-full border border-sky-400/20 motion-safe:animate-ping [animation-duration:3.4s] [animation-delay:0.6s]"
          />
          <NeuralBrain className={compact ? 'h-10 w-10' : 'h-16 w-16'} />
        </span>

        <p
          className={clsx(
            'font-mono uppercase tracking-widest text-violet-300',
            compact ? 'text-[10px]' : 'text-xs'
          )}
        >
          {title}
        </p>

        <p
          key={message}
          className={clsx(
            'fade-up max-w-md text-slate-300',
            compact ? 'text-[11px] leading-snug' : 'text-sm'
          )}
        >
          {message}
        </p>
      </div>

      {/* Barra indeterminada: barrido, no un porcentaje inventado */}
      <div
        className={clsx('relative w-full overflow-hidden rounded-full bg-white/5', compact ? 'mt-3 h-1' : 'mt-5 h-1.5')}
        aria-hidden="true"
      >
        <div className="shimmer h-full w-1/3 rounded-full bg-gradient-to-r from-sky-500 via-violet-500 to-emerald-400" />
      </div>
    </div>
  );
}

/** Cerebro vectorial con su red neuronal: sin dependencias ni imágenes. */
function NeuralBrain({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 96 96"
      className={clsx('relative drop-shadow-[0_0_12px_rgba(139,92,246,0.55)]', className)}
      aria-hidden="true"
      fill="none"
    >
      <defs>
        <linearGradient id="neural-brain-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#60a5fa" />
          <stop offset="50%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#34d399" />
        </linearGradient>
      </defs>

      <g
        stroke="url(#neural-brain-gradient)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Hemisferios */}
        <path d="M48 18c-6-6-18-6-23 2-8 1-13 8-11 15-5 5-4 14 2 18-1 8 6 14 14 13 4 5 13 6 18 1" />
        <path d="M48 18c6-6 18-6 23 2 8 1 13 8 11 15 5 5 4 14-2 18 1 8-6 14-14 13-4 5-13 6-18 1" />
        {/* Surcos y conexiones */}
        <path d="M48 18v60" strokeDasharray="3 5" strokeOpacity="0.7" />
        <path d="M34 30c-4 4-4 10 0 14M62 30c4 4 4 10 0 14M32 56c-3 4-2 9 2 12M64 56c3 4 2 9-2 12" />
        <path d="M28 24 48 40 68 24M28 70 48 56 68 70" strokeOpacity="0.35" strokeWidth="1.2" />
      </g>

      {/* Nodos sinápticos */}
      <g fill="#c4b5fd">
        <circle cx="48" cy="18" r="2.6" className="motion-safe:animate-pulse" />
        <circle cx="34" cy="44" r="2.2" />
        <circle cx="62" cy="44" r="2.2" />
        <circle cx="48" cy="78" r="2.6" className="motion-safe:animate-pulse" />
        <circle cx="28" cy="24" r="1.7" fill="#67e8f9" />
        <circle cx="68" cy="24" r="1.7" fill="#67e8f9" />
        <circle cx="28" cy="70" r="1.7" fill="#6ee7b7" />
        <circle cx="68" cy="70" r="1.7" fill="#6ee7b7" />
      </g>
    </svg>
  );
}
