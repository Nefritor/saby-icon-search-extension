import type { EngineRequest } from '../shared/messaging';
import * as engine from './engine';

/**
 * Операции, меняющие хранилище, идут строго по очереди. Сканирование и построение
 * дескрипторов теперь отдают поток, поэтому запросы перемежаются между порциями;
 * параллельные индексация, переиндексация и удаление одного и того же шрифта
 * оставили бы в базе осиротевшие глифы. Чтения (поиск, счётчик, список) очередь
 * не проходят и по-прежнему могут выполняться во время индексации.
 */
let mutations: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = mutations.then(task, task);
  mutations = run.catch(() => undefined);
  return run;
}

/**
 * Диспетчер запросов движка. Используется и offscreen-документом,
 * и отладочным стендом — чтобы поведение было ровно одинаковым.
 */
export async function handleEngineRequest(message: EngineRequest): Promise<unknown> {
  switch (message.type) {
    case 'ping':
      return { ok: true };
    case 'list-fonts':
      return { fonts: await engine.listFonts() };
    case 'add-font-url':
      return serialized(async () => ({
        font: await engine.addFontFromUrl(message.name, message.url),
      }));
    case 'index-local-font':
      await serialized(() => engine.indexLocalFont(message.fontId));
      return { ok: true };
    case 'remove-font':
      await serialized(() => engine.removeFont(message.fontId));
      return { ok: true };
    case 'reload-icons':
      await engine.reloadIcons();
      return { ok: true };
    case 'reindex-fonts':
      return serialized(async () => ({ reindexed: await engine.reindexOutdatedFonts() }));
    case 'icon-count':
      return engine.iconCount();
    case 'search':
      return engine.search(message.sketch, message.width, message.height);
    default:
      throw new Error('Неизвестный запрос движку');
  }
}
