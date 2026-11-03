import { NextResponse } from 'next/server';
import { diagnoseMoodleSite } from '@/lib/moodleWs';

/**
 * Diagnóstico de una dirección de Moodle SIN token.
 *
 * Sirve para que el alumno no tenga que adivinar: dice si esa dirección es un
 * Moodle, si tiene los servicios web encendidos y qué le falta (la clave, los
 * permisos del centro o la dirección correcta). No guarda nada ni pide claves.
 */
export async function POST(request: Request) {
  let baseUrl = '';
  try {
    const body = (await request.json()) as { baseUrl?: unknown };
    baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
  } catch {
    baseUrl = '';
  }

  if (!baseUrl.trim()) {
    return NextResponse.json(
      { error: 'Escribe primero la dirección de tu Moodle para poder comprobarla.' },
      { status: 400 }
    );
  }

  const diagnosis = await diagnoseMoodleSite(baseUrl);
  console.log(`[moodle] diagnóstico ${diagnosis.code} · ${diagnosis.endpoint}`);
  return NextResponse.json({ ok: true, diagnosis });
}
