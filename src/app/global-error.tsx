'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/clientErrors';

/**
 * El último recurso: cuando lo que falla es el propio layout raíz.
 *
 * Este componente tiene que valerse por sí solo (no puede usar el layout ni sus
 * estilos más allá de estilos en línea), así que no depende de nada del proyecto
 * salvo el registro de errores. Su trabajo es que **nunca** quede una pantalla en
 * blanco y que la explicación sirva también fuera del ordenador de desarrollo.
 *
 * React #441 («An error occurred in the Server Components render») llega aquí:
 * en producción el mensaje real se oculta y solo queda el digest. Como el único
 * dato que este componente toca al montarse es el perfil de la cabecera —que
 * consulta PostgreSQL en Supabase—, la causa habitual en un despliegue es la
 * base de datos, no el navegador. El texto lo dice así en vez de mandar al
 * alumno a ejecutar scripts que solo existen en local.
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
    // El último recurso también deja rastro. `reportClientError` no lanza nunca,
    // pero se envuelve igual: registrar no puede ser la causa de un segundo fallo.
    try {
      reportClientError({
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        source: 'global-error.tsx',
        url: typeof window !== 'undefined' ? window.location.pathname : undefined,
      });
    } catch {
      /* si el aviso falla, se pierde el aviso */
    }
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
            BRAINUP ACADEMY · NO HA PODIDO ARRANCAR
          </h1>

          <p style={{ margin: '0 0 12px', fontSize: '13px', lineHeight: 1.6, color: '#cbd5e1' }}>
            El servidor no ha podido pintar esta página. Tus datos no se han tocado: siguen en la
            base de datos. Lo más habitual en un despliegue es que esa base no esté accesible desde
            la función (variable <code>DATABASE_URL</code> sin definir o con el pooler mal, o las
            tablas sin migrar).
          </p>

          <p style={{ margin: '0 0 16px', fontSize: '11px', color: '#94a3b8', wordBreak: 'break-word' }}>
            {error.digest ? `referencia ${error.digest} · ` : ''}
            {(error.message || 'Error sin mensaje').slice(0, 200)}
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
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

            {/* Enlaces normales: este componente sustituye al layout raíz. */}
            <a
              href="/api/salud"
              style={{
                border: '1px solid #334155',
                borderRadius: '12px',
                padding: '10px 16px',
                fontSize: '13px',
                fontWeight: 600,
                color: '#cbd5e1',
                textDecoration: 'none',
              }}
            >
              Comprobar el estado
            </a>
          </div>

          <p style={{ margin: '16px 0 0', fontSize: '11px', color: '#94a3b8', lineHeight: 1.6 }}>
            Si te toca desplegar: revisa <code>DATABASE_URL</code> en Netlify (Site configuration →
            Environment variables), aplica las migraciones con{' '}
            <code>npx prisma migrate deploy</code> contra esa misma base y vuelve a desplegar. El
            parte de <code>/api/salud</code> dice si la base responde y qué error da.
          </p>
        </div>
      </body>
    </html>
  );
}
