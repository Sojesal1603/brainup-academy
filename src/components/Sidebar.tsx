'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  CalendarDays,
  CalendarClock,
  BookOpenCheck,
  ClipboardList,
  GraduationCap,
  Timer,
  AlertOctagon,
  Sparkles,
  FileCheck2,
  BarChart3,
  Settings,
  BookOpen,
  Repeat,
  Target,
  Wrench,
  Layers,
  MoreHorizontal,
  X,
} from 'lucide-react';
import clsx from 'clsx';

type NavGroup = 'Hoy' | 'Estudio' | 'Inteligencia' | 'Sistema';

const navItems: Array<{
  name: string;
  href: string;
  icon: typeof LayoutDashboard;
  highlight?: boolean;
  mobile?: boolean;
  group: NavGroup;
}> = [
  { name: 'Cuartel', href: '/', icon: LayoutDashboard, mobile: true, group: 'Hoy' },
  { name: 'Planificador', href: '/planificador', icon: CalendarDays, mobile: true, group: 'Hoy' },
  { name: 'Horario', href: '/horario', icon: CalendarClock, mobile: true, group: 'Hoy' },
  { name: 'Puesta a punto', href: '/puesta-a-punto', icon: ClipboardList, group: 'Hoy' },

  { name: 'Temario', href: '/temario', icon: BookOpenCheck, group: 'Estudio' },
  { name: 'Repaso Espaciado', href: '/repaso', icon: Repeat, group: 'Estudio' },
  { name: 'Cuaderno Notion', href: '/apuntes', icon: BookOpen, group: 'Estudio' },
  { name: 'Exámenes', href: '/examenes', icon: GraduationCap, mobile: true, group: 'Estudio' },
  { name: 'Banco de Errores', href: '/errores', icon: AlertOctagon, group: 'Estudio' },
  { name: 'Modo Enfoque', href: '/enfoque', icon: Timer, highlight: true, group: 'Estudio' },
  { name: 'Retos Semanales', href: '/retos', icon: Target, group: 'Estudio' },

  { name: 'Catedráticos IA', href: '/brainup', icon: Sparkles, group: 'Inteligencia' },
  { name: 'NotebookLM Studio', href: '/notebooklm', icon: Layers, highlight: true, group: 'Inteligencia' },
  { name: 'Examinador PAU', href: '/examinador', icon: FileCheck2, group: 'Inteligencia' },

  { name: 'Estadísticas', href: '/estadisticas', icon: BarChart3, group: 'Sistema' },
  { name: 'Taller de Mantenimiento', href: '/mantenimiento', icon: Wrench, group: 'Sistema' },
  { name: 'Ajustes', href: '/ajustes', icon: Settings, group: 'Sistema' },
];

/** El orden en que se pintan los bloques del menú. */
const GROUP_ORDER: NavGroup[] = ['Hoy', 'Estudio', 'Inteligencia', 'Sistema'];

export default function Sidebar() {
  const pathname = usePathname();
  /** El cajón «Más» del móvil: aquí viven las secciones que no caben abajo. */
  const [open, setOpen] = useState(false);

  /** Marca la sección activa también en sus subpáginas (/brainup/lengua…). */
  const isCurrent = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

  // Al cambiar de página el cajón se cierra solo.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Si la pantalla pasa a escritorio con el cajón abierto (girar una tablet,
  // por ejemplo), se cierra: si no, el bloqueo del fondo se quedaría puesto
  // y la página de escritorio no se podría desplazar.
  useEffect(() => {
    if (!open) return;
    const escritorio = window.matchMedia('(min-width: 768px)');
    const alCambiar = () => {
      if (escritorio.matches) setOpen(false);
    };
    escritorio.addEventListener('change', alCambiar);
    return () => escritorio.removeEventListener('change', alCambiar);
  }, [open]);

  // Con el cajón abierto: Escape lo cierra y el fondo no se desplaza.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const previo = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previo;
    };
  }, [open]);

  return (
    <>
      {/* Barra lateral de escritorio: cristal translúcido sobre el fondo espacial. */}
      <aside className="sticky top-0 hidden h-dvh w-20 shrink-0 flex-col justify-between border-r border-white/[0.08] bg-[#0a0a0c]/70 p-3 backdrop-blur-xl md:flex xl:w-64 xl:p-4">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Marca: logo destacado con aura de luz detrás (azul → púrpura → verde). */}
          <Link
            href="/"
            aria-label="BrainUp Academy — ir al Cuartel"
            className="group relative mb-6 flex items-center justify-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-2 py-3 transition-colors duration-300 hover:border-white/15 xl:justify-start xl:px-2.5"
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-1 top-1/2 h-14 w-14 -translate-y-1/2 rounded-full bg-gradient-to-br from-blue-500/50 via-violet-500/40 to-emerald-400/40 blur-xl transition-opacity duration-300 group-hover:opacity-100"
            />
            <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-xl border border-white/15 bg-white/[0.04] shadow-[0_0_22px_rgba(139,92,246,0.35)]"
              />
              {/* Sin optimizador: el PNG se sirve directo y, al cambiar el logo,
                  no se queda una miniatura vieja cacheada durante horas. */}
              <Image
                src="/logo-brainup.png"
                alt="Logo de BrainUp Academy: un cerebro rojo guiñando un ojo, con bombilla y gráfica"
                width={40}
                height={40}
                priority
                unoptimized
                className="relative h-9 w-9 rounded-lg transition-transform duration-300 group-hover:scale-105"
              />
            </span>
            <div className="hidden min-w-0 xl:block">
              <h1 className="text-sm font-bold uppercase tracking-wider text-slate-100 drop-shadow-[0_0_10px_rgba(255,255,255,0.15)]">
                BrainUp Academy
              </h1>
              <p className="font-mono text-[11px] tracking-tight text-emerald-400">
                Bachillerato &amp; PAU
              </p>
            </div>
          </Link>

          {/* Menú por bloques: primero lo de hoy, al final la trastienda. */}
          <nav className="space-y-4" aria-label="Secciones">
            {GROUP_ORDER.map((group) => (
              <div
                key={group}
                className={clsx(
                  'space-y-1',
                  group !== 'Hoy' && 'md:border-t md:border-white/[0.06] md:pt-3 xl:border-0 xl:pt-0'
                )}
              >
                <p className="hidden px-3 pb-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500 xl:block">
                  {group}
                </p>
                {navItems
                  .filter((item) => item.group === group)
                  .map((item) => {
                    const Icon = item.icon;
                    const isActive = isCurrent(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={isActive ? 'page' : undefined}
                        title={item.name}
                        aria-label={item.name}
                        className={clsx(
                          'group relative flex items-center justify-center gap-3 rounded-lg border px-2 py-2.5 text-xs font-medium transition-all duration-200 hover:translate-x-0.5 xl:justify-start xl:px-3',
                          isActive
                            ? 'border-emerald-400/30 bg-gradient-to-r from-emerald-500/15 via-emerald-500/5 to-transparent text-emerald-200 shadow-[0_0_18px_rgba(16,185,129,0.16)]'
                            : 'border-transparent text-slate-400 hover:border-white/10 hover:bg-white/[0.035] hover:text-slate-200',
                          item.highlight && !isActive && 'text-emerald-400/90 font-semibold'
                        )}
                      >
                        {isActive && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-emerald-400 shadow-[0_0_10px_2px_rgba(16,185,129,0.7)]"
                          />
                        )}
                        <Icon
                          className={clsx(
                            'h-4 w-4 transition-transform duration-200 group-hover:scale-110',
                            isActive
                              ? 'text-emerald-300 drop-shadow-[0_0_8px_rgba(52,211,153,0.9)]'
                              : 'text-slate-500 group-hover:text-slate-300',
                            item.highlight && !isActive && 'text-emerald-400'
                          )}
                        />
                        <span className="hidden xl:inline">{item.name}</span>
                        {item.highlight && (
                          <span className="ml-auto hidden rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300 xl:inline-flex">
                            LIVE
                          </span>
                        )}
                      </Link>
                    );
                  })}
              </div>
            ))}
          </nav>
        </div>

        {/* Estado del sistema, en la misma tarjeta de cristal que el resto. */}
        <div className="glass-card hidden p-3 text-[11px] text-slate-400 xl:block">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-mono text-[9px] font-semibold uppercase tracking-widest text-slate-500">
              Sistema Local
            </span>
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
          </div>
          <p className="font-medium text-slate-300">PostgreSQL Cloud</p>
          <p className="mt-0.5 text-[10px] text-slate-500">Datos persistidos 24/7</p>
        </div>

        {/* En el rail compacto, el estado se queda en un punto con tooltip. */}
        <div
          className="mt-2 hidden items-center justify-center py-2 md:flex xl:hidden"
          title="Sistema local conectado · PostgreSQL Cloud"
        >
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
          </span>
        </div>
      </aside>

      {/* Barra inferior del móvil: cuatro destinos diarios y «Más» */}
      <nav
        aria-label="Navegación principal"
        className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-white/10 bg-[#0a0a0c]/85 px-2 pt-2 backdrop-blur-xl md:hidden"
        style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
      >
        {navItems
          .filter((item) => item.mobile)
          .map((item) => {
            const Icon = item.icon;
            const isActive = isCurrent(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={clsx(
                  'flex flex-1 flex-col items-center gap-1 rounded-lg p-2 text-[10px] transition-colors',
                  isActive ? 'font-semibold text-emerald-400' : 'text-slate-400'
                )}
              >
                <Icon
                  className={clsx(
                    'h-5 w-5',
                    isActive && 'drop-shadow-[0_0_8px_rgba(52,211,153,0.85)]'
                  )}
                />
                <span>{item.name}</span>
              </Link>
            );
          })}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="menu-mas"
          className={clsx(
            'flex flex-1 flex-col items-center gap-1 rounded-lg p-2 text-[10px]',
            open || navItems.some((i) => !i.mobile && isCurrent(i.href))
              ? 'font-semibold text-emerald-400'
              : 'text-slate-400'
          )}
        >
          <MoreHorizontal className="h-5 w-5" />
          <span>Más</span>
        </button>
      </nav>

      {/* Cajón «Más»: todo lo que no cabe en la barra, a un toque. */}
      {open && (
        <div className="fixed inset-0 z-[60] md:hidden">
          <button
            type="button"
            aria-label="Cerrar el menú"
            onClick={() => setOpen(false)}
            className="absolute inset-0 w-full bg-black/60 backdrop-blur-sm"
          />
          <div
            id="menu-mas"
            role="dialog"
            aria-modal="true"
            aria-label="Todas las secciones"
            className="absolute inset-x-0 bottom-0 max-h-[78vh] overflow-y-auto overscroll-contain rounded-t-3xl border-t border-white/10 bg-[#0a0a0c]/95 px-4 pt-3 shadow-2xl backdrop-blur-xl"
            style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-700" aria-hidden="true" />
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                Todas las secciones
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar el menú"
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {GROUP_ORDER.map((group) => {
              const items = navItems.filter((item) => !item.mobile && item.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className="mb-3">
                  <p className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-slate-500">
                    {group}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {items.map((item) => {
                      const Icon = item.icon;
                      const isActive = isCurrent(item.href);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          aria-current={isActive ? 'page' : undefined}
                          className={clsx(
                            'flex items-center gap-2.5 rounded-xl border px-3 py-3 text-xs font-medium transition-colors',
                            isActive
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                              : 'border-white/10 bg-white/[0.03] text-slate-300 active:bg-white/[0.06]'
                          )}
                        >
                          <Icon
                            className={clsx(
                              'h-4 w-4 shrink-0',
                              isActive
                                ? 'text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.85)]'
                                : 'text-slate-500'
                            )}
                          />
                          <span className="leading-tight">{item.name}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
