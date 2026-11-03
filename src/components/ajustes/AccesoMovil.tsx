import { Smartphone, ShieldAlert } from 'lucide-react';
import { direccionesLocales, puertoLocal, urlMovil } from '@/lib/redLocal';

/**
 * «Usarlo desde el móvil», con la dirección de hoy.
 *
 * Nada de esto se adivina: las direcciones salen del sistema operativo en cada
 * carga de la página (por eso se ve siempre la buena, aunque el router la haya
 * cambiado hoy) y lo que desde el ordenador no se puede comprobar —el cortafuegos
 * de Windows— se dice tal cual, con la regla que lo resuelve, en vez de prometer
 * que funcionará.
 */
export default function AccesoMovil() {
  const puerto = puertoLocal();
  const redes = direccionesLocales();
  const deVerdad = redes.filter((red) => !red.virtual);
  const utiles = deVerdad.length > 0 ? deVerdad : redes;

  return (
    <div className="p-6 rounded-2xl glass-card space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
          <Smartphone className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-slate-100">Usarlo desde el móvil</h3>
          <p className="text-xs text-slate-400">
            Con el móvil en la misma Wi-Fi, la app se abre desde su navegador como una página más.
            La dirección cambia con la red, así que esta es la de ahora mismo.
          </p>
        </div>
      </div>

      {utiles.length === 0 ? (
        <p className="text-xs text-slate-400">
          Este ordenador no está conectado a ninguna red ahora mismo: conéctalo a la Wi-Fi y recarga
          esta página.
        </p>
      ) : (
        <div className="space-y-2">
          {utiles.map((red) => (
            <div
              key={`${red.nombre}-${red.direccion}`}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-[#080d18] px-3 py-2.5"
            >
              <code className="font-mono text-sm font-bold text-emerald-300">
                {urlMovil(red.direccion, puerto)}
              </code>
              <span className="text-[10px] uppercase tracking-wider text-slate-500">
                {red.nombre}
                {red.virtual ? ' · VPN o máquina virtual, probablemente no sirve' : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      <ol className="space-y-2 text-xs text-slate-300">
        <li className="flex items-start gap-2">
          <span className="w-5 h-5 shrink-0 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px]">
            1
          </span>
          <span>
            Deja el ordenador encendido y la app en marcha (
            <code className="text-emerald-300">npm run sirve</code>; si instalaste el arranque
            automático, ya lo estará).
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="w-5 h-5 shrink-0 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px]">
            2
          </span>
          <span>
            En el móvil, en la <strong>misma Wi-Fi</strong>, teclea esa dirección en el navegador.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="w-5 h-5 shrink-0 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px]">
            3
          </span>
          <span>
            Para tenerlo a un toque: en Safari, <em>Compartir → Añadir a la pantalla de inicio</em>;
            en Chrome (Android), menú <strong>⋮</strong> →{' '}
            <em>Añadir a la pantalla de inicio</em>. Sobre <code>http://</code> el navegador no deja
            instalarla como app de verdad: eso necesita HTTPS.
          </span>
        </li>
      </ol>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5 space-y-2">
        <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-amber-300">
          <ShieldAlert className="w-3.5 h-3.5" />
          Si el móvil no abre la página
        </p>
        <p className="text-[11px] leading-relaxed text-slate-300">
          Casi siempre es el <strong>cortafuegos de Windows</strong>, que deja entrar al móvil solo
          si se le dice una vez. En un <strong>PowerShell como administrador</strong>:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-[#080d18] border border-slate-800 p-2.5 text-[10px] leading-relaxed text-emerald-300">
          {`New-NetFirewallRule -DisplayName "BrainUp Academy (movil)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${puerto} -Profile Private`}
        </pre>
        <p className="text-[11px] leading-relaxed text-slate-400">
          Y si tu Wi-Fi figura como red <strong>pública</strong>, Windows la bloquea igual: pásala a{' '}
          <strong>privada</strong>. Esto es solo para la red de casa, y la app no tiene contraseña:
          si prefieres que no se vea desde fuera, pon <code>BRAINUP_HOST=127.0.0.1</code> en{' '}
          <code>.env</code> y reinicia con <code>npm run sirve</code>.
        </p>
      </div>
    </div>
  );
}
