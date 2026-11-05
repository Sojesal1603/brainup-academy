import Link from 'next/link';
import { Flame, Target, Zap, Play, LogOut } from 'lucide-react';
import { ensureUserProfile } from '@/lib/userProfile';
import { readAuthConfig } from '@/lib/authGate';
import PwaRegister from './PwaRegister';

/**
 * El perfil que pinta la cabecera, sin poder tumbar la app.
 *
 * Este componente vive en el layout raíz: se monta en TODAS las rutas. Si su
 * consulta lanza (Supabase inaccesible, `DATABASE_URL` sin definir, tablas sin
 * migrar, motor de Prisma que no carga), no falla una vista: falla el layout, y
 * React devuelve el error #441 en cada página, con la pantalla de «algo se ha
 * roto al arrancar» y ningún detalle en producción.
 *
 * La cabecera es decorativa: con los valores por defecto se ve bien y el resto de
 * la app puede seguir funcionando. El fallo se apunta en la consola del servidor
 * (que es donde se puede leer) y nunca se propaga al render.
 */
async function loadProfile() {
  try {
    if (!process.env.DATABASE_URL?.trim()) {
      console.warn('[header] DATABASE_URL no está definida: cabecera con valores por defecto.');
      return null;
    }
    // La cabecera se pinta en TODAS las páginas: es el sitio natural para
    // asegurar que el perfil existe aunque la base se acabe de migrar y nadie
    // haya lanzado el seed. Sin esto, la primera acción que guardara ajustes
    // fallaba con «Record to update not found».
    return await ensureUserProfile();
  } catch (error) {
    console.error(
      '[header] no se ha podido leer el perfil:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

export default async function Header() {
  const user = await loadProfile();

  const streak = user?.streakCurrent ?? 0;
  const targetGrade = user?.targetGradePau ?? 13.5;
  const mode = user?.studyMode ?? 'athlete';
  // El botón de cerrar sesión solo tiene sentido si la puerta está puesta.
  const authOn = Boolean(readAuthConfig());

  return (
    <header className="sticky top-0 z-40 bg-[#0a0a0c]/90 backdrop-blur-md border-b border-white/10 px-4 py-3.5 sm:px-6 flex items-center justify-between gap-2">
      {/* Perfil & Modalidad */}
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-emerald-600 to-teal-400 p-[1px] flex items-center justify-center">
          <div className="w-full h-full bg-[#0a0a0c] rounded-full flex items-center justify-center text-xs font-bold text-emerald-300">
            {user?.name?.[0] ?? 'A'}
          </div>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            {user?.name ?? 'Estudiante'}
            <span className="hidden text-[10px] px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-mono sm:inline">
              {user?.modality?.includes('1º') ? '1º Bachillerato' : 'Bachillerato'}
            </span>
          </h2>
          <p className="text-[11px] text-slate-400 hidden sm:block">
            {user?.modality ?? 'Ciencias y Tecnología'}
          </p>
        </div>
      </div>

      {/* Indicadores Tácticos de Rendimiento */}
      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        {/* Racha */}
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-semibold">
          <Flame className="w-4 h-4 fill-amber-400 animate-pulse text-amber-500" />
          <span>{streak} días</span>
        </div>

        {/* Nota Objetivo PAU */}
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-mono">
          <Target className="w-4 h-4 text-blue-400" />
          <span>PAU: {targetGrade.toFixed(2)}/14</span>
        </div>

        {/* Modo de Estudio */}
        <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 text-xs">
          <Zap className="w-3.5 h-3.5 text-purple-400" />
          <span>{mode === 'athlete' ? 'Modo Atleta' : 'Zona de Confort'}</span>
        </div>

        {/* Botón PWA Instalar App */}
        <PwaRegister />

        {/* Botón de Enfoque Rápido */}
        <Link
          href="/enfoque"
          aria-label="Iniciar Enfoque"
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:scale-105 active:scale-95 sm:px-3.5"
        >
          <Play className="w-3.5 h-3.5 fill-slate-950" />
          <span className="hidden sm:inline">Iniciar Enfoque</span>
        </Link>

        {/* Cerrar sesión: la puerta se abre una vez por dispositivo. */}
        {authOn ? (
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
              className="flex items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] p-2 text-slate-400 transition-colors hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-300"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </form>
        ) : null}
      </div>
    </header>
  );
}
