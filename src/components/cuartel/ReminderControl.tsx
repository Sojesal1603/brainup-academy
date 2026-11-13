'use client';

import { useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import { saveReminder } from '@/lib/actions';

/**
 * Aviso diario del plan.
 *
 * El permiso y la suscripción se piden en el clic (no al cargar): el navegador
 * exige un gesto del usuario. La hora se guarda en el perfil y el cron la
 * compara con su zona horaria; el aviso lleva el nombre del bloque, no un
 * «tienes tareas pendientes» genérico.
 */
export default function ReminderControl({
  initialEnabled,
  initialTime,
}: {
  initialEnabled: boolean;
  initialTime: string;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [time, setTime] = useState(initialTime || '17:00');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  }

  async function activate() {
    setBusy(true);
    setMessage(null);
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        throw new Error('Este navegador no admite avisos push.');
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Has bloqueado los avisos. Actívalos en los permisos del navegador.');
      }

      const keyResponse = await fetch('/api/push/public-key', { cache: 'no-store' });
      const keyData = (await keyResponse.json()) as { publicKey?: string; error?: string };
      if (!keyResponse.ok || !keyData.publicKey) {
        throw new Error(keyData.error || 'El servidor no tiene Web Push configurado.');
      }

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64ToBytes(keyData.publicKey),
        }));

      const saved = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
      const savedData = (await saved.json()) as { error?: string };
      if (!saved.ok) throw new Error(savedData.error || 'No se ha podido guardar el dispositivo.');

      const result = await saveReminder(time, true);
      if (!result.success) throw new Error(result.error || 'No se ha podido guardar la hora.');

      setEnabled(true);
      setMessage(`Aviso activo a las ${time}.`);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deactivate() {
    setBusy(true);
    setMessage(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => null);
        await subscription.unsubscribe().catch(() => false);
      }
      const result = await saveReminder(time, false);
      if (!result.success) throw new Error(result.error || 'No se ha podido desactivar.');
      setEnabled(false);
      setMessage('Aviso desactivado.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveTime() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveReminder(time, enabled);
      if (!result.success) throw new Error(result.error || 'No se ha podido guardar la hora.');
      setMessage(enabled ? `Aviso a las ${time}.` : 'Hora guardada; el aviso está desactivado.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
          {enabled ? <Bell className="h-3.5 w-3.5 text-emerald-400" /> : <BellOff className="h-3.5 w-3.5 text-slate-500" />}
          Aviso del plan
        </span>
        <input
          type="time"
          value={time}
          onChange={(event) => setTime(event.target.value)}
          className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
          aria-label="Hora del aviso"
        />
        {enabled ? (
          <button
            type="button"
            onClick={deactivate}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:text-slate-100 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <BellOff className="h-3 w-3" />}
            Desactivar
          </button>
        ) : (
          <button
            type="button"
            onClick={activate}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bell className="h-3 w-3" />}
            Activar
          </button>
        )}
        <button
          type="button"
          onClick={saveTime}
          disabled={busy}
          className="text-[10px] font-semibold text-slate-400 hover:text-slate-200 disabled:opacity-50"
        >
          Guardar hora
        </button>
      </div>
      {message && <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">{message}</p>}
      <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
        Llega aunque la app esté cerrada si has instalado la PWA y dado permiso. El texto nombra el
        bloque concreto, no una tarea genérica.
      </p>
    </div>
  );
}
