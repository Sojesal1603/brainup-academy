/**
 * La contraseña de Moodle, cifrada con la caja fuerte de la app.
 *
 * Antes del Paso 15 se cifraba con una clave que vivía en el disco del equipo
 * (`data/.clave-local`). Eso servía en un PC, pero no en serverless: cada
 * instancia tiene su propio disco, así que la contraseña guardada era ilegible
 * al desplegar. Ahora usa el vault (`src/lib/security/vault.ts`) con la misma
 * clave maestra que las claves de IA y un contexto por cuenta:
 *
 *     AAD = `<userId>:moodle`
 *
 * Copiar la fila cifrada de una cuenta a otra no sirve: el AAD no coincide y
 * GCM falla. Cambiar un solo byte del texto, del IV o del tag, tampoco.
 *
 * **Compatibilidad.** Los valores guardados con el cifrador local siguen
 * leyéndose: `readMoodlePassword` distingue ambos formatos por el separador
 * (`v1.iv.tag.ct` frente a `v1:iv:tag:ct`) y avisa con `needsReseal` para que
 * el llamador lo vuelva a guardar ya con el vault. Cuando ese re-cifrado se
 * completa, el valor viejo desaparece de la fila.
 */

import { decryptSecret, encryptSecret, vaultStatus } from './security/vault';
import { openLegacySecret } from './localSecrets';

export type SealedFormat = 'vault' | 'legacy' | 'unknown';

/** Contexto (AAD) del secreto de Moodle de una cuenta. */
export function moodleSecretAad(userId: string): string {
  return `${String(userId ?? '').trim()}:moodle`;
}

/**
 * Qué cifrador produjo el valor guardado. Es solo la forma, no una promesa de
 * que se pueda descifrar: eso lo dice `readMoodlePassword`.
 */
export function sealedFormat(value: string | null | undefined): SealedFormat {
  const raw = String(value ?? '').trim();
  if (!raw) return 'unknown';

  const vault = raw.split('.');
  if (vault.length === 4 && vault[0] === 'v1') return 'vault';

  const legacy = raw.split(':');
  if (legacy.length === 4 && legacy[0] === 'v1') return 'legacy';

  return 'unknown';
}

/**
 * Cifra la contraseña con el vault. Si falta `SECRETS_KEY_V1` lanza
 * `VaultError` con un mensaje que se puede enseñar tal cual: no se guarda nada
 * a medias ni se cae el proceso.
 */
export function sealMoodlePassword(userId: string, password: string): string {
  return encryptSecret(password, moodleSecretAad(userId));
}

export interface MoodlePasswordRead {
  /** La contraseña en claro, o `null` si no hay o no se pudo leer. */
  password: string | null;
  /** Hay que volver a guardarla: venía del cifrador local. */
  needsReseal: boolean;
  /** Había un valor guardado pero no se pudo descifrar (clave distinta o daño). */
  unreadable: boolean;
  format: SealedFormat;
}

/**
 * Lee la contraseña de Moodle sea cual sea el cifrador que la guardó.
 *
 * No lanza en el camino normal: un valor ilegible se trata como «no hay
 * contraseña», que es lo que hace la app para pedirla otra vez. El detalle de
 * por qué no se pudo leer (`unreadable`) queda para el diagnóstico.
 */
export function readMoodlePassword(
  userId: string,
  sealed: string | null | undefined
): MoodlePasswordRead {
  const raw = String(sealed ?? '').trim();
  const format = sealedFormat(raw);

  if (!raw) {
    return { password: null, needsReseal: false, unreadable: false, format: 'unknown' };
  }

  if (format === 'vault') {
    try {
      const password = decryptSecret(raw, moodleSecretAad(userId));
      return { password, needsReseal: false, unreadable: false, format };
    } catch {
      return { password: null, needsReseal: false, unreadable: true, format };
    }
  }

  if (format === 'legacy') {
    const password = openLegacySecret(raw);
    if (!password) {
      return { password: null, needsReseal: false, unreadable: true, format };
    }
    return {
      password,
      // Solo se re-cifra si el vault está listo; si no, se sigue leyendo el
      // valor antiguo y no se toca la fila.
      needsReseal: vaultStatus().ready,
      unreadable: false,
      format,
    };
  }

  return { password: null, needsReseal: false, unreadable: true, format: 'unknown' };
}
