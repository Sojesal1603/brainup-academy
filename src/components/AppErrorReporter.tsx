'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/clientErrors';

/**
 * El oído de la app en el navegador.
 *
 * Los errores de render tienen su `error.tsx`, pero hay dos familias que se
 * escapan de React y no los ve nadie: una excepción suelta (`window.onerror`,
 * un script, un `JSON.parse` en un manejador) y una promesa rechazada sin
 * `catch` (`unhandledrejection`, la más habitual con `fetch`). Aquí se recogen
 * las dos y se mandan al servidor, donde ya hay quien las lee.
 *
 * No pinta nada y no puede romper nada: solo escucha y avisa.
 */
export default function AppErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const message = event.message || event.error?.message || '';
      if (!message) return;
      reportClientError({
        message,
        stack: event.error?.stack,
        source: 'window.onerror',
        url: event.filename || window.location.pathname,
      });
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as unknown;
      const message =
        typeof reason === 'string'
          ? reason
          : reason instanceof Error
            ? reason.message
            : (() => {
                try {
                  return JSON.stringify(reason);
                } catch {
                  return '';
                }
              })();
      if (!message) return;
      reportClientError({
        message,
        stack: reason instanceof Error ? reason.stack : undefined,
        source: 'window.unhandledrejection',
      });
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
