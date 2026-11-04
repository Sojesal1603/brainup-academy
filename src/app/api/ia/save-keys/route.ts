import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

/**
 * Guardar claves de IA en el `.env` del equipo.
 *
 * Dos cosas que estaban mal y se arreglan aquí:
 *
 * 1. **Solo claves de IA.** Antes se aceptaba cualquier nombre con forma de
 *    variable de entorno, así que un POST podía reescribir `DATABASE_URL`,
 *    `NODE_TLS_REJECT_UNAUTHORIZED` o cualquier secreto del `.env`. Ahora hay
 *    una lista blanca y lo que no esté en ella se ignora.
 * 2. **En Netlify no hay `.env`.** El sistema de archivos de una función es de
 *    solo lectura: el intento acababa en un 500 con el error crudo de Node. Se
 *    detecta antes y se explica dónde se ponen las variables de verdad.
 */

/** Lo único que este formulario puede tocar. */
const ALLOWED_ENV_VARS = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY_2',
  'GEMINI_API_KEY_3',
  'GEMINI_API_KEY_4',
  'GROQ_API_KEY',
  'GROQ_API_KEY_2',
  'GROQ_API_KEY_3',
  'GROQ_API_KEY_4',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY_2',
  'OPENROUTER_API_KEY_3',
  'OPENROUTER_API_KEY_4',
  'OLLAMA_BASE_URL',
  'OLLAMA_ENABLED',
  'AI_PROVIDER',
  'GEMINI_MODEL',
  'GROQ_MODEL',
  'OPENROUTER_MODEL',
]);

/** ¿El proceso corre en un host donde el disco no se puede escribir? */
function isReadOnlyHost(): boolean {
  return Boolean(
    process.env.NETLIFY ||
      process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.AWS_EXECUTION_ENV
  );
}

export async function POST(request: Request) {
  let body: { keys?: Record<string, string> };
  try {
    body = (await request.json()) as { keys?: Record<string, string> };
  } catch {
    return NextResponse.json({ ok: false, error: 'JSON inválido' }, { status: 400 });
  }

  const keys = body.keys;
  if (!keys || typeof keys !== 'object') {
    return NextResponse.json({ ok: false, error: 'Faltan las claves' }, { status: 400 });
  }

  if (isReadOnlyHost()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'En este despliegue no existe un archivo .env editable: las variables se ponen en el panel del hosting (Netlify → Site configuration → Environment variables) y se aplican al volver a desplegar.',
      },
      { status: 409 }
    );
  }

  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const lines = envContent.split(/\r?\n/);
    const updatedKeys: string[] = [];
    const ignoredKeys: string[] = [];

    for (const [rawName, rawVal] of Object.entries(keys)) {
      const name = rawName.trim();
      const value = String(rawVal ?? '').trim();

      // Nada fuera de la lista blanca: ni base de datos, ni TLS, ni secretos.
      if (!ALLOWED_ENV_VARS.has(name)) {
        ignoredKeys.push(name);
        continue;
      }
      // Un salto de línea partiría el archivo y podría inyectar variables.
      if (/[\r\n]/.test(value)) {
        continue;
      }
      const safeValue = value.replace(/"/g, '');

      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(`${name}=`)) {
          lines[i] = `${name}="${safeValue}"`;
          found = true;
          break;
        }
      }

      if (!found && safeValue) {
        lines.push(`${name}="${safeValue}"`);
      }

      // Se aplica también al proceso en marcha, para que no haga falta reiniciar
      // para probar la clave que se acaba de pegar.
      if (safeValue) {
        process.env[name] = safeValue;
      } else {
        delete process.env[name];
      }
      updatedKeys.push(name);
    }

    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');

    return NextResponse.json({
      ok: true,
      message: 'Variables guardadas correctamente en .env',
      updatedKeys,
      ...(ignoredKeys.length > 0
        ? { ignoredKeys, note: 'Solo se pueden guardar claves del motor de IA.' }
        : {}),
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Este entorno no permite escribir el .env (sistema de archivos de solo lectura). Pon las claves en las variables de entorno del hosting.',
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
