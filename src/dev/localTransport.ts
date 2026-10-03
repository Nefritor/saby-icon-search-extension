import * as engine from '../offscreen/engine';
import { handleEngineRequest } from '../offscreen/engineHost';
import type { EngineRequest, PushMessage } from '../shared/messaging';
import { setTransport } from '../shared/transport';

/**
 * Транспорт для отладочного стенда: движок вызывается прямо в этой странице,
 * поэтому ни offscreen-документ, ни service worker не нужны.
 * Поведение то же самое — диспетчер запросов общий с offscreen.
 */
const listeners = new Set<(message: PushMessage) => void>();

// Прогресс индексации движок рассылает через транспорт — подписчикам стенда.
setTransport({
  send: <T>(request: EngineRequest) => handleEngineRequest(request) as Promise<T>,
  push(message) {
    for (const listener of listeners) listener(message);
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async ensureReady() {
    // Движок уже здесь.
  },
});

export { engine };
