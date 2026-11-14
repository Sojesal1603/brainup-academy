'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { deleteMyAiKey, recheckMyAiKey, saveMyAiKey } from '@/app/ajustes/aiKeyActions';
import {
  AI_KEY_STATUS_LABEL,
  type AiKeyActionResult,
  type AiKeySummaryView,
  type UserAiKeyStatus,
} from '@/lib/ai/keyStatus';

const STATUS_STYLE: Record<UserAiKeyStatus, string> = {
  valida: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  invalida: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  sin_cuota: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  sin_comprobar: 'border-slate-600/40 bg-slate-700/20 text-slate-300',
};

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export default function AiKeyCard({
  initialSummary,
  vaultReady,
  vaultError,
  isPlatformUser,
}: {
  initialSummary: AiKeySummaryView | null;
  vaultReady: boolean;
  vaultError: string | null;
  isPlatformUser: boolean;
}) {
  const router = useRouter();
  const [summary, setSummary] = useState<AiKeySummaryView | null>(initialSummary);
  const [value, setValue] = useState('');
  const [result, setResult] = useState<AiKeyActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [checking, startCheck] = useTransition();

  const status = summary?.status ?? 'sin_comprobar';
  const statusLabel = summary ? AI_KEY_STATUS_LABEL[status] : 'Sin clave';
  const checkedAt = formatDate(summary?.lastCheckedAt ?? null);
  const busy = pending || deleting || checking;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setResult(null);
    startTransition(async () => {
      const next = await saveMyAiKey(formData);
      setResult(next);
      if (next.ok) {
        setValue('');
        if (next.status && next.last4) {
          setSummary({
            provider: 'gemini',
            status: next.status,
            last4: next.last4,
            lastCheckedAt: new Date().toISOString(),
            lastError: next.status === 'valida' ? null : next.message,
          });
        }
        router.refresh();
      }
    });
  };

  const remove = () => {
    if (!window.confirm('¿Borrar tu clave de IA guardada? Las pantallas de IA volverán a pedirla.')) {
      return;
    }
    setResult(null);
    startDelete(async () => {
      const next = await deleteMyAiKey();
      setResult(next);
      if (next.ok) {
        setSummary(null);
        setValue('');
        router.refresh();
      }
    });
  };

  const recheck = () => {
    setResult(null);
    startCheck(async () => {
      const next = await recheckMyAiKey();
      setResult(next);
      if (next.ok && next.status) {
        setSummary((current) =>
          current
            ? {
                ...current,
                status: next.status!,
                lastCheckedAt: new Date().toISOString(),
                lastError: next.status === 'valida' ? null : next.message,
              }
            : current
        );
        router.refresh();
      }
    });
  };

  return (
    <div className="glass-card space-y-4 rounded-2xl p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/15 text-emerald-300">
            <KeyRound className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100">Mi clave de IA</h3>
            <p className="mt-0.5 max-w-2xl text-xs text-slate-400">
              Se guarda cifrada y solo se usa en tus peticiones. La clave de plataforma no se gasta
              por otras cuentas: si no tienes la tuya, las pantallas de IA te la pedirán.
            </p>
          </div>
        </div>

        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLE[status]}`}
        >
          {status === 'valida' ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : status === 'invalida' || status === 'sin_cuota' ? (
            <AlertTriangle className="h-3 w-3" />
          ) : (
            <ShieldCheck className="h-3 w-3" />
          )}
          {statusLabel}
        </span>
      </div>

      <p className="rounded-xl border border-slate-700/70 bg-white/[0.02] px-3 py-2 text-[11px] leading-relaxed text-slate-400">
        Google exige ser mayor de 18 años para crear claves de API de Gemini.
      </p>

      {!vaultReady ? (
        <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
          {vaultError ??
            'El servidor no tiene la clave de cifrado (SECRETS_KEY_V1), así que ahora mismo no se puede guardar ni leer ninguna clave.'}
        </p>
      ) : null}

      {summary ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-800 bg-[#080d18] px-3 py-2 text-[11px] text-slate-400">
          <span className="font-mono text-slate-200">•••• {summary.last4}</span>
          <span>Google Gemini</span>
          {checkedAt ? <span>Comprobada: {checkedAt}</span> : <span>Sin comprobar todavía</span>}
          <button
            type="button"
            onClick={recheck}
            disabled={busy || !vaultReady}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2 py-1 font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:text-slate-100 disabled:opacity-50"
          >
            {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Comprobar
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 px-2 py-1 font-semibold text-rose-300 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
          >
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            Borrar
          </button>
        </div>
      ) : (
        <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          Ahora mismo no tienes clave propia. Pega una clave gratuita de Google AI Studio para usar
          los catedráticos, la puesta a punto y el examinador.
        </p>
      )}

      {summary?.lastError && summary.status !== 'valida' ? (
        <p className="text-[11px] text-slate-400">{summary.lastError}</p>
      ) : null}

      <form onSubmit={submit} className="space-y-2">
        <input type="hidden" name="provider" value="gemini" />
        <label htmlFor="ai-key" className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Clave de Google Gemini
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="ai-key"
            name="key"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="AIza… (se guarda cifrada)"
            className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-[#080d18] px-3 py-2 font-mono text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-500/60"
            disabled={!vaultReady || busy}
          />
          <button
            type="submit"
            disabled={!vaultReady || busy || value.trim().length < 20}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Guardar y comprobar
          </button>
        </div>
        <p className="text-[10px] text-slate-500">
          Se comprueba contra Google con la cabecera <span className="font-mono">x-goog-api-key</span>.
          Nunca se muestra entera: solo los últimos cuatro caracteres.
        </p>
      </form>

      {result ? (
        <p
          role="status"
          className={`rounded-xl border px-3 py-2 text-[11px] ${
            result.ok
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          }`}
        >
          {result.message}
        </p>
      ) : null}

      {isPlatformUser ? (
        <p className="text-[10px] text-slate-500">
          Esta cuenta está en la lista de plataforma: si borras tu clave propia, seguirá usando la
          clave de plataforma. El resto de cuentas no tiene ese respaldo.
        </p>
      ) : null}
    </div>
  );
}
