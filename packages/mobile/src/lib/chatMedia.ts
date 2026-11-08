import { readMessages } from '../api/messageStore';
import { resourceUrl, type SessionResource } from '../api/resources';

export interface MediaItem {
  readonly id: string;
  readonly uri: string;
  readonly name: string;
}

/**
 * Todo lo que el visor de multimedia enseña de una sesión.
 *
 * Los recursos del bridge solo cubren lo que se subió: adjuntos del usuario y
 * mockups. Las capturas que trae el agente —un `take_screenshot`, una imagen
 * publicada en la sesión— viven dentro de los mensajes, y esos ya están
 * guardados en el teléfono, así que se suman sin pedir nada a la red. Las del
 * usuario no: el bridge ya las archiva como recurso y saldrían repetidas.
 */
export function sessionMedia(
  baseUrl: string,
  token: string,
  sessionKey: string,
  resources: readonly SessionResource[],
): MediaItem[] {
  const uploaded = resources
    .filter(item => item.mime.startsWith('image/'))
    .map(item => ({
      id: item.id,
      uri: resourceUrl(baseUrl, item, token),
      name: item.name,
    }));

  const fromChat: MediaItem[] = [];
  const messages = readMessages(sessionKey)?.messages ?? [];
  // Lo más nuevo primero, como la galería de un chat.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'user') {
      continue;
    }
    message.images.forEach((image, index) => {
      fromChat.push({
        id: `${message.id}:${index}`,
        uri: `data:${image.mediaType};base64,${image.data}`,
        name: message.toolName ?? 'Image',
      });
    });
  }

  return [...uploaded, ...fromChat];
}
