'use client';

import { useEffect } from 'react';
import { Printer } from 'lucide-react';

/**
 * Botón de imprimir de la vista de apuntes.
 *
 * Hace una cosa más que `window.print()`: los bloques de **Active Recall** del
 * cuaderno son `<details>` y, cerrados, su contenido no llega al papel (el
 * navegador no los pinta). Al montar la vista se abren todos para que la
 * impresión salga completa y no a medias.
 */
export default function PrintButton() {
  useEffect(() => {
    document.querySelectorAll('.apunte-print details').forEach((node) => {
      node.setAttribute('open', '');
    });
  }, []);

  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 transition-all hover:bg-emerald-400 print:hidden"
    >
      <Printer className="h-4 w-4" />
      <span>Imprimir</span>
    </button>
  );
}
