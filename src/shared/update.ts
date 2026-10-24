import { getLocal, setLocal } from './storage';

/** Репозиторий, в релизах которого лежат сборки расширения. */
export const REPO = 'Nefritor/saby-icon-search-extension';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Страница релизов: запасной путь, когда обновить по кнопке нельзя. */
export const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases/latest`;

/** Как долго результат проверки считается свежим. API без токена даёт 60 запросов в час. */
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** После сбоя (сеть, лимит GitHub) повторяем не чаще, чем раз в это время. */
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
const CACHE_KEY = 'update-check';

export interface ReleaseAsset {
  name: string;
  /** Адрес в API: отдаёт CORS-заголовки и перенаправляет на сам файл. */
  apiUrl: string;
  size: number;
  /** Контрольная сумма вида `sha256:…`, если GitHub её посчитал. */
  digest: string | null;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  notes: string;
  pageUrl: string;
  asset: ReleaseAsset | null;
}

export interface UpdateStatus {
  current: string;
  latest: ReleaseInfo | null;
  /** Есть версия новее установленной. */
  available: boolean;
  /** Проверка не удалась (сеть, лимит GitHub): показывать нечего, но и пугать не надо. */
  failed: boolean;
}

interface CachedCheck {
  checkedAt: number;
  release: ReleaseInfo | null;
}

/** Достаёт числовую часть версии: `v1.2.3`, `1.2`, `Release 1.2.3-beta` → [1, 2, 3]. */
export function parseVersion(value: string): number[] | null {
  const match = /(\d+(?:\.\d+)*)/.exec(value);
  return match ? match[1].split('.').map(Number) : null;
}

/** Положительное число — `a` новее `b`. Недостающие разряды считаются нулями. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

interface RawAsset {
  name?: unknown;
  url?: unknown;
  size?: unknown;
  digest?: unknown;
}

/** Выбирает архив расширения среди файлов релиза: сначала по привычному имени, затем любой zip. */
function pickAsset(assets: RawAsset[]): ReleaseAsset | null {
  const zips = assets.filter(
    (asset) =>
      typeof asset.name === 'string' &&
      asset.name.toLowerCase().endsWith('.zip') &&
      typeof asset.url === 'string',
  );
  const chosen = zips.find((asset) => String(asset.name).includes('extension')) ?? zips[0];
  if (!chosen) return null;

  return {
    name: String(chosen.name),
    apiUrl: String(chosen.url),
    size: typeof chosen.size === 'number' ? chosen.size : 0,
    digest: typeof chosen.digest === 'string' ? chosen.digest : null,
  };
}

/** Разбирает ответ `releases/latest`. Черновики, предрелизы и теги без версии отбрасываются. */
export function parseRelease(raw: unknown): ReleaseInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (data.draft === true || data.prerelease === true) return null;

  const tag = typeof data.tag_name === 'string' ? data.tag_name : '';
  const parsed = parseVersion(tag);
  if (!parsed) return null;

  return {
    version: parsed.join('.'),
    tag,
    notes: typeof data.body === 'string' ? data.body : '',
    pageUrl: typeof data.html_url === 'string' ? data.html_url : RELEASES_PAGE_URL,
    asset: pickAsset(Array.isArray(data.assets) ? (data.assets as RawAsset[]) : []),
  };
}

/** Версия установленного расширения: из манифеста, а на отладочном стенде — из сборки. */
export function currentVersion(): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
    return chrome.runtime.getManifest().version;
  }
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
}

async function fetchLatest(): Promise<ReleaseInfo | null> {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  // 404 — релизов ещё нет: это не сбой, а «обновлять нечего».
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
  return parseRelease(await response.json());
}

/**
 * Проверяет, вышла ли версия новее установленной. Результат кешируется на несколько
 * часов: popup открывают десятки раз в день, а лимит API без токена невелик.
 * Сбой сети не бросает исключение — расширение должно работать и без GitHub.
 */
export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  const current = currentVersion();
  const cached = await getLocal<CachedCheck>(CACHE_KEY);

  let release: ReleaseInfo | null;
  let failed = false;

  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) {
    release = cached.release;
  } else {
    try {
      release = await fetchLatest();
      await setLocal(CACHE_KEY, { checkedAt: Date.now(), release } satisfies CachedCheck);
    } catch {
      release = cached?.release ?? null;
      failed = true;
      // Запоминаем и неудачу: без этого каждое открытие popup без сети (или при исчерпанном
      // лимите API) снова ходило бы на GitHub.
      const checkedAt = Date.now() - CHECK_TTL_MS + RETRY_AFTER_FAILURE_MS;
      await setLocal(CACHE_KEY, { checkedAt, release } satisfies CachedCheck).catch(
        () => undefined,
      );
    }
  }

  return {
    current,
    latest: release,
    available: release !== null && compareVersions(release.version, current) > 0,
    failed,
  };
}
