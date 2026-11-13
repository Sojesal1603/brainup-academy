import { NextResponse } from 'next/server';
import { MoodleError } from '@/lib/moodleWs';
import { syncMoodleAnyWay } from '@/lib/moodleSync';
import { MoodleSessionNotConnectedError } from '@/lib/moodleSessionSync';
import { MoodleNotConnectedError } from '@/lib/moodleWsSync';
import { requireUser } from '@/lib/auth';

/**
 * Sincroniza apuntes y tareas desde Moodle.
 *
 * La vía la decide la conexión guardada: con clave de Web Services se pregunta a
 * la API de Moodle; si el alumno está conectado con usuario y contraseña, se
 * entra por sesión web y se lee el HTML de sus cursos. Da igual cuál sea: lo que
 * queda en la base es lo mismo, porque el guardado es compartido.
 */
export async function POST() {
  try {
    const user = await requireUser();
    const { via, stats } = await syncMoodleAnyWay(user.id);
    return NextResponse.json({ ok: true, via, stats });
  } catch (error) {
    if (error instanceof MoodleNotConnectedError || error instanceof MoodleSessionNotConnectedError) {
      return NextResponse.json({ error: error.message, code: 'not_connected' }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : 'Error inesperado al sincronizar con Moodle.';
    const code = error instanceof MoodleError ? error.code : 'unknown';
    console.error('[moodle] sincronización fallida:', code);
    return NextResponse.json({ error: message, code }, { status: 502 });
  }
}
