/**
 * Traducción de errores del lienzo a respuestas HTTP.
 *
 * Sin esto, cada ruta repetiría el mismo `catch` y alguna acabaría devolviendo
 * 500 para un archivo que el alumno puede arreglar (demasiado grande, sin texto)
 * o 400 para un fallo del almacén (que es un 503 y se reintenta).
 */

import { NextResponse } from 'next/server';
import { AuthRequiredError } from '@/lib/auth';
import { SourceStorageError, SourceTextError } from './sources';
import { StudyFormatError } from './generate';

export function studyErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof AuthRequiredError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof SourceStorageError) {
    return NextResponse.json(
      { error: `${error.message} Inténtalo de nuevo en un momento.`, retry: true },
      { status: 503 }
    );
  }
  if (error instanceof SourceTextError) {
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  if (error instanceof StudyFormatError) {
    return NextResponse.json(
      {
        error:
          'El catedrático ha devuelto una respuesta que no se puede leer. Vuelve a intentarlo.',
        detail: error.message,
        retry: true,
      },
      { status: 422 }
    );
  }

  const message = error instanceof Error ? error.message : 'error desconocido';
  console.error(`[lienzo] ${fallback}:`, message);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
