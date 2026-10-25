/** Respuesta de `GET /health` del bridge de Codiby Code. Endpoint público. */
export interface HealthResponse {
  readonly status: string;
  readonly sessions: number;
}

/**
 * El agente pide aprobación para usar una herramienta. Mientras está pendiente
 * la sesión no avanza — y `isStreaming` sigue en `true`, así que sin esto el
 * indicador de actividad diría «trabajando» indefinidamente.
 */
export interface PermissionRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly description: string | null;
  readonly input: Record<string, unknown>;
}

export type ConnectionStatus = 'idle' | 'checking' | 'connected' | 'error';

export interface ConnectionState<T> {
  readonly status: ConnectionStatus;
  readonly data: T | null;
  readonly error: string | null;
  /** Epoch ms del último intento, exitoso o no. */
  readonly checkedAt: number | null;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageImage {
  readonly mediaType: string;
  /** base64 sin el prefijo `data:`. */
  readonly data: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: MessageRole;
  /** Ya sin códigos ANSI. */
  readonly content: string;
  readonly timestamp: number;
  /** Cursor de paginación del bridge. */
  readonly seq: number;
  /** Presente cuando el mensaje es una invocación de herramienta. */
  readonly toolName: string | null;
  /** Argumentos de la herramienta: `command`, `description`, `file_path`… */
  readonly toolInput: Record<string, unknown> | null;
  /**
   * Imágenes adjuntas, extraídas fuera de `content` a propósito: lo que
   * disparaba la memoria era pasarle un base64 al motor de texto, no
   * guardarlo.
   */
  readonly images: MessageImage[];
  /** Bloque de razonamiento persistido, no una respuesta al usuario. */
  readonly isThinking: boolean;
  /** El proveedor cifró el razonamiento y solo mandó el envoltorio. */
  readonly thinkingRedacted: boolean;
  /**
   * Es la salida de una herramienta, no algo que el agente dijo. Opcional
   * porque lo guardado en el teléfono antes de leerlo no lo trae.
   */
  readonly isToolResult?: boolean;
  /** Id de la llamada a la que responde esta salida. */
  readonly toolUseId?: string | null;
  /**
   * Solo en las burbujas que manda este teléfono, mientras el bridge no las
   * confirma: `sending` va de camino, `failed` no llegó y se puede reintentar.
   */
  readonly sendState?: 'sending' | 'failed';
}

export interface MessagePage {
  readonly messages: ChatMessage[];
  readonly hasMore: boolean;
}

/**
 * Vista de una sesión lista para pintar. El bridge manda `status` y
 * `runtime_status` como strings abiertos, así que se normalizan aquí a
 * booleanos en vez de arriesgar una unión que se rompa cuando el servidor
 * agregue un valor nuevo.
 */
export interface SessionSummary {
  /** Id tal cual lo da su bridge. Sirve para llamarlo, no para indexar. */
  readonly id: string;
  readonly serverId: string;
  /**
   * `serverId:id`. Es lo que hay que usar como clave en cualquier mapa.
   *
   * Los ids NO son únicos entre máquinas: el bridge llama `main-session` a la
   * sesión por defecto de cada una, así que dos servidores tienen una sesión
   * con ese mismo id. Indexar por `id` hacía que la vista previa, el borrador
   * y la caché de una pisaran a la de la otra.
   */
  readonly key: string;
  readonly name: string;
  readonly cwd: string;
  /** Último segmento de `cwd`, que es lo que identifica al proyecto. */
  readonly folder: string;
  readonly updatedAt: number;
  readonly isOpen: boolean;
  readonly isRunning: boolean;
  readonly provider: string | null;
  readonly disposableTtlMs?: number | null;
}
