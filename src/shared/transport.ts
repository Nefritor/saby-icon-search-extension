import {
  chromePost,
  chromeSend,
  isPushMessage,
  type EngineRequest,
  type PushMessage,
} from './messaging';

/**
 * Абстракция доставки запросов движку.
 *
 * В расширении запросы уезжают в offscreen-документ, а события возвращаются
 * через chrome.runtime. На отладочном стенде всё работает в одной странице,
 * поэтому движок вызывается напрямую. UI не знает разницы.
 */
export interface Transport {
  send<T>(request: EngineRequest): Promise<T>;
  push(message: PushMessage): void;
  subscribe(listener: (message: PushMessage) => void): () => void;
  /** Подготовка окружения перед запросом: в расширении — поднять offscreen-документ. */
  ensureReady(): Promise<void>;
}

let current: Transport | null = null;

export function setTransport(transport: Transport): void {
  current = transport;
}

export function hasTransport(): boolean {
  return current !== null;
}

export function getTransport(): Transport {
  if (!current) throw new Error('Транспорт не установлен');
  return current;
}

/**
 * Ждём, пока offscreen-документ реально начнёт отвечать.
 * Создать документ мало: его скрипт регистрируется не мгновенно.
 */
async function waitForEngine(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const pong = await chromeSend<{ ok?: unknown; error?: string }>({
        target: 'offscreen',
        type: 'ping',
      });
      if (pong && pong.error === undefined) return;
    } catch {
      /* движок ещё не поднялся */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Движок не запустился');
}

export const chromeTransport: Transport = {
  send: <T>(request: EngineRequest) => chromeSend<T>(request),
  push: (message: PushMessage) => chromePost(message),
  subscribe(listener) {
    const handler = (message: unknown) => {
      if (isPushMessage(message)) listener(message);
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  },
  async ensureReady() {
    const created = await chromeSend<{ ok?: unknown; error?: string }>({
      target: 'sw',
      type: 'ensure-offscreen',
    });
    if (created?.error) throw new Error(created.error);
    await waitForEngine();
  },
};
