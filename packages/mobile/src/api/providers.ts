import { requestJson } from './client';

/**
 * Los tres que el bridge registra al arrancar (`registerProvider` en
 * `packages/core/index.ts`). No hay endpoint que los liste, así que van aquí
 * escritos: una máquina que no tenga el CLI instalado falla al crear, y eso se
 * ve como error de la hoja, no como una lista vacía.
 */
export const PROVIDERS = ['claude', 'codex', 'opencode'] as const;

export type ProviderName = (typeof PROVIDERS)[number];

export interface ProviderModel {
  readonly id: string;
  readonly label: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Modelos que ese proveedor ofrece en esa máquina.
 *
 * Las tres respuestas traen `models: [{ id, label }]`; opencode añade
 * `providerName`, que va al principio de la etiqueta porque sin él la lista
 * tiene tres «Sonnet» distintos. Claude la devuelve vacía hasta que una sesión
 * suya ha arrancado al menos una vez en esa máquina — el bridge la toma del
 * SDK, no de una tabla — y eso no es un error: la hoja esconde el campo.
 */
export function fetchProviderModels(
  baseUrl: string,
  token: string,
  provider: ProviderName,
): Promise<ProviderModel[]> {
  return requestJson(
    baseUrl,
    `/providers/${provider}/info`,
    body => {
      const raw = asRecord(body);
      const models = raw?.models;
      if (!Array.isArray(models)) {
        return [];
      }
      return models.flatMap(item => {
        const model = asRecord(item);
        if (model === null || typeof model.id !== 'string') {
          return [];
        }
        const label = typeof model.label === 'string' ? model.label : model.id;
        const from =
          typeof model.providerName === 'string' ? model.providerName : '';
        return [{ id: model.id, label: from.length > 0 ? `${from} · ${label}` : label }];
      });
    },
    token,
  );
}

/**
 * Subcarpetas de `path`. La barra final es obligatoria: sin ella el bridge lo
 * lee como «hermanas que empiezan por…» en vez de «lo que hay dentro».
 *
 * Se salta `node_modules`, `.git`, `dist` y compañía del lado del servidor.
 */
export function listDirs(
  baseUrl: string,
  token: string,
  path: string,
): Promise<string[]> {
  const prefix = path.endsWith('/') ? path : `${path}/`;
  return requestJson(
    baseUrl,
    `/ls?prefix=${encodeURIComponent(prefix)}`,
    body =>
      Array.isArray(body)
        ? body.filter((item): item is string => typeof item === 'string')
        : [],
    token,
  );
}

/** Carpeta personal de esa máquina; es dónde empezar a mirar. */
export function fetchUserHome(
  baseUrl: string,
  token: string,
): Promise<string> {
  return requestJson(
    baseUrl,
    '/user-home',
    body => {
      const raw = asRecord(body);
      return typeof raw?.home === 'string' ? raw.home : '/';
    },
    token,
  );
}
