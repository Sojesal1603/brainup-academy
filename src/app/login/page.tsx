import Image from 'next/image';
import { ArrowRight, Lock, ShieldAlert } from 'lucide-react';
import { hasSupabaseAuthConfig } from '@/lib/supabaseConfig';
import { safeNextPath } from '@/lib/requestUrl';

/**
 * La puerta de entrada.
 *
 * Se pinta como una capa fija a pantalla completa y por encima del resto
 * (`z-[120]`): así no hace falta tocar el layout raíz ni enseñar la barra
 * lateral, la cabecera o el menú del móvil detrás de un formulario que todavía
 * no ha dejado entrar a nadie.
 *
 * No hay registro público: las cuentas se crean desde Supabase y el alta
 * anónima está deshabilitada en el proyecto. Esta pantalla solo inicia sesión.
 */

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Acceso privado | BrainUp Academy',
  robots: { index: false, follow: false },
};

const MENSAJES: Record<string, string> = {
  '1': 'Email o contraseña incorrectos.',
  limite: 'Demasiados intentos seguidos. Espera unos minutos y vuelve a probar.',
  config:
    'Falta la configuración de Supabase Auth en el servidor. Define NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY.',
  sesion: 'Tu sesión ha caducado. Vuelve a entrar.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const configurado = hasSupabaseAuthConfig();
  const destino = safeNextPath(next);
  const aviso = error ? MENSAJES[error] ?? MENSAJES['1'] : null;

  return (
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-[#0a0a0c]">
      {/* El mismo fondo del Cuartel, para que la puerta no parezca otro sitio. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_500px_at_50%_-10%,rgba(16,185,129,0.16),transparent_60%),radial-gradient(700px_400px_at_85%_110%,rgba(139,92,246,0.14),transparent_65%)]"
      />

      <div className="relative flex min-h-full items-center justify-center p-5">
        <div className="w-full max-w-sm space-y-5 rounded-3xl glass-card p-6 shadow-2xl">
          <div className="flex items-center gap-3">
            {/* Sin optimizador: así un logo nuevo no queda oculto por la
                miniatura cacheada de `/_next/image`. */}
            <Image
              src="/logo-brainup.png"
              alt="Logo de BrainUp Academy"
              width={40}
              height={40}
              priority
              unoptimized
              className="h-10 w-10 rounded-xl"
            />
            <div className="min-w-0">
              <p className="text-sm font-bold uppercase tracking-wider text-slate-100">
                BrainUp Academy
              </p>
              <p className="font-mono text-[11px] text-emerald-400">Bachillerato &amp; PAU</p>
            </div>
          </div>

          <div className="space-y-1">
            <h1 className="flex items-center gap-2 font-mono text-sm font-bold uppercase tracking-wider text-slate-100">
              <Lock className="h-4 w-4 text-emerald-400" />
              <span>Acceso privado</span>
            </h1>
            <p className="text-xs leading-relaxed text-slate-400">
              Entra con la cuenta que te ha creado el centro. No hay registro público: cada alumno
              ve solo sus datos.
            </p>
          </div>

          {!configurado ? (
            <div
              role="alert"
              className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-200"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Faltan <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> y{' '}
                <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> en el entorno del
                servidor. Sin ellas no se puede iniciar sesión.
              </span>
            </div>
          ) : (
            <form action="/api/auth/login" method="post" className="space-y-3">
              {/* A dónde volver después de entrar (solo rutas de esta app). */}
              <input type="hidden" name="next" value={destino} />

              <div className="space-y-1">
                <label
                  htmlFor="email"
                  className="text-[10px] font-semibold uppercase tracking-wider text-slate-400"
                >
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  className="w-full rounded-xl border border-white/10 bg-[#080d18] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-400/60 focus:outline-none focus:ring-1 focus:ring-emerald-400/40"
                  placeholder="tu@email.com"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="password"
                  className="text-[10px] font-semibold uppercase tracking-wider text-slate-400"
                >
                  Contraseña
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  className="w-full rounded-xl border border-white/10 bg-[#080d18] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-400/60 focus:outline-none focus:ring-1 focus:ring-emerald-400/40"
                  placeholder="••••••••"
                />
              </div>

              {aviso ? (
                <p
                  role="alert"
                  className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200"
                >
                  {aviso}
                </p>
              ) : null}

              <button
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-xs font-bold text-slate-950 transition-all hover:bg-emerald-400 active:scale-[0.99]"
              >
                <span>Entrar</span>
                <ArrowRight className="h-4 w-4 stroke-[3]" />
              </button>
            </form>
          )}

          <p className="text-[10px] leading-relaxed text-slate-500">
            La contraseña se envía directamente a Supabase Auth. BrainUp no la guarda ni la
            registra.
          </p>
        </div>
      </div>
    </div>
  );
}
