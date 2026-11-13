'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { isAppReady, subscribeAppReady } from '@/lib/appReady';

/** Tiempo mínimo en pantalla: si todo va rápido, no debe ser un parpadeo. */
const MIN_VISIBLE_MS = 1100;
/** Tope de seguridad: si el perfil no llega, la app no se queda tapada. */
const MAX_VISIBLE_MS = 6000;

/**
 * Pantalla de carga inicial de BrainUp Academy.
 *
 * Se monta en el layout raíz y cubre la app hasta que:
 *   1. la cabecera avisa de que el perfil ya está resuelto (`markAppReady`), y
 *   2. las fuentes han terminado de cargar.
 *
 * Con un mínimo de 1,1 s para que la transición se vea intencionada y un tope
 * de 6 s para que un fallo de base de datos no deje la app inutilizable. La
 * salida es un fundido con un leve zoom, y con `prefers-reduced-motion` se
 * desactivan las animaciones decorativas.
 */
export default function SplashScreen() {
  const [visible, setVisible] = useState(true);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const started = performance.now();
    let cancelled = false;
    let fontsDone = false;
    let appDone = isAppReady();
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    const hide = () => {
      if (cancelled || hideTimer) return;
      const wait = Math.max(0, MIN_VISIBLE_MS - (performance.now() - started));
      hideTimer = setTimeout(() => {
        if (!cancelled) setVisible(false);
      }, wait);
    };

    const check = () => {
      if (appDone && fontsDone) hide();
    };

    // Las fuentes cambian el ancho del texto: mejor esperarlas que enseñar la
    // marca y recolocarla medio segundo después.
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.ready
        .then(() => {
          fontsDone = true;
          check();
        })
        .catch(() => {
          fontsDone = true;
          check();
        });
    } else {
      fontsDone = true;
    }

    const unsubscribe = subscribeAppReady(() => {
      appDone = true;
      check();
    });

    const failsafe = setTimeout(() => {
      if (!cancelled) setVisible(false);
    }, MAX_VISIBLE_MS);

    check();

    return () => {
      cancelled = true;
      unsubscribe();
      clearTimeout(failsafe);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  // Animaciones decorativas: todas se apagan con `prefers-reduced-motion`.
  const float = reduceMotion ? undefined : { y: [0, -10, 0] };
  const halo = reduceMotion ? undefined : { opacity: [0.45, 0.85, 0.45], scale: [0.96, 1.04, 0.96] };
  const baseGlow = reduceMotion
    ? undefined
    : { opacity: [0.25, 0.7, 0.25], scaleX: [0.85, 1.1, 0.85] };
  const bulb = reduceMotion
    ? undefined
    : { opacity: [0.2, 0.65, 1, 0.45, 0.2], scale: [0.85, 1.05, 1.2, 1.02, 0.85] };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="brainup-splash"
          id="brainup-splash"
          role="status"
          aria-live="polite"
          aria-label="Cargando BrainUp Academy"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.5, ease: 'easeInOut' } }}
          className="fixed inset-0 z-[200] flex flex-col items-center justify-center overflow-hidden bg-[#050507]"
        >
          {/* Fondos: dos focos cálidos que dan profundidad sin competir con el logo. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(620px_440px_at_50%_42%,rgba(220,38,38,0.16),transparent_65%),radial-gradient(420px_320px_at_50%_88%,rgba(249,115,22,0.10),transparent_72%)]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.35),transparent_35%,transparent_70%,rgba(0,0,0,0.45))]"
          />

          <div className="relative flex flex-col items-center px-6">
            <motion.div
              className="relative flex h-44 w-44 items-center justify-center"
              animate={float}
              transition={{ duration: 4.6, repeat: Infinity, ease: 'easeInOut' }}
            >
              {/* Halo envolvente. */}
              <motion.span
                aria-hidden="true"
                className="absolute -inset-12 rounded-full bg-[radial-gradient(circle,rgba(239,68,68,0.38),rgba(249,115,22,0.14)_55%,transparent_72%)] blur-2xl"
                animate={halo}
                transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
              />

              {/* Anillos de energía girando en sentidos opuestos. */}
              <motion.span
                aria-hidden="true"
                className="absolute -inset-5 rounded-full border border-b-transparent border-l-transparent border-r-amber-300/40 border-t-orange-400/70"
                animate={
                  reduceMotion ? undefined : { rotate: 360, opacity: [0.4, 0.95, 0.4] }
                }
                transition={{
                  rotate: { duration: 9, repeat: Infinity, ease: 'linear' },
                  opacity: { duration: 3.2, repeat: Infinity, ease: 'easeInOut' },
                }}
              />
              <motion.span
                aria-hidden="true"
                className="absolute -inset-1.5 rounded-full border border-t-transparent border-r-transparent border-b-red-500/60 border-l-orange-400/30"
                animate={reduceMotion ? undefined : { rotate: -360 }}
                transition={{ duration: 6.5, repeat: Infinity, ease: 'linear' }}
              />

              <Image
                src="/logo-brainup.png"
                alt="Logo de BrainUp Academy"
                width={220}
                height={220}
                priority
                unoptimized
                draggable={false}
                className="relative h-44 w-44 select-none rounded-[2rem] object-contain"
              />

              {/* Destello de la bombilla: sube como si acabara de encenderse. */}
              <motion.span
                aria-hidden="true"
                className="absolute -right-1 top-0 h-16 w-16 rounded-full bg-[radial-gradient(circle,rgba(253,224,71,0.9),rgba(249,115,22,0.35)_45%,transparent_72%)] blur-xl"
                animate={bulb}
                transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
              />
            </motion.div>

            {/* Resplandor de la base, latiendo con el halo. */}
            <motion.span
              aria-hidden="true"
              className="mt-2 h-4 w-44 rounded-full bg-orange-500/40 blur-2xl"
              animate={baseGlow}
              transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
            />

            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.5, ease: 'easeOut' }}
              className="mt-8 text-center"
            >
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.35em] text-orange-100/90">
                BrainUp Academy
              </p>
              <p className="mt-2 text-xs text-slate-400">
                Preparando tu centro de operaciones…
              </p>

              {/* Barra indeterminada: no finge un porcentaje que no existe. */}
              <div className="mx-auto mt-5 h-0.5 w-40 overflow-hidden rounded-full bg-white/10">
                <motion.span
                  className="block h-full w-1/3 rounded-full bg-gradient-to-r from-red-500 via-orange-400 to-amber-300"
                  animate={reduceMotion ? { x: '34%' } : { x: ['-110%', '330%'] }}
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { duration: 1.5, repeat: Infinity, ease: 'easeInOut' }
                  }
                />
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
