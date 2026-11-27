'use client';

import { useEffect, useState } from 'react';

/**
 * Una fecha formateada para el alumno, sin romper la hidratación.
 *
 * El problema que resuelve: un componente cliente se renderiza DOS veces, una
 * en el servidor (Vercel, en UTC) y otra en el navegador (la zona del alumno).
 * `toLocaleDateString('es-ES', …)` sobre el mismo instante da días distintos en
 * cuanto la hora cae cerca de medianoche, y React se encuentra un texto que no
 * coincide con el HTML recibido: aviso de hidratación (#418) y subárbol
 * regenerado, que es justo lo que hacía que un panel «parpadeara» al cargar.
 *
 * La solución es el patrón de montaje, pero encapsulado una sola vez: el
 * servidor y el primer render del cliente pintan una etiqueta **determinista**
 * (la del instante en UTC, calculada con `getUTC*`, sin `Intl`), y solo cuando
 * el componente ya está montado se sustituye por la fecha local. Como el primer
 * render de ambos lados coincide, no hay nada que comparar mal.
 *
 * Los formatos son presets a propósito: `Intl.DateTimeFormatOptions` es un
 * objeto y, si se pasara desde el padre, tendría una identidad nueva en cada
 * render y el efecto se dispararía sin parar. Con un `string` la dependencia es
 * por valor.
 */

const SHORT_MONTHS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

const LONG_MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

export type ClientDateFormat = 'short' | 'long' | 'datetime' | 'full';

/** `null` = `toLocaleString()` sin opciones (fecha y hora completas). */
const PRESETS: Record<ClientDateFormat, Intl.DateTimeFormatOptions | null> = {
  short: { day: 'numeric', month: 'short' },
  long: { day: 'numeric', month: 'long', year: 'numeric' },
  datetime: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
  full: null,
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Etiqueta estable en UTC. No usa `Intl` ni la zona del proceso a propósito:
 * el servidor y el navegador tienen que producir exactamente el mismo texto.
 */
function stableLabel(iso: string, format: ClientDateFormat): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const day = date.getUTCDate();
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

  switch (format) {
    case 'long':
      return `${day} de ${LONG_MONTHS[month]} de ${year}`;
    case 'datetime':
      return `${day} ${SHORT_MONTHS[month]}, ${time}`;
    case 'full':
      return `${day} ${SHORT_MONTHS[month]} ${year}, ${time}`;
    case 'short':
    default:
      return `${day} ${SHORT_MONTHS[month]}`;
  }
}

export interface ClientDateProps {
  /**
   * Instante tal y como llega del servidor: cadena ISO 8601 o `Date` (React
   * conserva los `Date` al serializar el payload de los Server Components).
   */
  iso: string | Date | null | undefined;
  /** Preset de formato (nunca un objeto de opciones: rompería el efecto). */
  format?: ClientDateFormat;
  /** Texto si no hay fecha o es inválida. Por defecto, vacío. */
  emptyText?: string;
  className?: string;
}

/** Normaliza el valor recibido a cadena ISO (o `null` si no es utilizable). */
function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

export default function ClientDate({
  iso,
  format = 'short',
  emptyText = '',
  className,
}: ClientDateProps) {
  /** `null` = todavía no se ha montado: se pinta la etiqueta estable. */
  const [localized, setLocalized] = useState<string | null>(null);
  const value = toIso(iso);

  useEffect(() => {
    if (!value) {
      setLocalized(null);
      return;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      setLocalized(null);
      return;
    }
    const options = PRESETS[format];
    setLocalized(
      options ? date.toLocaleDateString('es-ES', options) : date.toLocaleString('es-ES')
    );
  }, [value, format]);

  if (!value) return <>{emptyText}</>;

  return <span className={className}>{localized ?? stableLabel(value, format)}</span>;
}
