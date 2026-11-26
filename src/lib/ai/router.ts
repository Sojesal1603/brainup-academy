import {
  modelCapabilities,
  supportsCapabilities,
  type ProviderCapabilities,
} from './providers';

/**
 * Router BYOK puro: decide **sin red y sin base de datos**.
 *
 * Recibe únicamente los modelos que salen de las credenciales activas del
 * alumno (el motor nunca le pasa el catálogo global) y devuelve:
 *
 *   - la cadena filtrada por las capacidades que exige el turno,
 *   - el campeón,
 *   - el hedge (otro proveedor del MISMO perfil),
 *   - qué capacidades faltan, para degradar antes de llamar.
 *
 * El orden es el del alumno; a igualdad, el orden de la cadena del motor
 * (salud de su cuenta + catálogo). Es determinista y se puede probar con
 * `verify:router`.
 */

export interface RoutableModel {
  provider: string;
  model: string;
  key?: string;
  /** Posición original en la cadena del motor; desempata de forma estable. */
  order?: number;
}

export interface RoutedModel extends RoutableModel {
  capabilities: ProviderCapabilities;
}

export interface RoutingPlan {
  ranked: RoutedModel[];
  champion: RoutedModel | null;
  /** Primer modelo de OTRO proveedor del perfil, solo si hay más de uno. */
  hedge: RoutedModel | null;
  /** Capacidades exigidas que NINGÚN modelo del perfil puede cubrir. */
  missing: Array<keyof ProviderCapabilities>;
  /** Hay modelos válidos, pero no cubren todo lo pedido. */
  degraded: boolean;
}

export interface RoutingRequest {
  models: RoutableModel[];
  required?: Partial<ProviderCapabilities>;
  /** Orden explícito del alumno, por id de proveedor. */
  providerOrder?: string[];
  /** Fuerza un proveedor concreto (comparativa de apuntes); nunca sale del perfil. */
  onlyProvider?: string | null;
}

function orderIndex(provider: string, order?: string[]): number {
  if (!order || order.length === 0) return Number.MAX_SAFE_INTEGER;
  const index = order.indexOf(provider);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function requiredKeys(required?: Partial<ProviderCapabilities>): Array<keyof ProviderCapabilities> {
  if (!required) return [];
  return (['vision', 'tools', 'json', 'streaming'] as const).filter((key) => required[key] === true);
}

/** Construye la cadena y elige campeón/hedge. */
export function planRoute(request: RoutingRequest): RoutingPlan {
  const required = request.required ?? {};
  const scopedModels = request.models.filter(
    (model) => !request.onlyProvider || model.provider === request.onlyProvider
  );
  const missing = requiredKeys(required).filter(
    (capability) =>
      !scopedModels.some((model) =>
        supportsCapabilities(model.provider, model.model, { [capability]: true })
      )
  );

  const candidates: RoutedModel[] = scopedModels
    .filter((model) => supportsCapabilities(model.provider, model.model, required))
    .map((model, index) => ({
      ...model,
      order: model.order ?? index,
      capabilities: modelCapabilities(model.provider, model.model),
    }));

  candidates.sort((a, b) => {
    const byProvider = orderIndex(a.provider, request.providerOrder) - orderIndex(b.provider, request.providerOrder);
    if (byProvider !== 0) return byProvider;
    return (a.order ?? 0) - (b.order ?? 0);
  });

  const champion = candidates[0] ?? null;
  const hedge =
    champion === null
      ? null
      : candidates.find((candidate) => candidate.provider !== champion.provider) ?? null;

  return {
    ranked: candidates,
    champion,
    hedge,
    missing,
    degraded: missing.length > 0,
  };
}

/** Etiqueta neutra de una capacidad, para mensajes de producto. */
function capabilityLabel(capability: keyof ProviderCapabilities): string {
  if (capability === 'vision') return 'leer imágenes o archivos escaneados';
  if (capability === 'tools') return 'usar herramientas estructuradas';
  if (capability === 'json') return 'devolver una respuesta estructurada';
  return 'emitir la respuesta por partes';
}

/**
 * Degradación honesta ANTES de llamar.
 *
 * No nombra proveedores ni modelos: el alumno lee qué no puede hacer su clave
 * y qué alternativa tiene. El detalle técnico se queda en el log interno.
 */
export function capabilityDegradationMessage(missing: Array<keyof ProviderCapabilities>): string {
  if (missing.length === 0) {
    return 'Tu clave de IA no puede atender este turno ahora mismo. Añade otra clave en Ajustes o inténtalo de nuevo en un minuto.';
  }
  const labels = missing.map(capabilityLabel);
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} ni ${labels[labels.length - 1]}`;
  return `Tu clave de IA actual no puede ${list}. Añade en Ajustes una clave que sí pueda, o envía el contenido como texto para que pueda ayudarte igual.`;
}
