/**
 * Service worker существует ради одной задачи: держать offscreen-документ,
 * в котором живёт движок (растеризация глифов, индексация, сопоставление).
 * Popup при этом можно свободно закрывать — индексация не прервётся.
 */

const OFFSCREEN_PATH = 'offscreen.html';

/** Ключ, в котором лежит последняя известная тема браузера: тёмная или светлая. */
const TOOLBAR_THEME_KEY = 'toolbar-dark';

/**
 * Иконки тулбара двумя наборами. Chrome не умеет выбирать иконку по теме сам,
 * поэтому подменяем её через action.setIcon, когда узнаём тему.
 */
const TOOLBAR_ICONS: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  dark: {
    16: 'icons/icon-dark-16.png',
    32: 'icons/icon-dark-32.png',
    48: 'icons/icon-dark-48.png',
    128: 'icons/icon-dark-128.png',
  },
};

function applyToolbarTheme(dark: boolean): void {
  chrome.action.setIcon({ path: dark ? TOOLBAR_ICONS.dark : TOOLBAR_ICONS.light }).catch(() => {
    /* иконка не критична: если не отдали — останется та, что в манифесте */
  });
}

// Тема браузера не читается из service worker (там нет DOM), поэтому её сообщает
// offscreen-документ. Здесь только применяем запомненное значение при старте —
// чтобы иконка была верной ещё до первого открытия popup.
void chrome.storage.local.get(TOOLBAR_THEME_KEY).then((stored) => {
  const value = stored[TOOLBAR_THEME_KEY];
  if (typeof value === 'boolean') applyToolbarTheme(value);
});

let creating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const hasDocument = await chrome.offscreen.hasDocument();
  if (hasDocument) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          'Растеризация и индексация глифов шрифта выполняются в фоне, чтобы не прерываться при закрытии popup.',
      })
      .catch((error: unknown) => {
        // Документ мог быть создан параллельным вызовом — это не ошибка.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Only a single offscreen')) throw error;
      })
      .finally(() => {
        creating = null;
      });
  }

  await creating;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return false;
  const request = message as { target?: unknown; type?: unknown; dark?: unknown };
  if (request.target !== 'sw') return false;

  if (request.type === 'theme') {
    const dark = request.dark === true;
    void chrome.storage.local.set({ [TOOLBAR_THEME_KEY]: dark });
    applyToolbarTheme(dark);
    sendResponse({ ok: true });
    return false;
  }

  if (request.type !== 'ensure-offscreen') return false;

  ensureOffscreenDocument()
    .then(() => sendResponse({ ok: true }))
    .catch((error: unknown) => {
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});
