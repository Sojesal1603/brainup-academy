/**
 * Señal de «app lista» para la pantalla de carga inicial.
 *
 * La splash vive en el layout raíz y no tiene forma de saber cuándo ha
 * terminado la consulta del perfil: la cabecera la resuelve en un Server
 * Component aparte, dentro de su propio Suspense. Este módulo es el punto de
 * encuentro: la cabecera marca «listo» cuando ya tiene el perfil (o cuando ha
 * decidido que no hay perfil) y la splash se suscribe.
 *
 * Es estado de módulo, no de React: sobrevive a la navegación del cliente y se
 * reinicia en cada carga completa, que es justo cuando se monta la splash.
 */

type Listener = () => void;

let ready = false;
const listeners = new Set<Listener>();

export function markAppReady(): void {
  if (ready) return;
  ready = true;
  for (const listener of listeners) listener();
  listeners.clear();
}

export function isAppReady(): boolean {
  return ready;
}

/** Si ya estaba listo, avisa en el acto; si no, espera el aviso. */
export function subscribeAppReady(listener: Listener): () => void {
  if (ready) {
    listener();
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
