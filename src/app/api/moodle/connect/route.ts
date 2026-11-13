import { NextResponse } from 'next/server';
import { MoodleError } from '@/lib/moodleWs';
import { connectMoodleAnyWay } from '@/lib/moodleSync';
import { disconnectMoodle, getMoodleStatus } from '@/lib/moodleWsSync';
import { requireUser } from '@/lib/auth';

/**
 * Conectar y desconectar Moodle.
 *
 * Este endpoint acepta las dos puertas que tiene Moodle y decide por sí solo cuál
 * puede usar:
 *
 *   - `{ baseUrl, token }`: el alumno ha creado la clave en su perfil y la pega.
 *   - `{ baseUrl, username, password }`: primero se le pide la clave a Moodle con
 *     sus datos de siempre (`login/token.php`); si su centro no deja, se entra
 *     **por sesión web** con esos mismos datos (la puerta del navegador). Con
 *     `savePassword: false` no se guarda la contraseña y habrá que repetirla otro
 *     día; por defecto se guarda **cifrada** con la clave local del equipo.
 *
 * Ni la clave ni la contraseña salen de aquí: la respuesta solo devuelve el
 * nombre del sitio, tu usuario, cuántas funciones trae la clave (si se ha podido
 * usar) y por qué no se ha podido, si ha hecho falta entrar por sesión.
 */

interface ConnectBody {
  baseUrl?: unknown;
  token?: unknown;
  username?: unknown;
  password?: unknown;
  savePassword?: unknown;
}

export async function POST(request: Request) {
  const user = await requireUser();
  let body: ConnectBody;
  try {
    body = (await request.json()) as ConnectBody;
  } catch {
    body = {};
  }

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
  const token = typeof body.token === 'string' ? body.token : '';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const savePassword = body.savePassword !== false;

  // Si vienen usuario o contraseña, esta es la vía elegida: entrar con los datos
  // de acceso. Si no, la de la clave pegada a mano.
  const byPassword = username.length > 0 || password.length > 0;

  if (!baseUrl.trim() || (byPassword ? !username || !password : !token.trim())) {
    return NextResponse.json(
      {
        error: byPassword
          ? 'Hacen falta la dirección de tu Moodle, tu usuario y tu contraseña.'
          : 'Hacen falta la dirección de tu Moodle y la clave de seguridad.',
      },
      { status: 400 }
    );
  }

  try {
    const outcome = await connectMoodleAnyWay(user.id, {
      baseUrl,
      token,
      username,
      password,
      sealPassword: savePassword,
    });

    const status = await getMoodleStatus(user.id);
    return NextResponse.json({
      ok: true,
      via: outcome.via,
      /** Por qué no se ha podido usar la clave (solo si ha entrado por sesión). */
      tokenTrouble: outcome.tokenTrouble,
      site: {
        siteName: outcome.siteName,
        userName: outcome.userName,
        functionCount: outcome.functionCount,
      },
      status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error inesperado al conectar con Moodle.';
    const code = error instanceof MoodleError ? error.code : 'unknown';
    // Nunca se registra la contraseña: solo el motivo.
    console.error('[moodle] conexión fallida:', code);
    return NextResponse.json({ error: message, code }, { status: 502 });
  }
}

export async function DELETE() {
  const user = await requireUser();
  await disconnectMoodle(user.id);
  const status = await getMoodleStatus(user.id);
  return NextResponse.json({ ok: true, status });
}

export async function GET() {
  const user = await requireUser();
  const status = await getMoodleStatus(user.id);
  return NextResponse.json({ ok: true, status });
}
