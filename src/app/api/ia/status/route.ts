import { NextResponse } from 'next/server';
import { getEngineStatus } from '@/lib/aiEngine';

export const dynamic = 'force-dynamic';

/**
 * Estado del motor de IA: proveedores configurados, ranking real de modelos
 * gratuitos y qué está enfriando por cupo. Nunca expone las claves.
 */
export async function GET() {
  try {
    const status = await getEngineStatus();
    return NextResponse.json(status, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[ia] No se pudo consultar el estado del motor:', error);
    return NextResponse.json(
      { error: 'No se pudo consultar el estado del motor de IA.' },
      { status: 500 }
    );
  }
}
