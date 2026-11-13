'use client';

import { useEffect } from 'react';
import { markAppReady } from '@/lib/appReady';

/**
 * Se monta cuando el Suspense de la cabecera ya ha resuelto el perfil.
 *
 * No pinta nada: solo avisa a la splash de que los datos del usuario ya están
 * (o de que no hay usuario), para que pueda retirarse.
 */
export default function AppReadySignal() {
  useEffect(() => {
    markAppReady();
  }, []);

  return null;
}
