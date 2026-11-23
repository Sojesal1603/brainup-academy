'use client';

import { useEffect } from 'react';

/**
 * Borra del navegador lo que quedó de la cuenta anterior.
 *
 * El problema que resuelve: la sesión de Supabase es una cookie, pero la app
 * también guarda estado en `localStorage` (la sesión de Enfoque activa, el
 * borrador de un examen PAU, los descartes del día, el chequeo de clase). Esas
 * claves no distinguen de quién son: en un equipo compartido, o al cambiar de
 * cuenta sin cerrar el navegador, la cuenta nueva hereda la sesión de Enfoque de
 * la anterior y el servidor se la apunta a ella. Eso es exactamente «datos de
 * una cuenta en la sesión de otra», aunque no vengan de PostgreSQL.
 *
 * La regla: el navegador recuerda con qué UUID se escribió ese estado. Si al
 * cargar la app el UUID no coincide (o no hay sesión), se borra todo lo que
 * empieza por `brainup` y se vuelve a marcar el dueño actual.
 */
const OWNER_KEY = 'brainup.sessionOwner';

/** Prefijo común de las claves del navegador (`brainup.focusSession`, `brainup-pau-…`). */
const APP_PREFIX = 'brainup';

function wipeAppStorage(): void {
  try {
    const doomed: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(APP_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    // Modo privado estricto o permisos denegados: sin almacén no hay nada que limpiar.
  }
}

export default function SessionStorageGuard({ userId }: { userId: string | null }) {
  useEffect(() => {
    try {
      const owner = window.localStorage.getItem(OWNER_KEY);

      // Sin sesión: si alguien había entrado, su estado no puede quedarse ahí.
      if (!userId) {
        if (owner) wipeAppStorage();
        return;
      }

      if (owner !== userId) {
        // Cambio de cuenta (o primer arranque con esta cuenta): se empieza limpio.
        if (owner) wipeAppStorage();
        window.localStorage.setItem(OWNER_KEY, userId);
      }
    } catch {
      // Sin localStorage la app funciona igual; solo se pierde el borrador local.
    }
  }, [userId]);

  return null;
}
