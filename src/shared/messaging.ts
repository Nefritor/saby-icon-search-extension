import type { FontMeta, SearchResult } from './types';

export interface ProgressPush {
  target: 'popup';
  type: 'progress';
  fontId: string;
  fontName: string;
  phase: 'fetch' | 'scan' | 'index';
  done: number;
  total: number;
}

export interface FontsChangedPush {
  target: 'popup';
  type: 'fonts-changed';
}

export interface FontErrorPush {
  target: 'popup';
  type: 'font-error';
  fontName: string;
  message: string;
}

export type PushMessage = ProgressPush | FontsChangedPush | FontErrorPush;

export type EngineRequest =
  | { target: 'sw'; type: 'ensure-offscreen' }
  | { target: 'sw'; type: 'theme'; dark: boolean }
  | { target: 'offscreen'; type: 'ping' }
  | { target: 'offscreen'; type: 'list-fonts' }
  | { target: 'offscreen'; type: 'add-font-url'; name: string; url: string }
  | { target: 'offscreen'; type: 'index-local-font'; fontId: string }
  | { target: 'offscreen'; type: 'remove-font'; fontId: string }
  | { target: 'offscreen'; type: 'reload-icons' }
  | { target: 'offscreen'; type: 'reindex-fonts' }
  | { target: 'offscreen'; type: 'icon-count' }
  | { target: 'offscreen'; type: 'search'; sketch: string; width: number; height: number };

export interface FontListResponse {
  fonts: FontMeta[];
}

export interface SearchResponse {
  results: SearchResult[];
  considered: number;
  tookMs: number;
}

export interface OkResponse {
  ok: true;
}

export interface ErrorResponse {
  error: string;
}

export function isPushMessage(value: unknown): value is PushMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { target?: unknown }).target === 'popup'
  );
}

/**
 * Сообщения Chrome сериализуются через JSON, поэтому бинарные данные
 * (растр наброска, превью глифов) передаются строками base64.
 */
export function chromeSend<T>(message: EngineRequest | PushMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: unknown) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? 'runtime error'));
        return;
      }
      resolve(response as T);
    });
  });
}

/** Fire-and-forget: получателя может не быть (popup закрыт, движок ещё не поднялся). */
export function chromePost(message: EngineRequest | PushMessage): void {
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch {
    /* получателя нет — это нормально */
  }
}
