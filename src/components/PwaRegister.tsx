'use client';

import { useEffect, useState } from 'react';
import { Download, Monitor, X, RefreshCw } from 'lucide-react';

/**
 * Dónde se apunta la compilación que cargó esta pestaña.
 *
 * En `sessionStorage` porque es de la pestaña, no del navegador: cada pestaña
 * abierta guarda la suya y se compara con la que sirve el servidor ahora.
 */
const BUILD_KEY = 'brainup-build';
/**
 * Marca de «esta pestaña ya se limpió del SW viejo». Evita que la limpieza de
 * desarrollo se convierta en un bucle de recargas.
 */
const DEV_CLEAN_KEY = 'brainup-sw-clean-v5';
/** Cada cuánto se pregunta si la app se ha vuelto a compilar. */
const BUILD_CHECK_MS = 120_000;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type InstallGuide = 'ios' | 'android' | 'desktop';

/**
 * Qué instrucciones enseñar. Los pasos de Windows no sirven en un iPhone y
 * los de Safari no sirven en Android; se decide en el clic, no al renderizar,
 * para que el HTML del servidor y el del cliente coincidan siempre.
 */
function detectInstallGuide(): InstallGuide {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  // iPadOS se presenta como Mac: se distingue por la pantalla táctil.
  const iPadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iPad|iPhone|iPod/.test(ua) || iPadOs) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

export default function PwaRegister() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [guide, setGuide] = useState<InstallGuide | null>(null);
  /** Hay una compilación nueva en el servidor y esta pestaña es de la anterior. */
  const [newBuild, setNewBuild] = useState(false);

  /**
   * Vigila si la app se ha vuelto a compilar mientras la pestaña estaba abierta.
   *
   * No es un capricho: cuando el servidor pasa a servir otra compilación, el HTML
   * y el JavaScript de la pestaña dejan de coincidir con lo que contesta el
   * servidor, y React suelta el aviso de «hydration failed» (la página se
   * regenera y sigue funcionando, pero asusta y no dice qué hacer). Aquí se avisa
   * con un botón claro en vez de eso.
   */
  useEffect(() => {
    let vivo = true;

    const comprobar = async () => {
      try {
        const res = await fetch('/api/salud', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { build?: string | null };
        const build = typeof data?.build === 'string' && data.build.length > 0 ? data.build : null;
        if (!build || !vivo) return;

        const visto = window.sessionStorage.getItem(BUILD_KEY);
        if (!visto) {
          window.sessionStorage.setItem(BUILD_KEY, build);
          return;
        }
        if (visto !== build) setNewBuild(true);
      } catch {
        // Sin red no se sabe nada: se calla y se vuelve a preguntar luego.
      }
    };

    void comprobar();
    const timer = window.setInterval(() => void comprobar(), BUILD_CHECK_MS);
    return () => {
      vivo = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // 1. Service Worker
    //
    // En DESARROLLO no se registra: el SW cacheaba los chunks de Turbopack y,
    // tras una recompilación, servía JavaScript viejo con un HTML nuevo. Eso
    // deja la app en «cargando», rompe la hidratación y no se arregla recargando
    // (la copia mala sigue en caché). Aquí se desregistra y se limpia una vez;
    // si esta pestaña todavía está controlada por el SW viejo, se recarga sola
    // una única vez para soltarlo.
    if ('serviceWorker' in navigator) {
      if (process.env.NODE_ENV !== 'production') {
        void (async () => {
          try {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((reg) => reg.unregister()));

            if ('caches' in window) {
              const keys = await caches.keys();
              await Promise.all(
                keys.filter((key) => key.startsWith('brainup')).map((key) => caches.delete(key))
              );
            }

            if (
              navigator.serviceWorker.controller &&
              !window.sessionStorage.getItem(DEV_CLEAN_KEY)
            ) {
              window.sessionStorage.setItem(DEV_CLEAN_KEY, '1');
              window.location.reload();
            }
          } catch {
            // Sin service workers o sin Cache API: no hay nada que limpiar.
          }
        })();
      } else {
        // En producción sí: es lo que permite abrir la app instalada sin red.
        const hadController = Boolean(navigator.serviceWorker.controller);
        navigator.serviceWorker
          .register('/sw.js')
          .then((reg) => {
            console.log('SW registrado:', reg.scope);
            // Se busca actualización al abrir, para no arrastrar una versión vieja.
            reg.update().catch(() => {});
          })
          .catch((err) => console.log('SW error:', err));

        let recargando = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          // En la primera instalación no hay nada que recargar. Solo se recarga
          // cuando un SW nuevo sustituye al que ya controlaba la página.
          if (recargando || !hadController) return;
          recargando = true;
          console.log('SW actualizado: se recarga para servir el código nuevo.');
          window.location.reload();
        });
      }
    }

    // 2. Comprobar si ya está instalada o en modo standalone
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setIsInstalled(true);
    }

    // 3. Capturar evento de instalación
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);

  // La guía se cierra con Escape, como cualquier diálogo.
  useEffect(() => {
    if (!guide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGuide(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [guide]);

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setIsInstalled(true);
      }
      setDeferredPrompt(null);
    } else {
      // Si el navegador no disparó el evento (común en Edge/Chrome cuando se abre en localhost),
      // mostramos la guía de 2 clics para instalarla al instante.
      setGuide(detectInstallGuide());
    }
  };

  /** Aviso de compilación nueva: se pinta aunque la app esté «instalada». */
  const avisoVersion = newBuild ? (
    <div className="fixed bottom-4 left-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 rounded-2xl border border-emerald-500/40 bg-[#0e1628] px-4 py-3 shadow-2xl shadow-black/40">
      <div className="flex items-start gap-3">
        <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs leading-relaxed text-slate-200">
            <strong className="text-emerald-300">La app se ha actualizado.</strong> Esta pestaña es de
            la versión anterior, así que algunas cosas pueden ir raras hasta que la recargues.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-emerald-500 px-2.5 py-1.5 text-[10px] font-bold text-slate-950 transition-colors hover:bg-emerald-400"
            >
              Recargar ahora
            </button>
            <button
              onClick={() => {
                window.sessionStorage.setItem(BUILD_KEY, '');
                setNewBuild(false);
              }}
              className="rounded-lg px-2 py-1.5 text-[10px] font-semibold text-slate-400 transition-colors hover:text-slate-200"
            >
              Más tarde
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  if (isInstalled) return avisoVersion;

  return (
    <>
      {avisoVersion}
      <button
        onClick={handleInstallClick}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-semibold transition-all hover:scale-105"
        title="Instalar BrainUp Academy"
      >
        <Monitor className="w-3.5 h-3.5 text-emerald-400" />
        <span className="hidden sm:inline">Instalar App</span>
      </button>

      {/* Modal Guía si el navegador no dispara el prompt nativo */}
      {guide && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Instalar BrainUp Academy"
            className="bg-[#0e1628] border border-white/10 rounded-3xl w-full max-w-md max-h-[85vh] overflow-y-auto p-6 shadow-2xl relative space-y-4"
          >
            <button
              onClick={() => setGuide(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-100"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Download className="w-6 h-6" />
            </div>

            <div className="space-y-1">
              <h3 className="text-base font-bold text-slate-100">
                {guide === 'ios'
                  ? 'Instalar en iPhone o iPad'
                  : guide === 'android'
                    ? 'Instalar en Android'
                    : 'Instalar BrainUp Academy en Windows'}
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                {guide === 'desktop'
                  ? 'Puedes instalar la web como un programa nativo de Windows en 2 clics desde tu navegador:'
                  : 'Se instala desde el navegador, sin pasar por ninguna tienda de aplicaciones:'}
              </p>
            </div>

            <div className="space-y-3 text-xs bg-[#0a0a0c] p-4 rounded-2xl border border-slate-800 text-slate-300">
              {(guide === 'ios'
                ? [
                    <>Abre esta página en <strong>Safari</strong>.</>,
                    <>Toca el botón <strong>Compartir</strong> (el cuadrado con la flecha hacia arriba).</>,
                    <>Elige <strong>«Añadir a pantalla de inicio»</strong> y confirma con <strong>Añadir</strong>.</>,
                  ]
                : guide === 'android'
                  ? [
                      <>Abre esta página en <strong>Chrome</strong>.</>,
                      <>Toca el menú de tres puntos (<strong>⋮</strong>), arriba a la derecha.</>,
                      <>Elige <strong>«Instalar aplicación»</strong> o <strong>«Añadir a pantalla de inicio»</strong>.</>,
                    ]
                  : [
                      <>En <strong>Edge</strong> o <strong>Chrome</strong>, mira arriba a la derecha en la barra de direcciones o en el menú de tres puntos (<strong>···</strong>).</>,
                      <>Haz clic en <strong>&quot;Aplicaciones&quot;</strong> y luego en <strong className="text-emerald-400">&quot;Instalar BrainUp Academy&quot;</strong>.</>,
                      <>¡Listo! Se abrirá como una ventana limpia e independiente y podrás anclarla a tu barra de tareas.</>,
                    ]
              ).map((step, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px] shrink-0">
                    {i + 1}
                  </span>
                  <p>{step}</p>
                </div>
              ))}
            </div>

            {guide !== 'desktop' && (
              <p className="text-[10px] leading-relaxed text-slate-500">
                Si el navegador no ofrece «Instalar», es porque la app se está abriendo por
                <code className="mx-1 rounded bg-slate-800 px-1">http://</code>
                y la instalación completa necesita HTTPS.
              </p>
            )}

            <button
              onClick={() => setGuide(null)}
              className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-all shadow-md"
            >
              Entendido
            </button>
          </div>
        </div>
      )}
    </>
  );
}
