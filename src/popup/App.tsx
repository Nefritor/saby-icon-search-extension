import { Button, Spinner } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ProgressPush, SearchResponse } from '../shared/messaging';
import type { FontMeta, SearchResult, StyleSourceMeta } from '../shared/types';
import * as api from './api';
import { errorMessage } from './api';
import { BrandMark } from './components/BrandMark';
import { FooterBar } from './components/FooterBar';
import { GlyphDetails } from './components/GlyphDetails';
import { ProgressLine } from './components/ProgressLine';
import { ResultsGrid } from './components/ResultsGrid';
import { SettingsPanel } from './components/SettingsPanel';
import {
  SketchCanvas,
  type HistoryState,
  type SketchHandle,
  type SketchPayload,
} from './components/SketchCanvas';
import { LangContext, translate, useT, type TranslationKey } from './i18n';
import {
  applyStoredAppearance,
  applyTheme,
  getLang,
  saveLang,
  saveTheme,
  withThemeTransition,
  type Lang,
  type ThemeName,
} from './prefs';

interface Stats {
  considered: number;
  tookMs: number;
}

/** Кнопка-иконка в заголовке: отмена и возврат. */
function HeaderIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center self-center rounded-lg bg-[var(--soft-2)] text-[var(--text-2)] transition hover:bg-[var(--soft-3)] hover:text-[var(--text)] disabled:cursor-default disabled:opacity-30 disabled:hover:bg-[var(--soft-2)]"
    >
      {children}
    </button>
  );
}

function UndoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H10" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9h-9.5a5.5 5.5 0 0 0 0 11H14" />
    </svg>
  );
}

export function App() {
  const sketchRef = useRef<SketchHandle | null>(null);

  const [fonts, setFonts] = useState<FontMeta[]>([]);
  const [styleSources, setStyleSources] = useState<StyleSourceMeta[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [loadedFontIds, setLoadedFontIds] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<Stats | null>(null);
  /** Разобрано из .less и найдено в шрифте. Не сбрасывается при очистке холста. */
  const [glyphTotal, setGlyphTotal] = useState<number | null>(null);
  /** Имена из стилей, для которых глифа нет ни в одном шрифте: их не найти никогда. */
  const [glyphMissing, setGlyphMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressPush | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [hostAccess, setHostAccess] = useState(true);
  const [pendingUrl, setPendingUrl] = useState<api.PendingUrlRequest | null>(null);
  const [history, setHistory] = useState<HistoryState>({ canUndo: false, canRedo: false });
  const [theme, setTheme] = useState<ThemeName>('dark');
  const [lang, setLang] = useState<Lang>('ru');
  /** Короткая подсказка под холстом: показывается после неудачного действия. */
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<number | null>(null);
  /** Номер последнего запуска поиска: ответы устаревших запросов игнорируются. */
  const searchId = useRef(0);
  // Провайдер языка рендерится внутри этого же компонента, поэтому здесь берём
  // перевод напрямую из состояния: из контекста пришёл бы язык по умолчанию.
  const t = (key: TranslationKey) => translate(lang, key);

  /** Количество иконок и имена без глифа — единственное, что нужно и без поиска. */
  const refreshIconCount = useCallback(async () => {
    try {
      const counted = await api.fetchIconCount();
      setGlyphTotal(counted.total);
      setGlyphMissing(counted.missing);
    } catch {
      // Счётчик не настолько важен, чтобы показывать из-за него ошибку.
    }
  }, []);

  const refreshFonts = useCallback(async () => {
    try {
      setFonts(await api.fetchFonts());
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    void refreshIconCount();
  }, [refreshIconCount]);

  const refreshStyles = useCallback(async () => {
    setStyleSources(await api.getStyleSources());
    void refreshIconCount();
  }, [refreshIconCount]);

  const applyResponse = useCallback((response: SearchResponse) => {
    setResults(response.results);
    setStats({ considered: response.considered, tookMs: response.tookMs });
    setGlyphTotal(response.considered);
    // Выделяем верхний результат сразу, чтобы панель деталей не пустовала.
    setSelected(
      (current) =>
        response.results.find((item) => item.glyphId === current?.glyphId) ??
        response.results[0] ??
        null,
    );
  }, []);

  const runSearch = useCallback(
    async (payload: SketchPayload) => {
      const id = searchId.current + 1;
      searchId.current = id;
      setBusy(true);
      try {
        const response = await api.searchSketch(payload);
        // Пока искали, холст могли стереть и запустить другой поиск — такой ответ не наш.
        if (searchId.current !== id) return;
        applyResponse(response);
        setError(null);
      } catch (caught) {
        if (searchId.current === id) setError(errorMessage(caught));
      } finally {
        if (searchId.current === id) setBusy(false);
      }
    },
    [applyResponse],
  );

  /** Доигрывает добавление по ссылке, прерванное диалогом разрешения. */
  const resumePendingUrl = useCallback(async () => {
    const pending = await api.getPendingUrl();
    setPendingUrl(pending ?? null);
    if (!pending) return;
    if (!(await api.hasHostAccess())) return;

    await api.clearPendingUrl();
    setPendingUrl(null);
    setBusy(true);
    try {
      if (pending.kind === 'less') await api.addStyleByUrl(pending.name, pending.url);
      else await api.addFontByUrl(pending.name, pending.url);
      await refreshFonts();
      await refreshStyles();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [refreshFonts, refreshStyles]);

  useEffect(() => {
    // Тему и язык применяем до всего остального: иначе popup мигнёт чужими цветами.
    void (async () => {
      setTheme(await applyStoredAppearance());
      setLang(await getLang());
    })();

    // Первый запуск: ставим вшитые шрифты и стили, чтобы расширение работало сразу.
    void (async () => {
      try {
        await api.installBundledDefaults();
        // Индекс, собранный прежней версией сканера, мог потерять часть иконок.
        await api.reindexOutdatedFonts();
      } catch (caught) {
        setError(errorMessage(caught));
      }
      await refreshFonts();
      await refreshStyles();
    })();

    void api.getShowDebug().then(setShowDebug);
    void api.hasHostAccess().then(setHostAccess);
    void resumePendingUrl();

    const unsubscribe = api.subscribeToEngine((message) => {
      if (api.isProgressPush(message)) {
        setProgress(message);
        return;
      }
      if (api.isFontsChangedPush(message)) {
        setProgress(null);
        void refreshFonts().then(() => {
          const payload = sketchRef.current?.export();
          if (payload) void runSearch(payload);
          else {
            setResults([]);
            setSelected(null);
          }
        });
      }
    });

    return unsubscribe;
  }, [refreshFonts, refreshStyles, resumePendingUrl, runSearch]);

  // Настоящие символы: шрифт нужен и в popup, а не только в движке.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const missing = new Set<string>();
      for (const result of results) {
        const font = fonts.find((item) => item.id === result.fontId);
        if (font && !loadedFontIds.has(font.id)) missing.add(font.id);
      }
      if (missing.size === 0) return;

      const loaded = new Set(loadedFontIds);
      let changed = false;
      for (const fontId of missing) {
        const font = fonts.find((item) => item.id === fontId);
        if (!font) continue;
        if (await api.ensurePopupFont(font.id, font.family)) {
          loaded.add(fontId);
          changed = true;
        }
      }
      if (changed && !cancelled) setLoadedFontIds(loaded);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [results, fonts, loadedFontIds]);

  const handleClear = useCallback(() => {
    // Отменяем всё, что сейчас считается: иначе ответ вернёт стёртые результаты.
    searchId.current += 1;
    setBusy(false);
    sketchRef.current?.clear();
    setResults([]);
    setSelected(null);
    setStats(null);
  }, []);

  // Именно этот колбэк получает холст: он означает «в наброске слишком мало чернил»,
  // и стирать рисунок в этом случае нельзя — иначе он исчезает прямо под рукой.
  const handleEmptySketch = useCallback(() => {
    searchId.current += 1;
    setBusy(false);
    setResults([]);
    setSelected(null);
    setStats(null);
  }, []);

  const handleRemoveFont = useCallback(
    async (fontId: string) => {
      try {
        await api.removeFont(fontId);
        await refreshFonts();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [refreshFonts],
  );

  /** Убирает один источник стилей: остальные, включая вшитый, остаются на месте. */
  const handleRemoveStyle = useCallback(
    async (id: string) => {
      try {
        await api.removeStyleSource(id);
        await refreshStyles();
        const payload = sketchRef.current?.export();
        if (payload) await runSearch(payload);
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [refreshStyles, runSearch],
  );

  /**
   * Обновление вшитых шрифтов: перечитываем файлы из поставки и пересобираем индексы.
   * Нужно, когда набор иконок обновился вместе с расширением или индекс испортился.
   */
  const handleRefreshFonts = useCallback(async () => {
    await api.refreshBundledFonts();
    await refreshFonts();
    await refreshStyles();
    const payload = sketchRef.current?.export();
    if (payload) await runSearch(payload);
  }, [refreshFonts, refreshStyles, runSearch]);

  /** Обновление вшитых стилей: карта «кодпоинт → имя класса» читается заново. */
  const handleRefreshStyles = useCallback(async () => {
    await api.refreshBundledGlyphs();
    await refreshStyles();
    const payload = sketchRef.current?.export();
    if (payload) await runSearch(payload);
  }, [refreshStyles, runSearch]);

  const handleToggleDebug = useCallback((value: boolean) => {
    setShowDebug(value);
    void api.setShowDebug(value);
  }, []);

  /*
   * Смена темы: класс на <html> и состояние React меняются в одном задании, внутри
   * окна переходов по цветам. Так и цвета, и свитч (иконка, кружок, его ход)
   * анимируются вместе — без вспышек и рывков.
   */
  const handleTheme = useCallback((value: ThemeName) => {
    withThemeTransition(() => {
      applyTheme(value);
      flushSync(() => setTheme(value));
    });
    void saveTheme(value);
  }, []);

  const handleLang = useCallback((value: Lang) => {
    setLang(value);
    void saveLang(value);
  }, []);

  /**
   * Заливка, дошедшая до края холста, отменяется: иначе одним щелчком
   * закрашивался весь фон. Молча ничего не делать нельзя — непонятно, сработало ли.
   */
  const handleFillBlocked = useCallback(() => {
    setHint(translate(lang, 'fillBlocked'));
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 2600);
  }, [lang]);

  const handleGrantAccess = useCallback(async () => {
    try {
      const granted = await api.requestHostAccess();
      setHostAccess(granted);
      if (granted) await resumePendingUrl();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [resumePendingUrl]);

  const selectedFont = selected ? fonts.find((item) => item.id === selected.fontId) : undefined;
  const selectedFamily =
    selectedFont && loadedFontIds.has(selectedFont.id) ? selectedFont.family : null;

  return (
    <LangContext.Provider value={lang}>
      {/* Весь текст интерфейса — не для выделения: протяжка мышью по окну раньше
          подсвечивала подписи и цифры. Свой текст остается только у полей ввода. */}
      <div className="relative flex h-[580px] w-[400px] flex-col gap-2 bg-background p-3 text-foreground select-none">
        <header className="flex shrink-0 items-baseline justify-between gap-2 items-center">
          {/* Знак стоит перед именем и не участвует в выравнивании по базовой линии:
              у картинки её нет, и `items-baseline` увёл бы её вниз. */}
          <BrandMark className="h-9 w-9 p-1.5 shrink-0 self-center" />
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight select-none">
            Saby Icon Search
          </h1>

          {/* Всё в заголовке сидит на одной базовой линии: иначе крупное имя
              и мелкие подписи выглядят «поехавшими». */}
          <div className="flex shrink-0 items-baseline gap-1.5">
            {/* Спиннер поиска отодвинут от кнопок: вплотную он читается как их часть. */}
            {busy && <Spinner size="sm" className="mr-2 self-center" />}
            <HeaderIconButton
              label={t('undo')}
              disabled={!history.canUndo}
              onClick={() => sketchRef.current?.undo()}
            >
              <UndoIcon />
            </HeaderIconButton>
            <HeaderIconButton
              label={t('redo')}
              disabled={!history.canRedo}
              onClick={() => sketchRef.current?.redo()}
            >
              <RedoIcon />
            </HeaderIconButton>
            <Button size="sm" variant="ghost" onPress={handleClear}>
              {t('clear')}
            </Button>
          </div>
        </header>

        <SketchCanvas
          ref={sketchRef}
          onSketch={runSearch}
          onEmpty={handleEmptySketch}
          onFillBlocked={handleFillBlocked}
          onHistory={setHistory}
          hint={hint}
        />

        {/*
          Заголовок «Топ-5» и блок деталей живут только вместе с результатами.
          Пустое состояние занимает всё свободное место целиком: иначе EmptyHint
          с h-full растягивается на высоту контейнера и выдавливает футер за границы.
        */}
        {results.length > 0 ? (
          <>
            <span className="mt-1.5 shrink-0 text-[10px] uppercase tracking-wider text-[var(--muted)]">
              {t('topMatches')}
            </span>

            <ResultsGrid
              results={results}
              fonts={fonts}
              loadedFontIds={loadedFontIds}
              selectedGlyphId={selected?.glyphId ?? null}
              onSelect={setSelected}
            />

            <div className="min-h-0 flex-1">
              <GlyphDetails result={selected} showDebug={showDebug} family={selectedFamily} />
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1">
            <EmptyHint />
          </div>
        )}

        {error && <p className="shrink-0 text-[10px] leading-tight text-rose-500">{error}</p>}

        {!hostAccess && (
          <button
            type="button"
            onClick={handleGrantAccess}
            className="shrink-0 cursor-pointer rounded-lg bg-amber-500/15 px-2 mb-9 py-1 text-left text-[10px] leading-tight text-amber-500 ring-1 ring-amber-500/30 transition hover:bg-amber-500/25"
          >
            {pendingUrl
              ? `${t('continuePending')} «${pendingUrl.name}» — ${t('needHosts')}`
              : t('allowHosts')}
          </button>
        )}

        {/* Прогресс индексации висит над футером и места в потоке не занимает:
            иначе он на каждый шаг индексации сдвигал детали и кнопки, а вместе
            с ними прыгал весь низ окна. Пока открыты настройки, строку показывает
            панель — та самая секция шрифта, к которой индексация и относится. */}
        <div className="relative shrink-0">
          {progress && !panelOpen && (
            <div className="pointer-events-none absolute inset-x-0 bottom-full pb-3">
              <ProgressLine progress={progress} />
            </div>
          )}

          <FooterBar
            glyphTotal={glyphTotal}
            debugMs={stats && showDebug ? stats.tookMs : null}
            busy={busy}
            onOpenSettings={() => setPanelOpen(true)}
          />
        </div>

        {panelOpen && (
          <SettingsPanel
            fonts={fonts}
            styleSources={styleSources}
            progress={progress}
            showDebug={showDebug}
            hostAccess={hostAccess}
            glyphMissing={glyphMissing}
            theme={theme}
            lang={lang}
            onTheme={handleTheme}
            onLang={handleLang}
            onClose={() => setPanelOpen(false)}
            onAddFontFile={async (file, name) => {
              await api.addFontFromFile(file, name);
              await refreshFonts();
            }}
            onAddFontUrl={async (name, url) => {
              await api.addFontByUrl(name, url);
              await refreshFonts();
            }}
            onAddGlyphFile={async (file, name) => {
              await api.addStyleFromFile(file, name);
              await refreshStyles();
              const payload = sketchRef.current?.export();
              if (payload) await runSearch(payload);
            }}
            onAddGlyphUrl={async (name, url) => {
              await api.addStyleByUrl(name, url);
              await refreshStyles();
              const payload = sketchRef.current?.export();
              if (payload) await runSearch(payload);
            }}
            onRemoveFont={handleRemoveFont}
            onRemoveStyle={handleRemoveStyle}
            onRefreshFonts={handleRefreshFonts}
            onRefreshStyles={handleRefreshStyles}
            onToggleDebug={handleToggleDebug}
          />
        )}
      </div>
    </LangContext.Provider>
  );
}

function EmptyHint() {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      {/* Вшитые шрифт и стили ставятся при первом запуске, поэтому «добавьте файл»
          здесь — лишний шаг: рисовать можно сразу. */}
      <p className="text-[14px] leading-relaxed text-[var(--muted)]">{t('emptyHint')}</p>
    </div>
  );
}
