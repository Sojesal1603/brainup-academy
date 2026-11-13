import webpush from 'web-push';
import { db } from './db';
import { prisma } from './prisma';
import { computeDayPlan } from './dayPlan';

/**
 * Aviso diario del plan por Web Push.
 *
 * No usa IA ni escribe el plan: lee el bloque que el motor ya decidió y manda
 * su nombre. El envío es idempotente por dispositivo y día (`lastNotifiedDay`),
 * así un cron cada minuto no convierte la tarde en una tormenta de avisos.
 */

export interface PushResult {
  configured: boolean;
  due: number;
  sent: number;
  skipped: number;
  removed: number;
  errors: number;
}

function vapidConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '').trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY ?? '').trim();
  const subject = (process.env.VAPID_SUBJECT ?? '').trim() || 'https://brainup.academy';
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

export function pushConfigured(): boolean {
  return vapidConfig() !== null;
}

let configured = false;
function ensureVapid(): boolean {
  if (configured) return true;
  const config = vapidConfig();
  if (!config) return false;
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  configured = true;
  return true;
}

/** Día y hora locales del alumno, sin depender de la zona del servidor. */
function localClock(now: Date, timeZone: string): { dayKey: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    dayKey: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function clockMinutes(value: string | null): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * Envía los avisos que tocan en este minuto.
 *
 * Ventana de 3 minutos para que un cron que arranca un poco tarde no se salte
 * la hora; el `lastNotifiedDay` evita duplicados dentro de la ventana.
 */
export async function sendDueReminders(now: Date = new Date()): Promise<PushResult> {
  const result: PushResult = {
    configured: false,
    due: 0,
    sent: 0,
    skipped: 0,
    removed: 0,
    errors: 0,
  };

  if (!ensureVapid()) return result;
  result.configured = true;

  const profiles = await prisma.userProfile.findMany({
    where: { reminderEnabled: true, reminderTime: { not: null } },
    select: { id: true, timezone: true, reminderTime: true },
  });

  for (const profile of profiles) {
    const target = clockMinutes(profile.reminderTime);
    if (target === null) continue;

    const clock = localClock(now, profile.timezone || 'Europe/Madrid');
    const diff = clock.minutes - target;
    if (diff < 0 || diff > 2) continue;

    result.due += 1;

    const plan = await computeDayPlan(profile.id, now);
    const next = plan.sessions.find(
      (session) => !session.isCompleted && session.status !== 'abandonada'
    );
    if (!next) {
      result.skipped += 1;
      continue;
    }

    const subscriptions = await db(profile.id).pushSubscription.findMany();
    if (subscriptions.length === 0) {
      result.skipped += 1;
      continue;
    }

    const payload = JSON.stringify({
      title: `Ahora: ${next.topicTitle}`,
      body: `${next.subjectName} · ${next.durationMinutes} min — ${next.objective}`,
      url: '/',
      tag: 'brainup-ahora',
    });

    for (const subscription of subscriptions) {
      if (subscription.lastNotifiedDay === clock.dayKey) {
        result.skipped += 1;
        continue;
      }

      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          { TTL: 60 * 60 }
        );
        await db(profile.id).pushSubscription.update({
          where: { id: subscription.id },
          data: { lastNotifiedDay: clock.dayKey },
        });
        result.sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db(profile.id).pushSubscription.delete({ where: { id: subscription.id } });
          result.removed += 1;
        } else {
          result.errors += 1;
          console.error(
            `[push] fallo al avisar al dispositivo ${subscription.id.slice(0, 6)}…: ${status ?? 'sin estado'}`
          );
        }
      }
    }
  }

  return result;
}
