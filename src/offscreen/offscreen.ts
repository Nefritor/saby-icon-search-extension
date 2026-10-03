import type { EngineRequest } from '../shared/messaging';
import { chromeTransport, getTransport, setTransport } from '../shared/transport';
import { handleEngineRequest } from './engineHost';

// Движок живёт в offscreen-документе: события прогресса он рассылает через chrome.runtime.
setTransport(chromeTransport);

/**
 * Тема браузера. У service worker нет DOM, поэтому media-запрос читаем здесь —
 * документ живёт столько же, сколько движок, — и сообщаем результат в service worker,
 * чтобы он подменил иконку тулбара на тёмную или светлую.
 */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function reportToolbarTheme(): void {
  getTransport()
    .send({ target: 'sw', type: 'theme', dark: darkQuery.matches })
    .catch(() => {
      /* service worker мог не проснуться — сообщим при следующей смене темы */
    });
}

reportToolbarTheme();
darkQuery.addEventListener('change', reportToolbarTheme);

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return false;
  if ((message as { target?: unknown }).target !== 'offscreen') return false;

  handleEngineRequest(message as EngineRequest)
    .then((result) => sendResponse(result))
    .catch((error: unknown) => {
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});
