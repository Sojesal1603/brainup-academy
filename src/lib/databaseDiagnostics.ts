/**
 * Diagnóstico de la base de datos, SIN importar Prisma.
 *
 * Este módulo es a propósito independiente de `@prisma/client`: si el cliente no
 * se ha generado o el motor no carga, importar Prisma revienta al cargar el
 * módulo y cualquier página que lo toque devuelve el error #441 sin explicar
 * nada. Aquí solo se leen variables de entorno y cadenas de error, así que
 * siempre se puede cargar — incluso cuando la base está caída del todo.
 *
 * Lo usan el parte de `/api/salud`, la pantalla de error y `/diagnostico`.
 */

/**
 * Código de error de Prisma (`P1001`, `P2021`…) a partir del objeto o del texto.
 *
 * OJO: no siempre está en `.code`. Un fallo de conexión llega como
 * `PrismaClientInitializationError`, que lo guarda en `.errorCode` y NO lo pone
 * en el mensaje; mirar solo `.code` dejaba el parte de salud sin código y sin
 * poder distinguir «no llego» de «faltan tablas».
 */
export function prismaErrorCode(error: unknown): string | null {
  if (!error) return null;
  for (const field of ['code', 'errorCode'] as const) {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === 'string' && /^P\d{4}$/.test(value)) return value;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\b(P\d{4})\b/);
  return match ? match[1] : null;
}

/**
 * La URL de la base tal y como la espera Prisma en serverless.
 *
 * Se toca lo mínimo y solo cuando aporta:
 *   - `sslmode=require` fuera de local: Supabase rechaza conexiones sin TLS y el
 *     error que da entonces (P1011) no dice nada útil.
 *   - Pooler de Supabase (puerto 6543): `pgbouncer=true` (sin él Prisma usa
 *     sentencias preparadas que pgbouncer no conserva) y `connection_limit=1`
 *     (cada función serverless abre su propia conexión; con muchas a la vez se
 *     agota el cupo del plan gratuito).
 * Nunca se registra con credenciales: solo se devuelve la cadena ya limpia.
 */
export function resolveDatabaseUrl(rawInput?: string): string | undefined {
  const raw = (rawInput ?? process.env.DATABASE_URL ?? '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return undefined;
  // Otra cosa (SQLite local u otra cadena): se respeta tal cual.
  if (!/^postgres(ql)?:\/\//i.test(raw)) return raw;

  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

    if (!local) {
      if (!url.searchParams.has('sslmode')) {
        url.searchParams.set('sslmode', 'require');
      }
      // Sin un tope de conexión, una URL que no es alcanzable (el host directo
      // de Supabase solo responde por IPv6 y las funciones de Netlify no lo
      // tienen) deja la consulta colgada: el render nunca termina y la vista se
      // queda «cargando» para siempre. Con `connect_timeout` el fallo llega en
      // segundos, se registra y la pantalla de error explica qué cambiar.
      if (!url.searchParams.has('connect_timeout')) {
        url.searchParams.set('connect_timeout', '10');
      }
    }

    if (url.hostname.endsWith('pooler.supabase.com')) {
      if (url.port === '6543' && !url.searchParams.has('pgbouncer')) {
        url.searchParams.set('pgbouncer', 'true');
      }
      if (!url.searchParams.has('connection_limit')) {
        url.searchParams.set('connection_limit', '1');
      }
    }

    return url.toString();
  } catch {
    return raw;
  }
}

export interface DatabaseTarget {
  /** ¿Hay `DATABASE_URL` en el entorno de esta función? */
  configured: boolean;
  /** Host, sin credenciales. */
  host: string | null;
  port: string | null;
  /** ¿Apunta al pooler de Supabase (6543)? */
  pooled: boolean;
  /**
   * ¿Apunta al host directo de Supabase (`db.<ref>.supabase.co`)? Las funciones
   * de Netlify no tienen IPv6 y ese host resuelve solo a IPv6 en los proyectos
   * nuevos: la conexión se queda colgada o da P1001 mientras en local funciona.
   */
  supabaseDirect: boolean;
}

export function databaseTarget(): DatabaseTarget {
  const raw = (process.env.DATABASE_URL ?? '').trim().replace(/^["']|["']$/g, '');
  if (!raw) {
    return { configured: false, host: null, port: null, pooled: false, supabaseDirect: false };
  }
  try {
    const url = new URL(raw);
    return {
      configured: true,
      host: url.hostname || null,
      port: url.port || null,
      pooled: url.hostname.endsWith('pooler.supabase.com'),
      supabaseDirect: /^db\..+\.supabase\.co$/i.test(url.hostname),
    };
  } catch {
    return { configured: true, host: null, port: null, pooled: false, supabaseDirect: false };
  }
}

/**
 * Qué hacer con el fallo, en una frase accionable.
 *
 * Es lo que se enseña en la pantalla de error: el mensaje de Prisma en
 * producción es críptico y el alumno (o quien despliega) no tiene por qué
 * saber que `P2021` significa «faltan las tablas».
 */
export function databaseHint(detail: string, code?: string | null): string {
  const target = databaseTarget();
  const text = `${code ?? ''} ${detail}`.toLowerCase();

  if (!target.configured) {
    return 'No hay DATABASE_URL en el entorno de este despliegue. Añádela en Netlify → Site configuration → Environment variables y vuelve a desplegar.';
  }
  if (target.supabaseDirect) {
    return `DATABASE_URL apunta al host directo de Supabase (${target.host}). Las funciones de Netlify no tienen IPv6 y ese host solo responde por IPv6: usa la cadena del POOLER (aws-0-<región>.pooler.supabase.com:6543).`;
  }
  if (text.includes('prepared statement') || (target.pooled && text.includes('pgbouncer'))) {
    return 'La conexión pasa por pgbouncer pero Prisma no lo sabe: añade pgbouncer=true a DATABASE_URL (la app ya lo hace sola en el pooler de Supabase; comprueba el host).';
  }
  if (text.includes('unable to require') || text.includes('query engine') || text.includes('did not initialize')) {
    return 'El motor de Prisma no ha viajado al despliegue: el build debe ejecutar `prisma generate` (npm run build ya lo hace) y el binario debe ser rhel-openssl-3.0.x en Netlify.';
  }
  if (code === 'P1001' || text.includes("can't reach database server")) {
    return 'El servidor de la base no es alcanzable desde Netlify: revisa el host y el puerto (pooler 6543), que el proyecto de Supabase no esté pausado y que la IP no esté restringida.';
  }
  if (code === 'P1000' || text.includes('authentication failed')) {
    return 'Usuario o contraseña incorrectos en DATABASE_URL. Si la contraseña tiene caracteres especiales (@, #, /), van escapados en la URL.';
  }
  if (code === 'P2021' || code === 'P2010' || text.includes('does not exist')) {
    return 'La base responde pero faltan las tablas: aplica las migraciones con `npx prisma migrate deploy` usando la conexión directa (5432) de Supabase.';
  }
  if (text.includes('timeout') || code === 'P1008') {
    return 'La conexión se agota: con serverless, usa la URL del POOLER de Supabase (puerto 6543) con connection_limit=1 y comprueba que el proyecto no esté pausado.';
  }
  return 'Revisa el detalle de arriba y el parte de /api/salud.';
}
