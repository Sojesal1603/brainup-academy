/**
 * «Lo abro en el móvil»: la dirección exacta, y comprobada.
 *
 * Uso: npm run movil
 *
 * Qué hace, en este orden:
 *   1. Pregunta al sistema las direcciones de este ordenador en la red local
 *      (`red-local.js`) y enseña la que se teclea en el móvil, señalando las VPN
 *      y los adaptadores de máquinas virtuales, que existen pero no llevan a casa.
 *   2. Comprueba que la app responde: primero en este mismo ordenador y después en
 *      cada dirección de red. Así se distingue «la app no está en marcha» de «está
 *      en marcha pero solo escucha en este ordenador», que se arreglan distinto.
 *   3. Deja escrito lo que queda si el móvil no abre la página: el cortafuegos de
 *      Windows (una regla, una sola vez) y la Wi-Fi (tiene que ser la misma).
 *
 * Lo que NO puede comprobar, y se dice en pantalla: si el cortafuegos deja entrar
 * al móvil. La petición que sale de este ordenador hacia su propia dirección no
 * pasa por el cortafuegos, así que aquí puede estar todo bien y el móvil seguir sin
 * ver la app. Por eso el comando de la regla se imprime siempre.
 *
 * Termina con 0 si la app contesta en al menos una dirección de la red, y con 1 si
 * no contesta (para poder usarlo desde una verificación sin leer el texto).
 */
const { direccionesLocales, puertoLocal, urlMovil } = require('./red-local');

/** Tope de espera de cada comprobación: si no contesta en este rato, no contesta. */
const ESPERA_MS = 2500;

async function contesta(url) {
  try {
    const res = await fetch(`${url}/api/salud`, { signal: AbortSignal.timeout(ESPERA_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const puerto = puertoLocal();
  const aqui = urlMovil('127.0.0.1', puerto);

  const appViva = await contesta(aqui);

  const redes = [];
  for (const red of direccionesLocales()) {
    const url = urlMovil(red.direccion, puerto);
    redes.push({ ...red, url, responde: appViva ? await contesta(url) : false });
  }

  console.log('');
  console.log('  BrainUp Academy · para abrirlo en el móvil');
  console.log('  ─────────────────────────────────────────');

  if (!appViva) {
    console.log('  La app NO responde en este ordenador, así que el móvil tampoco la va a ver.');
    console.log('  Arráncala (vigilada: se levanta sola si se cae) y vuelve a preguntar:');
    console.log('');
    console.log('      npm run sirve');
    console.log('');
    process.exit(1);
  }

  if (redes.length === 0) {
    console.log('  La app está en marcha, pero este ordenador no está conectado a ninguna');
    console.log('  red: sin Wi-Fi no hay móvil. Conéctalo y vuelve a preguntar.');
    console.log('');
    process.exit(1);
  }

  console.log(`  La app está en marcha (puerto ${puerto}). Esto se teclea en el navegador del`);
  console.log('  móvil, con el móvil en la MISMA Wi-Fi que este ordenador:');
  console.log('');

  for (const red of redes) {
    const escucha = red.responde ? 'la app escucha aquí' : 'la app NO escucha aquí';
    const aviso = red.virtual ? '  ← probablemente no sirve (VPN o máquina virtual)' : '';
    console.log(`    ${red.url.padEnd(28)} ${red.nombre} · ${escucha}${aviso}`);
  }

  const sirven = redes.filter((red) => red.responde && !red.virtual);

  if (sirven.length === 0) {
    console.log('');
    console.log('  La app no contesta en ninguna dirección de la red, así que el móvil no la verá.');
    console.log('  Lo más probable es que el servidor en marcha se esté escuchando solo en este');
    console.log('  ordenador (una versión de antes, o arrancado a mano con `-H 127.0.0.1`).');
    console.log('  Reinícialo con `npm run sirve`, que la abre a la red de casa:');
    console.log('');
    console.log('      npm run sirve -- --stop');
    console.log('      npm run sirve');
    console.log('');
    process.exit(1);
  }

  console.log('');
  console.log('  Pasos en el móvil:');
  console.log('    1. Comprueba que está en la misma Wi-Fi (si va por datos, no llega).');
  console.log('    2. Teclea la dirección de arriba en el navegador.');
  console.log('    3. Para tenerlo a un toque: «Añadir a la pantalla de inicio».');
  console.log('');
  console.log('  Si el móvil no abre la página y en el PC sí funciona, casi siempre es el');
  console.log('  cortafuegos de Windows, que deja entrar al móvil solo si se le dice una vez.');
  console.log('  En un PowerShell COMO ADMINISTRADOR:');
  console.log('');
  console.log(
    `    New-NetFirewallRule -DisplayName "BrainUp Academy (movil)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${puerto} -Profile Private`
  );
  console.log('');
  console.log('  (Y para deshacerlo:');
  console.log('   Remove-NetFirewallRule -DisplayName "BrainUp Academy (movil)")');
  console.log('');
  console.log('  Si la Wi-Fi está marcada como red PÚBLICA, Windows la bloquea igual: pásala');
  console.log('  a privada en Configuración → Red e Internet → Wi-Fi.');
  console.log('');
  console.log('  Aviso honesto: esto no puede comprobar el cortafuegos desde aquí. La petición');
  console.log('  que sale de este ordenador hacia su propia dirección no pasa por él, así que');
  console.log('  «la app escucha aquí» solo dice que está abierta a la red. Quien lo sabe de');
  console.log('  verdad es el móvil.');
  console.log('');

  process.exit(0);
}

main().catch((error) => {
  console.error('No he podido averiguar la dirección:', error.message);
  process.exit(1);
});
