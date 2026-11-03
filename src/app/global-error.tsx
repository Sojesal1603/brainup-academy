'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/clientErrors';

/**
 * El último recurso: cuando lo que falla es el propio layout raíz.
 *
 * Este componente tiene que valerse por sí solo (no puede usar el layout ni sus
 * estilos de Tailwind más allá de lo que ya trae el paquete), así que va con
 * estilos en línea y sin depender de nada del proyecto. Su trabajo es que **nunca**
 * quede una pantalla en blanco: si esto se muestra, hay un botón que recarga y una
 * frase que explica qué ha pasado.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] error del layout raíz:', error.message, error.digest ?? '');
    // El último recurso también deja rastro: que el fallo del layout raíz no se
    // quede solo en la pantalla del alumno.
    reportClientError({
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      source: 'global-error.tsx',
      url: typeof window !== 'undefined' ? window.location.pathname : undefined,
    });
  }, [error]);

  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0c',
          color: '#e2e8f0',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          padding: '24px',
        }}
      >
        <div
          style={{
            maxWidth: '34rem',
            border: '1px solid #334155',
            borderRadius: '20px',
            padding: '24px',
            background: '#131825',
          }}
        >
          <h1 style={{ margin: '0 0 12px', fontSize: '15px', letterSpacing: '0.04em' }}>
            BRAINUP ACADEMY · ALGO SE HA ROTO AL ARRANCAR
          </h1>
          <p style={{ margin: '0 0 12px', fontSize: '13px', lineHeight: 1.6, color: '#cbd5e1' }}>
            Tus datos siguen a salvo en la base local. Esto suele pasar cuando el servidor está
            recompilando o se ha quedado a medias: <strong>recarga</strong> y debería volver.
          </p>
          <p style={{ margin: '0 0 16px', fontSize: '11px', color: '#94a3b8', wordBreak: 'break-word' }}>
            {error.digest ? `referencia ${error.digest} · ` : ''}
            {error.message.slice(0, 200)}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              background: '#10b981',
              color: '#04121a',
              border: 'none',
              borderRadius: '12px',
              padding: '10px 16px',
              fontSize: '13px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Reintentar
          </button>
          <p style={{ margin: '16px 0 0', fontSize: '11px', color: '#94a3b8', lineHeight: 1.6 }}>
            Si no vuelve: en la carpeta del proyecto, <code>npm run sirve</code> levanta la app
            vigilada (se reinicia sola) y <code>npm run doctor</code> dice qué está pasando.
          </p>
        </div>
      </body>
    </html>
  );
}
