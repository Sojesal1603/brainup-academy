'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  HardDrive,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Zap,
} from 'lucide-react';

interface EngineKey {
  label: string;
  envVar: string;
  coolingSeconds: number;
  modelsOutOfQuota: number;
  used: number;
  lastStatus: string | null;
}

interface EngineProvider {
  id: string;
  name: string;
  keyEnv: string;
  configured: boolean;
  signupUrl: string;
  note: string;
  keys: EngineKey[];
  keysAvailable: number;
  extraKeyEnv: string[];
}

interface EngineModel {
  key: string;
  provider: string;
  model: string;
  coolingSeconds: number;
  lastStatus: string | null;
}

interface EngineStatus {
  providers: EngineProvider[];
  ranked: EngineModel[];
  nextKey: string | null;
  selected: string | null;
  lastGood: string | null;
  usage: { calls: number; failures: number; byProvider: Record<string, number> };
  lastDecision: { at: number } | null;
  quotaTight: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  ok: 'Disponible',
  quota: 'Cupo agotado (temporal)',
  quota_daily: 'Cupo diario agotado',
  missing: 'No disponible en tu clave',
  error: 'Fallo puntual',
  auth: 'Clave rechazada',
  too_large: 'Texto demasiado largo para ese modelo',
};

function statusTone(model: EngineModel): string {
  if (model.coolingSeconds > 0) return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  if (model.lastStatus === 'auth' || model.lastStatus === 'missing') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  }
  if (model.lastStatus === 'too_large') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-300';
  }
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
}

export default function AiEngineCard() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  // Formulario para añadir claves extra
  const [selectedVar, setSelectedVar] = useState<string>('GEMINI_API_KEY_2');
  const [newKeyValue, setNewKeyValue] = useState<string>('');
  const [savingKey, setSavingKey] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Test en vivo
  const [testProvider, setTestProvider] = useState<
    'gemini' | 'groq' | 'openrouter' | 'ollama'
  >('gemini');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs?: number;
    modelsCount?: number;
    error?: string;
    provider?: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ia/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as EngineStatus;
      setStatus(data);
      setCheckedAt(new Date());
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `No se pudo consultar el motor: ${caught.message}`
          : 'No se pudo consultar el motor.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyValue.trim()) return;
    setSavingKey(true);
    setSaveMessage(null);
    try {
      const res = await fetch('/api/ia/save-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: { [selectedVar]: newKeyValue.trim() } }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Error al guardar');
      setSaveMessage(`✅ ${selectedVar} guardada en .env y activada.`);
      setNewKeyValue('');
      void load();
    } catch (err) {
      setSaveMessage(`❌ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingKey(false);
    }
  };

  const runLiveTest = async (provider: 'gemini' | 'groq' | 'openrouter' | 'ollama') => {
    setTestProvider(provider);
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/ia/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const best = status?.nextKey ?? null;

  return (
    <div className="p-6 rounded-2xl glass-card space-y-6">
      {/* Cabecera */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100">
              Motor de IA 24/7 y Gestión de Cuotas
            </h3>
            <p className="text-xs text-slate-400">
              Rotación automática entre las claves gratuitas de Gemini, Groq y OpenRouter sin cortes
              ni coste de suscripción.
            </p>
          </div>
        </div>

        <button
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 font-semibold text-[11px] transition-colors"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span>Actualizar estado</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl px-3 py-2 border border-rose-500/30 bg-rose-500/10 text-rose-200 text-[11px]">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Diagnóstico de Hardware y Estrategia 24/7 */}
      <div className="p-4 rounded-xl bg-[#070c18] border border-cyan-500/30 space-y-3">
        <div className="flex items-center gap-2 text-cyan-300">
          <HardDrive className="w-4 h-4" />
          <h4 className="text-xs font-bold uppercase tracking-wider">
            Diagnóstico de tu Ordenador y Estrategia 24/7 Recomendada
          </h4>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] text-slate-300">
          <div className="rounded-lg bg-slate-900/80 p-3 border border-slate-800 space-y-1.5">
            <p className="font-semibold text-slate-100 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              Tu Hardware Detectado: 8 GB RAM · Gráfica Intel UHD
            </p>
            <p className="text-slate-400 leading-relaxed text-[10.5px]">
              Tu ordenador tiene 8 GB de memoria y gráfica compartida (sin tarjeta NVIDIA dedicada).
              Correr modelos locales de 7B/8B (como Llama 3 8B) en tu CPU consumiría más de 5 GB de RAM,
              tardando entre 40 y 70 segundos por respuesta y arriesgando congelar el sistema.
            </p>
          </div>

          <div className="rounded-lg bg-emerald-950/30 p-3 border border-emerald-500/30 space-y-1.5">
            <p className="font-semibold text-emerald-300 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" />
              Estrategia Ganadora: Pool Multi-Clave (0 € y latencia sub-segundo)
            </p>
            <p className="text-emerald-200/80 leading-relaxed text-[10.5px]">
              Google AI Studio y Groq dan cuotas gratuitas generosas <strong>por cada clave</strong> (añadiendo 2 o 3,
              el sistema rota entre ellas solo cuando una toca el límite 429) y OpenRouter aporta una tercera
              vía con modelos gratis de otras familias cuando las dos anteriores se quedan secas.
              ¡Disponibilidad 24/7 instantánea, máxima precisión en Bachillerato y 0 € de gasto!
            </p>
          </div>
        </div>
      </div>

      {/* Proveedores de IA */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {status?.providers.map((provider) => (
          <div
            key={provider.id}
            className="p-4 rounded-xl bg-[#080d18] border border-slate-800 space-y-2 flex flex-col justify-between"
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-200">{provider.name}</span>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold border ${
                    provider.configured
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      : 'bg-slate-800 text-slate-400 border-slate-700'
                  }`}
                >
                  {provider.configured ? 'Conectado' : 'Opcional'}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">{provider.note}</p>

              {/* Claves del proveedor */}
              {provider.configured && provider.keys.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  {provider.keys.map((key) => (
                    <span
                      key={key.envVar}
                      title={key.envVar}
                      className={`text-[10px] px-2 py-0.5 rounded font-mono border ${
                        key.coolingSeconds > 0
                          ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                          : key.modelsOutOfQuota > 0
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      }`}
                    >
                      {key.label === 'principal' ? 'clave 1' : `clave ${key.label}`}
                      {' · '}
                      {key.coolingSeconds > 0
                        ? `enfriando ${Math.max(1, Math.ceil(key.coolingSeconds / 60))}m`
                        : key.modelsOutOfQuota > 0
                          ? `${key.modelsOutOfQuota} s/cupo`
                          : key.used > 0
                            ? `${key.used} usos`
                            : 'activa'
                      }
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() =>
                  void runLiveTest(provider.id as 'gemini' | 'groq' | 'openrouter' | 'ollama')
                }
                disabled={testing}
                className="text-[10.5px] font-semibold text-emerald-400 hover:text-emerald-300 underline"
              >
                {testing && testProvider === provider.id ? 'Probando…' : 'Probar conexión'}
              </button>
              {provider.signupUrl && (
                <a
                  href={provider.signupUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] text-slate-400 hover:text-slate-200"
                >
                  Obtener clave gratis ↗
                </a>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Resultado del test en vivo si se ejecutó */}
      {testResult && (
        <div
          className={`p-3 rounded-xl border text-xs flex items-center justify-between gap-3 ${
            testResult.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {testResult.ok ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            )}
            <span>
              {testResult.ok
                ? `Test de ${testResult.provider || testProvider} exitoso (${testResult.latencyMs} ms). ${
                    testResult.modelsCount ? `${testResult.modelsCount} modelos disponibles.` : ''
                  }`
                : `Error en ${testProvider}: ${testResult.error}`}
            </span>
          </div>
          <button
            onClick={() => setTestResult(null)}
            className="text-[10px] font-bold uppercase underline opacity-80 hover:opacity-100"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Formulario rápido para añadir claves de rotación */}
      <div className="p-4 rounded-xl bg-[#080d18] border border-slate-800 space-y-3">
        <div className="flex items-center gap-2 text-slate-200">
          <KeyRound className="w-4 h-4 text-emerald-400" />
          <h4 className="text-xs font-bold uppercase tracking-wider">
            Añadir Clave Extra de Rotación (Multiplica tu Cuota 24/7)
          </h4>
        </div>
        <p className="text-[11px] text-slate-400">
          Copia una clave gratuita extra de Google AI Studio, de Groq o de OpenRouter (creada con otra
          cuenta) y pégala aquí. Se guardará en tu archivo{' '}
          <code className="text-slate-300">.env</code> de inmediato. Ojo: en OpenRouter el plan gratuito
          se cuenta por cuenta (50 peticiones al día), así que una clave extra no multiplica su cupo.
        </p>

        <form onSubmit={handleSaveKey} className="flex flex-wrap items-center gap-2">
          <select
            value={selectedVar}
            onChange={(e) => setSelectedVar(e.target.value)}
            className="px-3 py-2 rounded-xl glass-card border border-slate-700 text-xs text-slate-200 font-mono focus:border-emerald-500 focus:outline-none"
          >
            <option value="GEMINI_API_KEY_2">GEMINI_API_KEY_2</option>
            <option value="GEMINI_API_KEY_3">GEMINI_API_KEY_3</option>
            <option value="GEMINI_API_KEY_4">GEMINI_API_KEY_4</option>
            <option value="GROQ_API_KEY_2">GROQ_API_KEY_2</option>
            <option value="GROQ_API_KEY_3">GROQ_API_KEY_3</option>
            <option value="GROQ_API_KEY_4">GROQ_API_KEY_4</option>
            <option value="OPENROUTER_API_KEY">OPENROUTER_API_KEY</option>
            <option value="OPENROUTER_API_KEY_2">OPENROUTER_API_KEY_2</option>
            <option value="OLLAMA_ENABLED">OLLAMA_ENABLED (true/false)</option>
          </select>

          <input
            type="text"
            placeholder="Pega la clave aquí..."
            value={newKeyValue}
            onChange={(e) => setNewKeyValue(e.target.value)}
            className="flex-1 min-w-[200px] px-3 py-2 rounded-xl glass-card border border-slate-700 text-xs text-slate-100 font-mono placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
          />

          <button
            type="submit"
            disabled={savingKey || !newKeyValue.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs transition-colors"
          >
            {savingKey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            <span>Guardar Clave</span>
          </button>
        </form>

        {saveMessage && (
          <p className="text-[11px] font-mono text-slate-300">{saveMessage}</p>
        )}
      </div>

      {/* Modelo seleccionado y ranking */}
      {status && (
        <div className="rounded-xl bg-[#080d18] border border-slate-800 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-400" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Modelo Primario Activo Ahora Mismo
              </span>
            </div>
            <div className="flex items-center gap-3 text-[10px] font-mono text-slate-400">
              <span>Llamadas hoy: {status.usage.calls}</span>
              <span>Fallos: {status.usage.failures}</span>
            </div>
          </div>

          {best ? (
            <p className="text-sm font-bold text-emerald-300 font-mono break-all">{best}</p>
          ) : (
            <p className="text-xs text-amber-300">
              Todos los modelos están en enfriamiento por cupo. Se reintentará en cuanto expire la ventana de espera.
            </p>
          )}

          {/* Ranking en vivo */}
          {status.ranked.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Cadena de candidatos ordenados por idoneidad (failover instantáneo):
              </p>
              {status.ranked.map((model) => (
                <div
                  key={model.key}
                  className="flex items-center justify-between gap-3 rounded-lg bg-[#070b14] border border-slate-800/80 px-3 py-1.5"
                >
                  <span
                    className={`text-[11px] font-mono truncate ${
                      model.key === best ? 'text-emerald-300 font-bold' : 'text-slate-300'
                    }`}
                  >
                    {model.key}
                  </span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold border shrink-0 ${statusTone(
                      model
                    )}`}
                  >
                    {model.coolingSeconds > 0
                      ? `Enfriando ${model.coolingSeconds}s`
                      : STATUS_LABEL[model.lastStatus ?? 'ok'] ?? 'Disponible'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
