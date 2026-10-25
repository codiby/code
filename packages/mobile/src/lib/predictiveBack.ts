import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

interface PredictiveBackNativeModule {
  readonly progressAvailable?: boolean;
  setMode: (mode: 'app' | 'default') => void;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
}

const native: PredictiveBackNativeModule | null =
  Platform.OS === 'android'
    ? ((NativeModules.PredictiveBackModule as
        | PredictiveBackNativeModule
        | undefined) ?? null)
    : null;

export const IS_SUPPORTED = native !== null;

/**
 * Android reporta el progreso del gesto solo desde la 14 (API 34). Por debajo
 * llega el commit pero no el arrastre, así que ahí toca animar por tiempo.
 */
export const HAS_PROGRESS =
  native !== null && native.progressAvailable === true;

export interface BackEvent {
  readonly progress: number;
  /** 0 = borde izquierdo, 1 = derecho. */
  readonly swipeEdge: number;
  readonly touchX: number;
  readonly touchY: number;
}

export interface PredictiveBackHandlers {
  readonly onStart?: (event: BackEvent) => void;
  readonly onProgress?: (event: BackEvent) => void;
  readonly onCancel?: () => void;
  readonly onCommit?: () => void;
}

let handlers: PredictiveBackHandlers | null = null;
let subscriptions: { remove: () => void }[] | null = null;

function ensureSubscribed() {
  if (subscriptions !== null || native === null) {
    return;
  }
  // El emisor tipa los payloads como `Object`: se estrecha en el borde, que es
  // donde ya se sabe qué manda el módulo nativo.
  const emitter = new NativeEventEmitter(native as never);
  const toBackEvent = (payload: unknown): BackEvent => {
    const raw = (payload ?? {}) as Partial<BackEvent>;
    return {
      progress: typeof raw.progress === 'number' ? raw.progress : 0,
      swipeEdge: typeof raw.swipeEdge === 'number' ? raw.swipeEdge : 0,
      touchX: typeof raw.touchX === 'number' ? raw.touchX : 0,
      touchY: typeof raw.touchY === 'number' ? raw.touchY : 0,
    };
  };

  subscriptions = [
    emitter.addListener('predictiveBackStart', payload =>
      handlers?.onStart?.(toBackEvent(payload)),
    ),
    emitter.addListener('predictiveBackProgress', payload =>
      handlers?.onProgress?.(toBackEvent(payload)),
    ),
    emitter.addListener('predictiveBackCancel', () => handlers?.onCancel?.()),
    emitter.addListener('predictiveBackCommit', () => handlers?.onCommit?.()),
  ];
}

/**
 * Reclama el gesto para la app. Mientras esté reclamado, el callback propio de
 * React Native queda desactivado — si no, se comería el evento antes y el
 * gesto nunca llegaría hasta aquí.
 */
export function acquire(next: PredictiveBackHandlers) {
  if (native === null) {
    return;
  }
  ensureSubscribed();
  handlers = next;
  native.setMode('app');
}

/** Devuelve el control a React Native (`BackHandler` vuelve a funcionar). */
export function release() {
  if (native === null) {
    return;
  }
  handlers = null;
  native.setMode('default');
}
