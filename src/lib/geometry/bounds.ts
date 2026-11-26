/**
 * Cálculo del `viewBox` de una figura.
 *
 * El motor no confía en el tamaño que pida el modelo: mide las primitivas que
 * ha producido la construcción y añade margen. Así ninguna figura sale
 * recortada, aunque las coordenadas sean negativas o la construcción crezca.
 */
import type { GeometryPrimitive, VisualViewBox } from './types';

interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const PADDING = 34;
const MIN_WIDTH = 220;
const MIN_HEIGHT = 170;

function include(extent: Extent, x: number, y: number): void {
  extent.minX = Math.min(extent.minX, x);
  extent.minY = Math.min(extent.minY, y);
  extent.maxX = Math.max(extent.maxX, x);
  extent.maxY = Math.max(extent.maxY, y);
}

function includeRadius(extent: Extent, center: readonly [number, number], radius: number): void {
  include(extent, center[0] - radius, center[1] - radius);
  include(extent, center[0] + radius, center[1] + radius);
}

/**
 * Calcula la caja de todas las primitivas. Las cotas se incluyen con su
 * desplazamiento para que la línea de cota no toque el borde.
 */
export function computeViewBox(primitives: readonly GeometryPrimitive[]): VisualViewBox {
  const extent: Extent = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };

  for (const primitive of primitives) {
    switch (primitive.type) {
      case 'point':
      case 'label':
        include(extent, primitive.at[0], primitive.at[1]);
        break;
      case 'segment':
      case 'dimension':
        include(extent, primitive.from[0], primitive.from[1]);
        include(extent, primitive.to[0], primitive.to[1]);
        if (primitive.type === 'dimension') {
          const offset = primitive.offset ?? 20;
          const dx = primitive.to[0] - primitive.from[0];
          const dy = primitive.to[1] - primitive.from[1];
          const length = Math.hypot(dx, dy);
          if (length > 1e-7) {
            const nx = (-dy / length) * offset;
            const ny = (dx / length) * offset;
            include(extent, primitive.from[0] + nx, primitive.from[1] + ny);
            include(extent, primitive.to[0] + nx, primitive.to[1] + ny);
          }
        }
        break;
      case 'circle':
      case 'arc':
        includeRadius(extent, primitive.center, primitive.radius);
        break;
      case 'polygon':
        for (const vertex of primitive.points) include(extent, vertex[0], vertex[1]);
        break;
      case 'angle':
        include(extent, primitive.vertex[0], primitive.vertex[1]);
        include(extent, primitive.from[0], primitive.from[1]);
        include(extent, primitive.to[0], primitive.to[1]);
        break;
      default:
        break;
    }
  }

  if (!Number.isFinite(extent.minX) || !Number.isFinite(extent.minY)) {
    return { x: -110, y: -85, width: 220, height: 170 };
  }

  const rawWidth = Math.max(extent.maxX - extent.minX, 0);
  const rawHeight = Math.max(extent.maxY - extent.minY, 0);
  const extraWidth = Math.max(0, (MIN_WIDTH - rawWidth) / 2);
  const extraHeight = Math.max(0, (MIN_HEIGHT - rawHeight) / 2);

  const minX = extent.minX - PADDING - extraWidth;
  const minY = extent.minY - PADDING - extraHeight;
  const width = rawWidth + (PADDING + extraWidth) * 2;
  const height = rawHeight + (PADDING + extraHeight) * 2;

  return {
    x: Math.round(minX * 1000) / 1000,
    y: Math.round(minY * 1000) / 1000,
    width: Math.round(width * 1000) / 1000,
    height: Math.round(height * 1000) / 1000,
  };
}
