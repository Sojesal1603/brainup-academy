/**
 * Las direcciones de este ordenador en la red local (para abrirlo desde el móvil).
 *
 * El problema que resuelve: en el PC la app se abre en `localhost:3000`, pero
 * `localhost`, en el móvil, es el propio móvil. Para abrirla desde fuera hace
 * falta la dirección que este ordenador tiene **en la red de casa**, y esa
 * dirección no es fija: el router la reparte por DHCP y cada red usa su rango (en
 * el log de esta app se han visto 192.168.1.135, 192.168.1.43, 192.168.1.149 y
 * 172.16.0.2, según el día y la red). Por eso no vale apuntar una a mano: hay que
 * preguntárselo al sistema, que es quien lo sabe.
 *
 * Lo que se devuelve, por cada conexión:
 *   - `nombre`    cómo llama Windows a esa conexión («Wi-Fi», «Ethernet»,
 *                 «OpenVPN TAP-Windows6»…), que es lo que permite elegir la buena.
 *   - `direccion` la IPv4 de este ordenador en esa conexión.
 *   - `virtual`   true si la conexión es de mentira (VPN, máquina virtual, WSL,
 *                 Bluetooth): existe, pero desde el móvil no lleva a casa.
 *
 * Se ordena dejando primero las conexiones de verdad, y dentro de cada grupo se
 * respeta el orden que da el sistema (`sort` en Node es estable).
 *
 * Sin dependencias: solo `os`.
 */
const os = require('os');

/** Conexiones que existen en el sistema pero no llevan a la red de casa. */
const VIRTUAL = /virtual|vmware|vbox|hyper-?v|wsl|docker|loopback|bluetooth|tap|tun|vpn|hamachi|radmin|zerotier|tailscale|npcap|teredo|isatap|oracle/i;

/** Las direcciones que Windows se pone solo cuando no hay red no valen para nada. */
const SIN_RED = /^169\.254\./;

function direccionesLocales() {
  const salida = [];
  const interfaces = os.networkInterfaces();

  for (const nombre of Object.keys(interfaces)) {
    const direcciones = interfaces[nombre] || [];
    const virtual = VIRTUAL.test(nombre);

    for (const dir of direcciones) {
      if (dir.family !== 'IPv4' || dir.internal) continue;
      if (SIN_RED.test(dir.address)) continue;
      salida.push({ nombre, direccion: dir.address, virtual });
    }
  }

  return salida.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

/**
 * El puerto en el que escucha la app.
 *
 * Es el mismo `PORT` que usa `scripts/sirve.js` y con la misma precaución: un
 * `PORT` vacío no es 3000, es 0 (un puerto libre al azar), así que se valida.
 */
function puertoLocal() {
  const bruto = Number(process.env.PORT);
  return Number.isFinite(bruto) && bruto > 0 ? bruto : 3000;
}

/** La dirección tal y como se teclea en el navegador del móvil. */
function urlMovil(direccion, puerto = puertoLocal()) {
  return `http://${direccion}:${puerto}`;
}

module.exports = { direccionesLocales, puertoLocal, urlMovil };
