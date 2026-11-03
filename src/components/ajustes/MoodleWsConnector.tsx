'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  CloudDownload,
  FolderOpen,
  HelpCircle,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Plug,
  RefreshCw,
  Search,
  TriangleAlert,
  Unplug,
  User,
} from 'lucide-react';
import clsx from 'clsx';
import type { MoodlePublicStatus } from '@/lib/moodleWsSync';
import type { MoodleHealth } from '@/lib/moodleSelfHeal';
import { MOODLE_CENTROS_INSTANCES, type MoodleDiagnosis } from '@/lib/moodleWs';

interface MoodleWsConnectorProps {
  status: MoodlePublicStatus;
  lastSyncIso: string | null;
  /**
   * Lo que ha visto el vigilante al comprobar la clave (si ha caducado) y si los
   * datos se han quedado viejos. Sin esto, la app enseñaba cursos de hace dos
   * semanas como si fueran de hoy y no decía nada.
   */
  health: MoodleHealth;
}

interface SyncStats {
  siteName: string;
  courses: number;
  materials: number;
  tasks: number;
  submitted: number;
  linkedSubjects: number;
  adoptedFromCalendar: number;
  perCourse: Array<{ name: string; materials: number; tasks: number }>;
}

export default function MoodleWsConnector({ status, lastSyncIso, health }: MoodleWsConnectorProps) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState(status.baseUrl ?? '');
  // La vía fácil por defecto: usuario y contraseña, y la clave la pide la app.
  const [mode, setMode] = useState<'password' | 'token'>('password');
  const [username, setUsername] = useState(status.username ?? '');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  // Por defecto, sí: es lo que permite entrar solo cada mañana. Se guarda cifrada
  // con la clave de este equipo, y el alumno puede decir que no.
  const [savePassword, setSavePassword] = useState(true);
  const [phase, setPhase] = useState<'idle' | 'diagnosing' | 'connecting' | 'syncing' | 'disconnecting'>('idle');
  const [error, setError] = useState('');
  const [okMessage, setOkMessage] = useState('');
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [diagnosis, setDiagnosis] = useState<MoodleDiagnosis | null>(null);

  const busy = phase !== 'idle';

  /** Comprueba la dirección SIN token: dice qué le falta antes de pedir la clave. */
  const handleDiagnose = async () => {
    if (busy) return;
    setPhase('diagnosing');
    setError('');
    setOkMessage('');
    setDiagnosis(null);

    try {
      const res = await fetch('/api/moodle/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: baseUrl.trim() }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; diagnosis?: MoodleDiagnosis; error?: string }
        | null;

      if (!res.ok || !data?.ok || !data.diagnosis) {
        throw new Error(data?.error || 'No se ha podido comprobar esa dirección.');
      }
      setDiagnosis(data.diagnosis);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error inesperado.');
    } finally {
      setPhase('idle');
    }
  };

  const handleConnect = async () => {
    if (busy) return;
    setPhase('connecting');
    setError('');
    setOkMessage('');
    setStats(null);

    const byPassword = mode === 'password';

    try {
      const res = await fetch('/api/moodle/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          byPassword
            ? { baseUrl: baseUrl.trim(), username: username.trim(), password, savePassword }
            : { baseUrl: baseUrl.trim(), token: token.trim() }
        ),
      });
      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            via?: 'token' | 'sesion';
            tokenTrouble?: string | null;
            site?: { siteName: string; userName: string; functionCount: number | null };
            error?: string;
          }
        | null;

      if (!res.ok || !data?.ok) throw new Error(data?.error || 'No se ha podido conectar con Moodle.');

      if (data.via === 'sesion') {
        setOkMessage(
          `Conectado a ${data.site?.siteName ?? 'tu Moodle'}${
            data.site?.userName ? ` como ${data.site.userName}` : ''
          } entrando con tu usuario y contraseña, igual que el navegador. Tu centro no deja pedir la clave de Web Services, así que la app entra por la puerta de siempre.`
        );
      } else {
        setOkMessage(
          `Conectado a ${data.site?.siteName ?? 'tu Moodle'}${
            data.site?.userName ? ` como ${data.site.userName}` : ''
          } con tu clave de seguridad. ${data.site?.functionCount ?? 0} funciones disponibles.`
        );
      }
      setToken('');
      // Con la conexión hecha, se traen apuntes y tareas de una vez.
      setPhase('syncing');
      await runSync();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error inesperado.');
      setPhase('idle');
    } finally {
      // La contraseña se ha usado ya (o el intento ha terminado): no se queda
      // en el formulario ni en memoria. Si te equivocaste, la vuelves a escribir.
      if (byPassword) setPassword('');
    }
  };

  const runSync = async () => {
    setPhase('syncing');
    setError('');
    try {
      const res = await fetch('/api/moodle/ws-sync', { method: 'POST' });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; stats?: SyncStats; error?: string } | null;
      if (!res.ok || !data?.ok || !data.stats) throw new Error(data?.error || 'La sincronización ha fallado.');

      setStats(data.stats);
      setOkMessage(
        `${data.stats.materials} apuntes indexados y ${data.stats.tasks} tareas leídas de ${data.stats.courses} cursos.`
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error inesperado.');
    } finally {
      setPhase('idle');
    }
  };

  const handleDisconnect = async () => {
    if (busy) return;
    setPhase('disconnecting');
    setError('');
    setOkMessage('');
    try {
      const res = await fetch('/api/moodle/connect', { method: 'DELETE' });
      if (!res.ok) throw new Error('No se ha podido desconectar.');
      setToken('');
      setStats(null);
      setOkMessage('Moodle desconectado. Tu token se ha borrado del sistema.');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error inesperado.');
    } finally {
      setPhase('idle');
    }
  };

  const connectedAt = status.connectedAt
    ? new Date(status.connectedAt).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;
  const lastSync = lastSyncIso
    ? new Date(lastSyncIso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="space-y-5">
      {/* Estado de la conexión */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
        <span
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1',
            status.connected
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-slate-700 bg-slate-800/60 text-slate-400'
          )}
        >
          <span
            className={clsx(
              'inline-block h-2 w-2 rounded-full',
              status.connected ? 'bg-emerald-400' : 'bg-slate-500'
            )}
          />
          {status.connected
            ? `${status.siteName ?? 'Moodle'} conectado · ${
                status.authMode === 'sesion' ? 'por sesión (usuario y contraseña)' : 'con clave de seguridad'
              }`
            : 'Sin conectar'}
        </span>
        {status.connected && (
          <>
            <span className="text-slate-500">{status.courses} cursos</span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-500">{status.materials} apuntes</span>
            <span className="text-slate-500">·</span>
            <span className="text-slate-500">{status.pendingTasks} tareas pendientes</span>
          </>
        )}
        {connectedAt && <span className="text-slate-600">· conectado el {connectedAt}</span>}
        {lastSync && <span className="text-slate-600">· última sincronización {lastSync}</span>}
      </div>

      {/* Lo que ha visto el vigilante al comprobar la clave */}
      {status.connected && health.tokenState === 'caducado' && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/5 p-3">
          <TriangleAlert className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="space-y-0.5">
            <p className="text-[11px] font-bold text-rose-300">
              Tu clave de Moodle ha dejado de valer
            </p>
            <p className="text-[11px] text-slate-400 leading-relaxed">{health.detail}</p>
          </div>
        </div>
      )}

      {status.connected && health.tokenState !== 'caducado' && health.stale && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <TriangleAlert className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-0.5">
            <p className="text-[11px] font-bold text-amber-300">Los datos de Moodle están viejos</p>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {health.detail} El vigilante la sincroniza solo en su próxima pasada; si tienes prisa,
              usa «Sincronizar ahora».
            </p>
          </div>
        </div>
      )}

      {status.connected && status.authMode === 'sesion' && !status.passwordSaved && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <TriangleAlert className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="space-y-0.5">
            <p className="text-[11px] font-bold text-amber-300">Tu contraseña no está guardada</p>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Estás conectado por sesión, pero sin contraseña guardada la app no puede volver a entrar sola: cuando
              Moodle cierre la sesión, te la pedirá otra vez. Vuelve a conectarlo con la casilla «Guardar mi
              contraseña» marcada y entra sola cada día.
            </p>
          </div>
        </div>
      )}

      {status.connected && health.tokenState === 'sin_comprobar' && (
        <p className="text-[11px] text-slate-500 leading-relaxed">
          La clave está guardada y todavía no se ha comprobado contra Moodle. Se hace solo en la
          próxima ronda del vigilante (o al sincronizar ahora mismo).
        </p>
      )}

      {/* Cómo quieres conectar: la vía fácil es usuario y contraseña */}
      <div className="flex flex-wrap gap-1.5 rounded-xl border border-slate-800 bg-[#080d18] p-1">
        <button
          onClick={() => {
            setMode('password');
            setError('');
            setOkMessage('');
            setDiagnosis(null);
          }}
          className={clsx(
            'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[11px] font-semibold transition-all',
            mode === 'password'
              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
              : 'text-slate-400 hover:text-slate-200 border border-transparent'
          )}
        >
          <User className="h-3.5 w-3.5" />
          <span>Usuario y contraseña</span>
          <span className="hidden rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300 sm:inline">
            SIN CLAVE
          </span>
        </button>

        <button
          onClick={() => {
            setMode('token');
            setError('');
            setOkMessage('');
            setDiagnosis(null);
          }}
          className={clsx(
            'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[11px] font-semibold transition-all',
            mode === 'token'
              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
              : 'text-slate-400 hover:text-slate-200 border border-transparent'
          )}
        >
          <KeyRound className="h-3.5 w-3.5" />
          <span>Clave de seguridad (token)</span>
        </button>
      </div>

      {/* Formulario */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Dirección de tu Moodle
          </label>
          <div className="relative">
            <Link2 className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://moodle.tuinstituto.es"
              className="w-full rounded-xl border border-slate-800 bg-[#080d18] py-2.5 pl-9 pr-3 font-mono text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
            />
          </div>
        </div>

        {mode === 'token' ? (
          <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Token de Web Services
            </label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={status.tokenSaved ? '•••••••• (guardado)' : 'pega aquí tu token'}
                autoComplete="off"
                className="w-full rounded-xl border border-slate-800 bg-[#080d18] py-2.5 pl-9 pr-3 font-mono text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Tu usuario de Moodle
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="el usuario con el que entras"
                  autoComplete="off"
                  className="w-full rounded-xl border border-slate-800 bg-[#080d18] py-2.5 pl-9 pr-3 font-mono text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Tu contraseña
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="tu contraseña de Moodle"
                  autoComplete="off"
                  className="w-full rounded-xl border border-slate-800 bg-[#080d18] py-2.5 pl-9 pr-3 font-mono text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-slate-800 bg-[#080d18] p-3 sm:col-span-2">
              <input
                type="checkbox"
                checked={savePassword}
                onChange={(event) => setSavePassword(event.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-500"
              />
              <span className="text-[11px] leading-relaxed text-slate-400">
                <strong className="text-slate-300">Guardar mi contraseña en este ordenador</strong> (cifrada) para que
                la app pueda volver a entrar sola cada día y traer tus apuntes y tareas sin pedírtela. Si lo dejas sin
                marcar, se usa una vez ahora y mañana te la pedirá otra vez.
              </span>
            </label>
          </div>
        )}

        {mode === 'password' && (
          <p className="text-[11px] leading-relaxed text-slate-500">
            Lo primero que hace la app con tu usuario y contraseña es{' '}
            <strong className="text-slate-400">pedirle a Moodle la clave de tu cuenta</strong>, que es la vía limpia
            (con clave no hace falta guardar tu contraseña). Si tu centro no deja usar esa clave —los servicios web
            apagados o las claves prohibidas al alumnado—, entra <strong className="text-slate-400">por la sesión
            web</strong>, igual que el navegador, y solo entonces guarda la contraseña, cifrada con la clave de este
            equipo. En ningún caso sale de tu ordenador ni se manda a otro sitio que no sea tu Moodle. Con
            «Desconectar» se borra.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleDiagnose}
          disabled={busy || baseUrl.trim().length === 0}
          className="flex items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-xs font-semibold text-blue-300 transition-all hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {phase === 'diagnosing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span>Comprobar mi Moodle</span>
        </button>

        <button
          onClick={handleConnect}
          disabled={
            busy ||
            baseUrl.trim().length === 0 ||
            (mode === 'password'
              ? username.trim().length === 0 || password.length === 0
              : token.trim().length === 0)
          }
          className="flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 transition-all hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {phase === 'connecting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          <span>{mode === 'password' ? 'Conectar con mi usuario' : 'Conectar y traer apuntes'}</span>
        </button>

        <button
          onClick={runSync}
          disabled={busy || !status.connected}
          className="flex items-center gap-2 rounded-xl border border-slate-700 bg-[#111827] px-4 py-2.5 text-xs font-semibold text-slate-200 transition-all hover:border-emerald-500/40 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {phase === 'syncing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span>Sincronizar ahora</span>
        </button>

        <Link
          href="/apuntes"
          className="flex items-center gap-2 rounded-xl border border-slate-700 bg-[#111827] px-4 py-2.5 text-xs font-semibold text-slate-200 transition-all hover:border-emerald-500/40 hover:text-emerald-300"
        >
          <FolderOpen className="h-4 w-4" />
          <span>Ver apuntes</span>
        </Link>

        {status.connected && (
          <button
            onClick={handleDisconnect}
            disabled={busy}
            className="ml-auto flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs font-semibold text-rose-300 transition-all hover:bg-rose-500/20 disabled:opacity-40"
          >
            <Unplug className="h-4 w-4" />
            <span>Desconectar</span>
          </button>
        )}
      </div>

      {/* Diagnóstico sin token */}
      {diagnosis && (
        <div
          className={clsx(
            'space-y-1.5 rounded-xl border px-3.5 py-3 text-xs leading-relaxed',
            diagnosis.code === 'ready'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : diagnosis.code === 'unreachable'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          )}
        >
          <p className="flex items-start gap-2 font-semibold">
            {diagnosis.code === 'ready' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>{diagnosis.message}</span>
          </p>
          <p className="pl-6">
            <strong className="font-semibold">Qué hacer ahora: </strong>
            {diagnosis.nextStep}
          </p>
          <p className="pl-6 font-mono text-[10px] opacity-70">
            {diagnosis.endpoint}
            {diagnosis.httpStatus ? ` · HTTP ${diagnosis.httpStatus}` : ''}
            {diagnosis.moodleError ? ` · ${diagnosis.moodleError}` : ''}
          </p>
        </div>
      )}

      {/* Ayuda de Moodle Centros: ocho plataformas, una por provincia */}
      <details className="rounded-xl border border-slate-800 bg-[#080d18] p-3.5">
        <summary className="flex cursor-pointer items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          <HelpCircle className="h-3.5 w-3.5 text-blue-400" />
          ¿Usas Moodle Centros (Andalucía)? Empieza por aquí
        </summary>
        <div className="space-y-3 pt-3.5 text-[11px] leading-relaxed text-slate-400">
          <p>
            Moodle Centros <strong className="text-slate-300">no es una sola plataforma</strong>: son ocho,
            una por provincia. La dirección tiene que ser la de la tuya. Toca la tuya para rellenarla:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {MOODLE_CENTROS_INSTANCES.map((instance) => (
              <button
                key={instance.province}
                onClick={() => {
                  setBaseUrl(instance.url);
                  setDiagnosis(null);
                  setError('');
                }}
                className="rounded-lg border border-slate-700 bg-[#111827] px-2.5 py-1 text-[11px] font-semibold text-slate-300 transition-all hover:border-blue-500/40 hover:text-blue-300"
              >
                {instance.label}
              </button>
            ))}
          </div>
          <p>
            Después, con tu dirección puesta, pulsa <strong className="text-slate-300">Comprobar mi
            Moodle</strong>: te dirá si los servicios web están encendidos. En Moodle Centros lo están, así que lo
            único que suele faltar es la clave:
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Dentro de tu Moodle: tu nombre (arriba a la derecha) →{' '}
              <strong className="text-slate-300">Preferencias → Seguridad → Claves de seguridad</strong>.
            </li>
            <li>
              Crea una clave para el servicio <strong className="text-slate-300">Servicios web móviles</strong> y
              cópiala.
            </li>
            <li>Pégala arriba, junto a la dirección de tu provincia, y pulsa «Conectar y traer apuntes».</li>
          </ol>
          <p>
            Si no ves esa opción en Preferencias, es que el alumnado no tiene permiso para crear claves en tu
            centro: pídesela a un profesor o al coordinador TIC (pueden generarla por ti) o usa la alternativa del
            calendario iCal que tienes abajo.
          </p>
          <p>
            Pero antes de pedirle nada a nadie, prueba lo fácil: cambia arriba a{' '}
            <strong className="text-slate-300">Usuario y contraseña</strong> y pon tu usuario y tu contraseña de
            Moodle Centros. La app le pide la clave a Moodle por ti y tu contraseña no se guarda.
          </p>
        </div>
      </details>

      {/* Cómo se entra, en corto */}
      <p className="text-[11px] leading-relaxed text-slate-500">
        <strong className="text-slate-400">Con tu usuario y contraseña</strong> (lo normal): la app intenta primero
        pedirle la clave a Moodle por ti (la misma vía que la app oficial del móvil) y, si tu centro no se lo
        permite, entra por la sesión web como el navegador. Funciona en cualquier Moodle que tenga formulario de
        acceso. <strong className="text-slate-400">Con clave de seguridad</strong> (si tu centro te deja crear
        una): tu perfil →{' '}
        <strong className="text-slate-400">Preferencias → Seguridad → Claves de seguridad</strong>, servicio
        «Servicios web móviles», y la pegas aquí. La clave queda guardada en tu base de datos y nunca se
        manda al navegador ni sale en los enlaces.
      </p>

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-rose-200">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <span>{error}</span>
        </div>
      )}

      {okMessage && (
        <div className="flex items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          <span>{okMessage}</span>
        </div>
      )}

      {stats && stats.perCourse.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-slate-800 bg-[#080d18] p-3.5">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <CloudDownload className="h-3.5 w-3.5 text-blue-400" />
            Lo que ha entrado ahora
          </p>
          <ul className="space-y-1 text-[11px] text-slate-400">
            {stats.perCourse.map((course) => (
              <li key={course.name} className="flex items-center justify-between gap-3">
                <span className="truncate text-slate-300">{course.name}</span>
                <span className="shrink-0 font-mono">
                  {course.materials} bloques · {course.tasks} tareas
                </span>
              </li>
            ))}
          </ul>
          <p className="pt-1 font-mono text-[10px] text-slate-500">
            {stats.linkedSubjects} cursos emparejados con tu temario
            {stats.adoptedFromCalendar > 0
              ? ` · ${stats.adoptedFromCalendar} tareas del calendario adoptadas (sin duplicar)`
              : ''}
          </p>
        </div>
      )}
    </div>
  );
}
