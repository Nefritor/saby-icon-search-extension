import { translate, type TranslationKey } from '../popup/i18n';
import { applyLang, applyTheme, getLang, getTheme, type Lang } from '../popup/prefs';
import { checkForUpdate, RELEASES_PAGE_URL, type UpdateStatus } from '../shared/update';
import '../styles.css';
import './update.css';
import {
  UpdateError,
  downloadAsset,
  forgetFolder,
  installArchive,
  isFolderAccessSupported,
  loadSavedFolder,
  pickFolder,
} from './installer';

/**
 * Страница обновления. Открывается во вкладке, а не в popup: диалог выбора папки и
 * запрос разрешения уводят фокус, и popup закрылся бы посреди установки.
 * Интерфейс собран вручную — React ради двух кнопок и строки статуса не нужен.
 */

/** Сервера, с которых GitHub отдаёт файлы релизов. На их ответах нет CORS-заголовков. */
const DOWNLOAD_ORIGINS = ['https://*.githubusercontent.com/*', 'https://api.github.com/*'];

const app = document.getElementById('app') as HTMLElement;

let lang: Lang = 'ru';
let status: UpdateStatus | null = null;
let folder: FileSystemDirectoryHandle | null = null;
let hostAccess = true;
let busy = false;
/** Строка под заголовком: что происходит сейчас или чем всё закончилось. */
let message: { text: string; tone: 'info' | 'ok' | 'error' } | null = null;
let progress: { done: number; total: number } | null = null;

const t = (key: TranslationKey) => translate(lang, key);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Расширение из магазина обновляет сам браузер: у него в манифесте есть `update_url`. */
function isStoreInstall(): boolean {
  return Boolean((chrome.runtime.getManifest() as { update_url?: string }).update_url);
}

async function hasDownloadAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: DOWNLOAD_ORIGINS });
}

function render(): void {
  const next: Node[] = [el('h1', {}, t('updateTitle'))];

  if (status) {
    next.push(
      el(
        'div',
        { className: 'versions' },
        el('span', {}, `${t('updateCurrent')}: `, el('b', {}, status.current)),
        status.latest
          ? el('span', {}, `${t('updateLatest')}: `, el('b', {}, status.latest.version))
          : '',
      ),
    );
  }

  if (message) next.push(el('div', { className: `status ${message.tone}` }, message.text));
  if (progress && progress.total > 0) {
    next.push(el('progress', { max: progress.total, value: progress.done }));
  }

  if (status?.available && status.latest?.notes) {
    next.push(el('div', { className: 'notes' }, status.latest.notes));
  }

  if (status?.available && status.latest?.asset && !isStoreInstall() && isFolderAccessSupported()) {
    next.push(
      el(
        'div',
        { className: 'folder' },
        el('span', {}, `${t('updateFolder')}: ${folder ? folder.name : t('updateFolderUnset')}`),
        folder
          ? el('button', {
              textContent: t('updateChangeFolder'),
              disabled: busy,
              onclick: changeFolder,
            })
          : '',
      ),
    );
  }

  const actions = el('div', { className: 'actions' });
  if (status?.available && status.latest?.asset && !isStoreInstall() && isFolderAccessSupported()) {
    const needsGrant = !hostAccess;
    actions.append(
      el('button', {
        className: 'primary',
        textContent: needsGrant ? t('updateGrant') : t('updateInstall'),
        title: needsGrant ? t('updateGrantHint') : '',
        disabled: busy,
        onclick: needsGrant ? grantAccess : install,
      }),
    );
  }
  actions.append(
    el('button', {
      textContent: t('updateRecheck'),
      disabled: busy,
      onclick: () => void check(true),
    }),
    el('a', {
      className: 'button',
      href: status?.latest?.pageUrl ?? RELEASES_PAGE_URL,
      target: '_blank',
      rel: 'noreferrer',
      textContent: t('updateReleasePage'),
    }),
  );
  next.push(actions);

  app.replaceChildren(...next);
}

function say(text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
  message = { text, tone };
  render();
}

async function check(force: boolean): Promise<void> {
  busy = true;
  say(t('updateChecking'));
  status = await checkForUpdate(force);
  busy = false;

  if (isStoreInstall()) say(t('updateStore'));
  else if (status.failed && !status.latest) say(t('updateCheckFailed'), 'error');
  else if (!status.available) say(t('updateUpToDate'), 'ok');
  else if (!status.latest?.asset) say(t('updateNoAsset'), 'error');
  else if (!isFolderAccessSupported()) say(t('updateUnsupported'), 'error');
  else say(t('updateNew'));
}

async function grantAccess(): Promise<void> {
  try {
    hostAccess = await chrome.permissions.request({ origins: DOWNLOAD_ORIGINS });
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), 'error');
    return;
  }
  render();
}

async function changeFolder(): Promise<void> {
  try {
    folder = await pickFolder();
    render();
  } catch (error) {
    if (!(error instanceof UpdateError)) say(String(error), 'error');
  }
}

async function install(): Promise<void> {
  const release = status?.latest;
  if (!release?.asset || busy) return;

  const manifest = chrome.runtime.getManifest();
  busy = true;
  progress = null;

  try {
    // Папку просим первой: диалог выбора требует свежего клика, а скачивание — нет.
    if (!folder) folder = await pickFolder();

    say(t('updateStepDownload'));
    const archive = await downloadAsset(release.asset, (done, total) => {
      progress = { done, total };
      render();
    });
    progress = null;

    await installArchive({
      folder,
      archive,
      expected: { name: manifest.name, version: manifest.version },
      releaseVersion: release.version,
      onStep: (step) => {
        const keys = {
          verify: 'updateStepVerify',
          unpack: 'updateStepUnpack',
          write: 'updateStepWrite',
        } as const;
        say(t(keys[step]));
      },
    });

    say(t('updateDone'), 'ok');
    // Небольшая пауза, чтобы успели прочитать сообщение; перезагрузка закроет и эту вкладку.
    window.setTimeout(() => chrome.runtime.reload(), 800);
  } catch (error) {
    progress = null;
    busy = false;
    // Сохранённая папка могла стать негодной (переименована, удалена) — забываем её.
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      await forgetFolder();
      folder = null;
    }
    say(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function main(): Promise<void> {
  lang = await getLang();
  applyLang(lang);
  applyTheme(await getTheme());

  folder = await loadSavedFolder();
  hostAccess = await hasDownloadAccess();
  render();
  await check(true);
}

void main();
