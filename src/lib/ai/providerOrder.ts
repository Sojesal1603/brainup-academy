import { db } from '../db';
import { providerIds } from './providers';
import { invalidateUserAiProfile } from './profileCache';

/**
 * Orden explícito de proveedores del alumno.
 *
 * Vive en `UserProfile.providerOrderJson` (`["groq","gemini"]`). El router lo
 * usa como primera clave de orden y solo dentro de las claves del propio
 * alumno. La lectura tolera que la migración aún no esté aplicada (P2022):
 * devuelve el orden del catálogo en vez de tumbar la app. La escritura sí
 * falla con un mensaje de producto si falta la columna.
 */

const MAX_ORDER = 20;

export function sanitizeProviderOrder(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  const known = new Set(providerIds());
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const value of values) {
    const id = String(value ?? '').trim().toLowerCase();
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
    if (clean.length >= MAX_ORDER) break;
  }
  return clean;
}

function isMissingColumn(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: string }).code === 'P2022' ||
      /does not exist|no existe|unknown column/i.test(String((error as { message?: string }).message ?? '')))
  );
}

export async function readProviderOrder(userId: string): Promise<string[]> {
  try {
    const row = await db(userId).userProfile.findUnique({
      where: { id: userId },
      select: { providerOrderJson: true },
    });
    return sanitizeProviderOrder(row?.providerOrderJson ?? []);
  } catch (error) {
    if (isMissingColumn(error)) return [];
    throw error;
  }
}

export async function saveProviderOrder(userId: string, order: unknown): Promise<string[]> {
  const clean = sanitizeProviderOrder(order);
  try {
    await db(userId).userProfile.update({
      where: { id: userId },
      data: { providerOrderJson: JSON.stringify(clean) },
    });
  } catch (error) {
    if (isMissingColumn(error)) {
      throw new Error(
        'El orden de proveedores todavía no está disponible en esta instalación. Aplica la migración de la Fase 3 y vuelve a intentarlo.'
      );
    }
    throw error;
  }
  // El perfil cacheado lleva el orden anterior: la siguiente petición lee el
  // nuevo sin esperar al TTL.
  invalidateUserAiProfile(userId);
  return clean;
}
