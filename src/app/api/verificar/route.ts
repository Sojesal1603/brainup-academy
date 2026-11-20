import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireUser } from '@/lib/auth';
import { verifyText } from '@/lib/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Tope del texto que se analiza: un mensaje del chat, no un libro. */
const MAX_TEXT = 20_000;

/**
 * «Comprobar cálculo» del Catedrático (Paso 12).
 *
 * Recibe una respuesta del chat y devuelve la verificación determinista de las
 * cuentas que contenga: igualdades aritméticas, homogeneidad de unidades y
 * ecuaciones químicas ajustadas. No llama a ningún modelo y **no modifica la
 * respuesta**: solo dice qué cuadra y qué no.
 */
export async function POST(request: NextRequest) {
  try {
    await requireUser();

    const body = (await request.json().catch(() => null)) as
      | { text?: unknown; subjectName?: unknown }
      | null;

    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return NextResponse.json({ error: 'Falta el texto que comprobar.' }, { status: 400 });
    }
    if (text.length > MAX_TEXT) {
      return NextResponse.json(
        { error: 'El texto es demasiado largo para comprobarlo de una vez.' },
        { status: 413 }
      );
    }

    const subjectName =
      typeof body?.subjectName === 'string' ? body.subjectName.trim().slice(0, 120) : null;

    const verification = verifyText({ text, subjectName });

    return NextResponse.json(
      { ok: true, verification },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error('[verificar] no se pudo comprobar el texto:', error);
    return NextResponse.json({ error: 'No se pudo comprobar el cálculo.' }, { status: 500 });
  }
}
