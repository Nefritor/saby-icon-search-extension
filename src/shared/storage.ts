/**
 * Хранилище настроек/состояния. В расширении — chrome.storage.local,
 * на отладочном стенде — localStorage.
 */

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

export async function getLocal<T>(key: string): Promise<T | undefined> {
  if (hasChromeStorage()) {
    const stored = await chrome.storage.local.get(key);
    return stored[key] as T | undefined;
  }
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function setLocal(key: string, value: unknown): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [key]: value });
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}

export async function removeLocal(key: string): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.remove(key);
    return;
  }
  localStorage.removeItem(key);
}
