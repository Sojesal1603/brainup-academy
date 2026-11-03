import os from 'node:os';

/**
 * Las direcciones de este ordenador en la red local, para poder abrir la app en el
 * móvil. Es la misma idea que `scripts/red-local.js` —el que usa la línea de
 * comandos (`npm run movil`) y el servidor vigilado al arrancar—, escrita aquí
 * para poder enseñarla dentro de la app, en Ajustes.
 *
 * Están en dos sitios a propósito: el script es CommonJS y se ejecuta con Node a
 * pelo; esto se compila con la app. La regla, en cambio, es exactamente la misma y
 * está escrita igual en los dos: primero las conexiones de verdad (Wi-Fi, cable) y
 * señaladas las que existen pero no llevan a casa (VPN, máquinas virtuales, WSL).
 *
 * Se calcula al vuelo en cada carga de la página (Ajustes es `force-dynamic`), que
 * es justo lo que hace falta: la dirección cambia cuando cambia la red y una
 * apuntada ayer hoy no lleva a ningún sitio.
 */

/** Conexiones que existen en el sistema pero no llevan a la red de casa. */
const VIRTUAL =
  /virtual|vmware|vbox|hyper-?v|wsl|docker|loopback|bluetooth|tap|tun|vpn|hamachi|radmin|zerotier|tailscale|npcap|teredo|isatap|oracle/i;

export interface DireccionLocal {
  /** Cómo llama Windows a esa conexión («Wi-Fi», «Ethernet», «OpenVPN…»). */
  nombre: string;
  /** La IPv4 de este ordenador en esa conexión. */
  direccion: string;
  /** true si es de mentira (VPN, máquina virtual): desde el móvil no lleva a casa. */
  virtual: boolean;
}

export function direccionesLocales(): DireccionLocal[] {
  const salida: DireccionLocal[] = [];
  const interfaces = os.networkInterfaces();

  for (const [nombre, direcciones] of Object.entries(interfaces)) {
    const virtual = VIRTUAL.test(nombre);

    for (const dir of direcciones ?? []) {
      if (dir.family !== 'IPv4' || dir.internal) continue;
      // 169.254.x.x es lo que Windows se pone solo cuando no hay red.
      if (dir.address.startsWith('169.254.')) continue;
      salida.push({ nombre, direccion: dir.address, virtual });
    }
  }

  return salida.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

/** El puerto en el que escucha la app (el mismo que usa el servidor vigilado). */
export function puertoLocal(): number {
  const bruto = Number(process.env.PORT);
  return Number.isFinite(bruto) && bruto > 0 ? bruto : 3000;
}

/** La dirección tal y como se teclea en el navegador del móvil. */
export function urlMovil(direccion: string, puerto = puertoLocal()): string {
  return `http://${direccion}:${puerto}`;
}
