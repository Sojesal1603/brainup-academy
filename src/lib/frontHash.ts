/**
 * Huella estable del enunciado de una tarjeta.
 *
 * Dos tarjetas son «la misma pregunta» aunque lleguen con otro maquetado:
 * mayúsculas distintas, espacios de más o puntuación final cambiada. La huella
 * se calcula aquí, en un módulo puro, para que el servidor y las pruebas usen
 * exactamente la misma función (nada de `crypto`, que no existe en el cliente).
 *
 * No es criptográfica: solo tiene que repartir bien y ser reproducible.
 */

/** Quita acentos, unifica espacios y recorta el texto para comparar. */
export function normalizeFront(front: string): string {
  return front
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/** FNV-1a de 32 bits en hexadecimal: 8 caracteres, estable entre procesos. */
export function frontHash(front: string): string {
  const text = normalizeFront(front);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // El desplazamiento con multiplicación evita depender de `Math.imul`.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
