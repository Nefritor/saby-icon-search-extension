import type { SearchResponse } from '../shared/messaging';
import type { IconCount, WorkerReply, WorkerRequest } from './searchProtocol';

/** Клиент воркера поиска: запрос — промис, ответ находится по номеру. */
let worker: Worker | null = null;
let counter = 0;
const waiting = new Map<
  number,
  { resolve: (value: never) => void; reject: (error: Error) => void }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      const entry = waiting.get(reply.id);
      if (!entry) return;
      waiting.delete(reply.id);
      if ('error' in reply) entry.reject(new Error(reply.error));
      else entry.resolve(reply.result as never);
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'Воркер поиска упал');
      for (const entry of waiting.values()) entry.reject(error);
      waiting.clear();
      worker = null;
    };
  }
  return worker;
}

type Without<T> = T extends unknown ? Omit<T, 'id'> : never;

function call<T>(request: Without<WorkerRequest>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    counter += 1;
    waiting.set(counter, { resolve: resolve as (value: never) => void, reject });
    getWorker().postMessage({ ...request, id: counter });
  });
}

export function searchInWorker(sketch: string, width: number, height: number) {
  return call<SearchResponse>({ type: 'search', sketch, width, height });
}

export function iconCountInWorker() {
  return call<IconCount>({ type: 'icon-count' });
}

/** Сообщить воркеру, что глифы шрифта (или карта имён) в базе изменились. */
export function invalidateSearch(fontId?: string) {
  return call<boolean>({ type: 'invalidate', fontId });
}
