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
import {
  deleteMyAiKey,
  recheckMyAiKey,
  saveMyAiKey,
  saveMyProviderOrder,
} from '@/app/ajustes/aiKeyActions';
import {
  AI_KEY_STATUS_LABEL,
  type AiKeyActionResult,
  type AiKeySummaryView,
  type UserAiKeyStatus,
} from '@/lib/ai/keyStatus';
import {
  USER_KEY_PROVIDERS,
  USER_KEY_PROVIDER_HINT,
  USER_KEY_PROVIDER_LABEL,
  USER_KEY_PROVIDER_SIGNUP,
  providerKeyFormatError,
  type UserKeyProvider,
} from '@/lib/ai/keyFormat';

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
  initialSummaries,
  initialOrder,
  vaultReady,
  vaultError,
  isPlatformUser,
}: {
  initialSummaries: AiKeySummaryView[];
  initialOrder: string[];
  vaultReady: boolean;
  vaultError: string | null;
  isPlatformUser: boolean;
}) {
  const router = useRouter();
  const [summaries, setSummaries] = useState<Record<string, AiKeySummaryView>>(() =>
    Object.fromEntries(initialSummaries.map((summary) => [summary.provider, summary]))
  );
  const [provider, setProvider] = useState<UserKeyProvider>('gemini');
  const [value, setValue] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [order, setOrder] = useState<string[]>(() => {
    const seen = new Set(initialOrder);
    return [...initialOrder, ...USER_KEY_PROVIDERS.filter((id) => !seen.has(id))];
  });
  const [orderPending, startOrder] = useTransition();
  const [result, setResult] = useState<AiKeyActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [checking, startCheck] = useTransition();

  const summary = summaries[provider] ?? null;
  const status = summary?.status ?? 'sin_comprobar';
  const statusLabel = summary ? AI_KEY_STATUS_LABEL[status] : 'Sin clave';
  const checkedAt = formatDate(summary?.lastCheckedAt ?? null);
  const busy = pending || deleting || checking || orderPending;
  const label = USER_KEY_PROVIDER_LABEL[provider];

  const applyResult = (next: AiKeyActionResult) => {
    setResult(next);
    if (!next.ok || !next.provider) return;
    setSummaries((current) => {
      const copy = { ...current };
      if (next.last4 && next.status) {
        copy[next.provider!] = {
          provider: next.provider!,
          status: next.status,
          last4: next.last4,
          lastCheckedAt: new Date().toISOString(),
          lastError: next.status === 'valida' ? null : next.message,
        };
      } else if (next.status) {
        const previous = copy[next.provider!];
        if (previous) {
          copy[next.provider!] = {
            ...previous,
            status: next.status,
            lastCheckedAt: new Date().toISOString(),
            lastError: next.status === 'valida' ? null : next.message,
          };
        }
      }
      return copy;
    });
    router.refresh();
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const rawKey = String(formData.get('key') ?? '').trim();
    const formatError = providerKeyFormatError(provider, rawKey);
    setResult(null);
    if (formatError) {
      setResult({ ok: false, message: formatError });
      return;
    }
    startTransition(async () => {
      const next = await saveMyAiKey(formData);
      if (next.ok) setValue('');
      applyResult(next);
    });
  };

  const remove = () => {
    if (!window.confirm(`¿Borrar tu clave de ${label}? Las pantallas de IA volverán a pedirla.`)) {
      return;
    }
    setResult(null);
    startDelete(async () => {
      const next = await deleteMyAiKey(provider);
      if (next.ok) {
        setSummaries((current) => {
          const copy = { ...current };
          delete copy[provider];
          return copy;
        });
        setValue('');
      }
      setResult(next);
      if (next.ok) router.refresh();
    });
  };

  const moveProvider = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    setResult(null);
    startOrder(async () => {
      setResult(await saveMyProviderOrder(next));
    });
  };

  const recheck = () => {
    setResult(null);
    startCheck(async () => {
      applyResult(await recheckMyAiKey(provider));
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
              Se guarda cifrada y solo se usa en tus peticiones. Puedes tener una clave por
              proveedor; si tienes la tuya no se gasta la de plataforma.
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

      {/* Un chip por proveedor: el estado de cada clave, de un vistazo. */}
      <div className="flex flex-wrap gap-2">
        {USER_KEY_PROVIDERS.map((id) => {
          const saved = summaries[id];
          const selected = id === provider;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                setProvider(id);
                setValue('');
                setResult(null);
              }}
              aria-pressed={selected}
              className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                selected
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200'
                  : 'border-slate-700 bg-white/[0.02] text-slate-400 hover:border-slate-500 hover:text-slate-200'
              }`}
            >
              {USER_KEY_PROVIDER_LABEL[id]}
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  saved?.status === 'valida'
                    ? 'bg-emerald-400'
                    : saved
                      ? 'bg-amber-400'
                      : 'bg-slate-600'
                }`}
                aria-hidden
              />
            </button>
          );
        })}
      </div>

      {provider === 'gemini' ? (
        <p className="rounded-xl border border-slate-700/70 bg-white/[0.02] px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          Google exige ser mayor de 18 años para crear claves de API de Gemini.
        </p>
      ) : provider === 'custom' ? (
        <p className="rounded-xl border border-slate-700/70 bg-white/[0.02] px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          Para un endpoint compatible con OpenAI, indica una dirección HTTPS pública (sin usuario ni
          contraseña). La clave y la dirección se guardan cifradas; las direcciones locales o
          privadas se rechazan.
        </p>
      ) : (
        <p className="rounded-xl border border-slate-700/70 bg-white/[0.02] px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          La clave se comprueba contra {label} antes de guardarse.{' '}
          {USER_KEY_PROVIDER_SIGNUP[provider] ? (
            <>
              Sácala en{' '}
              <a
                href={USER_KEY_PROVIDER_SIGNUP[provider]}
                target="_blank"
                rel="noreferrer noopener"
                className="text-emerald-300 underline decoration-emerald-500/40"
              >
                {USER_KEY_PROVIDER_SIGNUP[provider].replace('https://', '')}
              </a>
              .
            </>
          ) : null}{' '}
          Si tienes clave propia, tus peticiones no se completan con la de plataforma de otro
          proveedor.
        </p>
      )}

      {!vaultReady ? (
        <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
          {vaultError ??
            'El servidor no tiene la clave de cifrado (SECRETS_KEY_V1), así que ahora mismo no se puede guardar ni leer ninguna clave.'}
        </p>
      ) : null}

      {summary ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-800 bg-[#080d18] px-3 py-2 text-[11px] text-slate-400">
          <span className="font-mono text-slate-200">•••• {summary.last4}</span>
          <span>{label}</span>
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
          Ahora mismo no tienes clave propia de {label}. Pega una para usar los catedráticos, la
          puesta a punto y el examinador con este proveedor.
        </p>
      )}

      {summary?.lastError && summary.status !== 'valida' ? (
        <p className="text-[11px] text-slate-400">{summary.lastError}</p>
      ) : null}

      {order.length > 1 ? (
        <div className="space-y-2 rounded-xl border border-slate-800 bg-[#080d18] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Orden de uso
          </p>
          <p className="text-[11px] text-slate-500">
            El motor empieza por el primero que tenga clave. Solo se mueve entre tus proveedores:
            nunca llama a uno que no hayas configurado.
          </p>
          <ol className="space-y-1">
            {order.map((id, index) => (
              <li key={id} className="flex items-center gap-2 text-[11px] text-slate-300">
                <span className="w-5 text-right font-mono text-slate-500">{index + 1}.</span>
                <span className="min-w-0 flex-1 truncate">
                  {USER_KEY_PROVIDER_LABEL[id] ?? id}
                  {!summaries[id] ? ' (sin clave)' : ''}
                </span>
                <button
                  type="button"
                  onClick={() => moveProvider(index, -1)}
                  disabled={index === 0 || busy}
                  aria-label={`Subir ${USER_KEY_PROVIDER_LABEL[id] ?? id}`}
                  className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-400 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveProvider(index, 1)}
                  disabled={index === order.length - 1 || busy}
                  aria-label={`Bajar ${USER_KEY_PROVIDER_LABEL[id] ?? id}`}
                  className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-400 disabled:opacity-30"
                >
                  ↓
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <form onSubmit={submit} className="space-y-2">
        <input type="hidden" name="provider" value={provider} />
        {provider === 'custom' ? (
          <div className="space-y-1">
            <label
              htmlFor="ai-base-url"
              className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500"
            >
              Dirección HTTPS del endpoint
            </label>
            <input
              id="ai-base-url"
              name="baseUrl"
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.mi-servidor.com/v1"
              className="w-full rounded-xl border border-slate-700 bg-[#080d18] px-3 py-2 font-mono text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-500/60"
              disabled={!vaultReady || busy}
            />
          </div>
        ) : null}
        <label
          htmlFor="ai-key"
          className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500"
        >
          Clave de {label}
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
            pattern="[A-Za-z0-9._-]+"
            title="Letras, números, puntos, guiones y guiones bajos. Sin espacios."
            placeholder={`${USER_KEY_PROVIDER_HINT[provider]} (se guarda cifrada)`}
            className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-[#080d18] px-3 py-2 font-mono text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-500/60"
            disabled={!vaultReady || busy}
          />
          <button
            type="submit"
            disabled={
              !vaultReady ||
              busy ||
              value.trim().length < 20 ||
              (provider === 'custom' && !baseUrl.trim())
            }
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Guardar y comprobar
          </button>
        </div>
        <p className="text-[10px] text-slate-500">
          Se comprueba contra {label} antes de guardar. Nunca se muestra entera: solo los últimos
          cuatro caracteres.
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
          Esta cuenta está en la lista de plataforma: si no tienes ninguna clave propia, usa la de
          plataforma. En cuanto guardes una, tus peticiones van solo con la tuya.
        </p>
      ) : null}
    </div>
  );
}
