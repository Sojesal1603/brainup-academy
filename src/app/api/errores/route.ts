import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

/**
 * El buzón de los errores del navegador.
 *
 * Escribe en `data/logs/errores-app.log`, el MISMO fichero que rellena
 * `src/instrumentation.ts` cuando revienta una petición en el servidor. Eso es a
 * propósito: el taller de mantenimiento y el vigilante ya leen ese rastro, así
 * que un error de cliente entra en el circuito de reparación que ya existe sin
 * tocar nada más.
 *
 * Nunca puede ser la causa de un error nuevo: si no se puede escribir, se
 * contesta igualmente 200. Un log es un rastro, no un servicio crítico.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOG_DIR = path.join(process.cwd(), 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'errores-app.log');
/** Tope del mensaje: el mismo que en `instrumentation.ts`. */
const MAX_MESSAGE = 300;
const MAX_SOURCE = 80;
const MAX_STACK = 1200;
const MAX_URL = 200;
/** Si crece demasiado, se empieza de cero: es un rastro, no un archivo. */
const MAX_BYTES = 512 * 1024;

interface ErrorBody {
  message?: unknown;
  stack?: unknown;
  source?: unknown;
  digest?: unknown;
  url?: unknown;
}

function safeText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ErrorBody;
    const message = safeText(body?.message, MAX_MESSAGE);
    if (message.length === 0) {
      return NextResponse.json({ ok: true });
    }

    const source = safeText(body?.source, MAX_SOURCE) || 'cliente';
    const stack = safeText(body?.stack, MAX_STACK);
    const digest = safeText(body?.digest, MAX_SOURCE);
    const url = safeText(body?.url, MAX_URL);

    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const extras = [digest ? `ref ${digest}` : '', url ? `en ${url}` : '', stack ? `· ${stack}` : '']
      .filter(Boolean)
      .join(' ');
    const line = `[${stamp}] POST ${source} · ${message}${extras ? ` ${extras}` : ''}\n`;

    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      try {
        if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.rmSync(LOG_FILE, { force: true });
      } catch {
        // Si el fichero aún no existe, no hay nada que vaciar.
      }
      fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch {
      // No se puede escribir: se pierde el rastro, no la respuesta.
    }
  } catch {
    // JSON inválido: tampoco es motivo para devolver un error al navegador.
  }

  return NextResponse.json({ ok: true });
}
