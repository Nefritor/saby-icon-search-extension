import type { SearchResponse } from '../shared/messaging';

export interface IconCount {
  /** Сколько иконок реально участвует в поиске: кодпоинты из стилей, найденные в шрифтах. */
  total: number;
  /** Имена классов из стилей, для которых глифа нет ни в одном шрифте. */
  missing: string[];
}

export type WorkerRequest =
  | { id: number; type: 'search'; sketch: string; width: number; height: number }
  | { id: number; type: 'icon-count' }
  /** Данные в IndexedDB изменились: сбросить кеш шрифта (или всё) и карту имён. */
  | { id: number; type: 'invalidate'; fontId?: string };

export type WorkerReply =
  { id: number; result: SearchResponse | IconCount | boolean } | { id: number; error: string };
