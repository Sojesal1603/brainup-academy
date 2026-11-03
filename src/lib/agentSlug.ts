/**
 * El nombre de una materia convertido en una dirección que no caduca.
 *
 * Las URLs de los catedráticos llevaban el UUID del agente, y ese UUID cambia
 * cada vez que se vuelve a sembrar la base: el enlace que tenías guardado (o el
 * historial del navegador) apuntaba a un agente que ya no existía y la página
 * se quedaba en un 404. Con el nombre de la materia en la dirección, el enlace
 * sigue valiendo aunque la base se regenere.
 *
 * Es un módulo puro: sin base de datos y sin dependencias, para poder usarlo
 * igual en el servidor que en el cliente.
 */

/** «Catedrático de Lengua Castellana y Literatura I» → «catedratico-de-lengua-…». */
export function agentSlug(name: string): string {
  return String(name ?? '')
    .normalize('NFD')
    // Quita los acentos que la normalización ha separado de su letra.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** ¿El valor tiene la forma de un UUID (36 caracteres, con sus guiones)? */
export function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value ?? '').trim()
  );
}
