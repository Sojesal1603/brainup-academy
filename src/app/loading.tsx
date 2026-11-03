/**
 * Estado de carga de la app.
 *
 * Sin este archivo, al pulsar una sección el navegador se queda en la página
 * anterior hasta que el servidor termina de renderizar la nueva: con consultas a
 * Prisma de por medio eso se siente como «se ha congelado». Aquí hay feedback
 * inmediato y honesto: no promete un porcentaje, solo dice que la vista está
 * llegando.
 *
 * Es un componente de servidor puro (ni estado ni efectos), así que no puede
 * quedarse atrapado en un bucle de cliente.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex min-h-[55vh] items-center justify-center p-6"
    >
      <div className="glass-card w-full max-w-sm space-y-4 p-6 text-center">
        <div className="relative mx-auto flex h-12 w-12 items-center justify-center">
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full border-2 border-emerald-400/20"
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full border-2 border-transparent border-t-emerald-400 motion-safe:animate-spin"
          />
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </div>

        <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-emerald-300">
          Cargando la vista
        </p>
        <p className="text-[11px] leading-relaxed text-slate-500">
          Preparando tus datos. Si tardara demasiado, recarga la página: no se pierde nada de lo que
          ya has hecho.
        </p>
      </div>
    </div>
  );
}
