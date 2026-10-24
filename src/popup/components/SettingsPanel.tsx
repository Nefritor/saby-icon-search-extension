import { Spinner } from '@heroui/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProgressPush } from '../../shared/messaging';
import type { FontMeta, StyleSourceMeta } from '../../shared/types';
import { APP_AUTHOR, APP_VERSION, SABY_VERSION } from '../../shared/version';
import * as api from '../api';
import { errorMessage, isBundledSource } from '../api';
import { useT } from '../i18n';
import type { Lang, ThemeName } from '../prefs';
import { ProgressLine } from './ProgressLine';

interface Props {
  fonts: FontMeta[];
  /** Источники стилей: вшитый и добавленные пользователем, в порядке применения. */
  styleSources: StyleSourceMeta[];
  progress: ProgressPush | null;
  hostAccess: boolean;
  /** Имена из стилей, для которых глифа нет ни в одном шрифте: искать их бессмысленно. */
  glyphMissing: string[];
  theme: ThemeName;
  lang: Lang;
  /** Версия новее установленной и переход к обновлению. */
  updateVersion?: string | null;
  onUpdate?: () => void;
  onClose: () => void;
  onTheme: (theme: ThemeName) => void;
  onLang: (lang: Lang) => void;
  onAddFontFile: (file: File, name: string) => Promise<void>;
  onAddFontUrl: (name: string, url: string) => Promise<void>;
  onAddGlyphFile: (file: File, name: string) => Promise<void>;
  onAddGlyphUrl: (name: string, url: string) => Promise<void>;
  onRemoveFont: (fontId: string) => Promise<void>;
  onRemoveStyle: (id: string) => Promise<void>;
  /** Обновление вшитых файлов: перечитать шрифты и стили из поставки. */
  onRefreshFonts: () => Promise<void>;
  onRefreshStyles: () => Promise<void>;
}

/** Длительность закрытия: совпадает с анимациями `.settings-*-out` в styles.css. */
const CLOSE_ANIM_MS = 300;
/** Сколько ошибка секции висит на экране, прежде чем убраться сама. */
const ERROR_TTL_MS = 4000;

/*
 * Кнопки-облачка и поле ввода одни и те же во всех секциях: то, что нажимается,
 * должно быть одного размера и вида, иначе форма «прыгает» при входе в правку.
 */
const PILL_CLASS =
  'glass-pill min-w-[68px] shrink-0 cursor-pointer rounded-full px-3 py-[5px] text-center text-[11px] leading-tight text-[var(--text)] transition';
const DANGER_PILL_CLASS =
  'shrink-0 cursor-pointer rounded-full bg-rose-500/10 px-2.5 py-[4px] text-center text-[11px] leading-tight text-rose-400 transition hover:bg-rose-500/20';
/** Обновление вшитого набора: маленькое текстовое облачко рядом с заголовком группы. */
const REFRESH_PILL_CLASS =
  'glass-pill shrink-0 cursor-pointer rounded-full px-2.5 py-[2px] text-[10px] leading-tight text-[var(--text-2)] transition hover:text-[var(--text)]';
/** Облачко-предупреждение: по клику открывается список проблемных имён. */
const WARNING_PILL_CLASS =
  'cursor-pointer rounded-full bg-amber-500/10 px-2.5 py-[3px] text-left text-[10px] leading-tight text-amber-500 transition hover:bg-amber-500/20';
/** Подтверждение ссылки: живёт внутри поля, поэтому компактная. Появляется только
 *  вместе с непустой ссылкой — до этого она занимала бы место впустую. */
const INLINE_SUBMIT_CLASS =
  'absolute top-1/2 right-[3px] -translate-y-[7px] rounded-[6px] px-2 py-[2px] text-center text-[10px] leading-tight transition disabled:pointer-events-none';
const INPUT_CLASS =
  'w-full min-w-0 select-text rounded-full bg-[var(--input)] px-3 py-[4px] text-[11px] text-[var(--text)] outline-none ring-1 transition placeholder:text-[var(--muted)] disabled:opacity-60';
/** Тон поля ссылки: ошибка красит рамку в красный, пока текст не поправят. */
const INPUT_TONE = 'ring-[var(--line)] focus:ring-[var(--accent)]';
const INPUT_TONE_ERROR = 'ring-rose-500 focus:ring-rose-500';
/** Отступ под кнопку внутри поля: текст ссылки не должен заезжать под неё. */
const INPUT_WITH_BUTTON = 'pr-[68px]';

function nameFromFile(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * Что вообще можно положить в каждый блок настроек. Список задаёт и фильтр в диалоге
 * выбора файла, и проверку после выбора: фильтр — только подсказка, его обходят через
 * «все файлы». Шрифт иконок — это woff/woff2/ttf/eot, словарь стилей — только .less.
 */
const ACCEPTED: Record<'font' | 'less', { extensions: string[]; error: 'onlyFont' | 'onlyLess' }> =
  {
    font: { extensions: ['.woff', '.woff2', '.ttf', '.eot'], error: 'onlyFont' },
    less: { extensions: ['.less'], error: 'onlyLess' },
  };

/** Расширение из имени файла или адреса: `icons.woff2?v=3` — это `.woff2`. */
function extensionOf(value: string): string {
  const clean = value.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(dot).toLowerCase() : '';
}

function nameFromUrl(url: string): string {
  const tail = url.split('/').filter(Boolean).pop() ?? 'source';
  return nameFromFile(decodeURIComponent(tail.split('?')[0]));
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
      <path d="M13.5 3v5.5H19" />
    </svg>
  );
}

/**
 * Добавление по ссылке требует доступа к домену, а диалог разрешения уводит фокус
 * и закрывает popup. Поэтому намерение сначала сохраняется, и добавление
 * доигрывается при следующем открытии, если popup всё-таки закрылся.
 */
async function withHostAccess(
  kind: 'font' | 'less',
  name: string,
  url: string,
  hostAccess: boolean,
  run: (name: string, url: string) => Promise<void>,
): Promise<void> {
  if (!hostAccess) {
    await api.setPendingUrl({ kind, name, url, requestedAt: Date.now() });
    const granted = await api.requestHostAccess();
    if (!granted) throw new Error('Доступ к сайтам не выдан');
    await api.clearPendingUrl();
  }
  await run(name, url);
}

/** Строка источника: и стили, и шрифты показываются одинаково. */
interface SourceItem {
  id: string;
  name: string;
  detail: string;
  bundled: boolean;
}

interface SourceSectionProps {
  title: string;
  /** Текущий источник — то, что видно в свёрнутом виде. */
  current: SourceItem | null;
  /** Дополнительные источники того же вида: строки под основным. */
  extras?: SourceItem[];
  emptyText: string;
  urlPlaceholder: string;
  fileHint: string;
  pendingKind: 'font' | 'less';
  hostAccess: boolean;
  onAddFile: (file: File, name: string) => Promise<void>;
  onAddUrl: (name: string, url: string) => Promise<void>;
  /** Убрать основной источник. */
  onRemove?: () => Promise<void>;
  /** Убрать дополнительный источник по его id. */
  onRemoveExtra?: (id: string) => Promise<void>;
  /** Обновление вшитого источника: перечитать файл из поставки. */
  onRefresh?: () => Promise<void>;
  /** Предупреждение под значением источника. Обычно — облачко-кнопка со списком. */
  warning?: ReactNode;
  /** Прогресс индексации: есть только у блока шрифта. */
  progress?: ProgressPush | null;
}

/**
 * Секция источника. В свёрнутом виде — только текущее значение и «Изменить»;
 * в правке на месте кнопки встаёт «Отмена» того же размера, чтобы разметка
 * не прыгала, а ниже появляется строка добавления: ссылка или файл.
 *
 * Ход добавления показывается здесь же: спиннер и полоса прогресса относятся
 * к этому блоку, а не к общему футеру панели.
 */
function SourceSection({
  title,
  current,
  extras,
  emptyText,
  urlPlaceholder,
  fileHint,
  pendingKind,
  hostAccess,
  onAddFile,
  onAddUrl,
  onRemove,
  onRemoveExtra,
  onRefresh,
  warning,
  progress,
}: SourceSectionProps) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [working, setWorking] = useState(false);
  /** Ошибка секции: показывается рядом с ней и гаснет сама, чтобы не висеть на главной. */
  const [error, setError] = useState<string | null>(null);
  /** Ошибка относится к полю ссылки — тогда краснеет и рамка поля. */
  const [linkError, setLinkError] = useState(false);
  const errorTimer = useRef<number | null>(null);
  const accept = ACCEPTED[pendingKind];

  const clearError = () => {
    if (errorTimer.current !== null) {
      window.clearTimeout(errorTimer.current);
      errorTimer.current = null;
    }
    setError(null);
    setLinkError(false);
  };

  const showError = (message: string, markLink = false) => {
    if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    setError(message);
    setLinkError(markLink);
    errorTimer.current = window.setTimeout(clearError, ERROR_TTL_MS);
  };

  useEffect(
    () => () => {
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    },
    [],
  );

  const run = async (action: () => Promise<void>, markLink = false) => {
    setWorking(true);
    clearError();
    try {
      await action();
      setEditing(false);
      setUrl('');
    } catch (caught) {
      showError(errorMessage(caught), markLink);
    } finally {
      setWorking(false);
    }
  };

  // Файл грузится сразу: отдельный шаг «Добавить» здесь лишний.
  const handleFile = (file: File | null) => {
    if (!file || working) return;
    if (!accept.extensions.includes(extensionOf(file.name))) {
      showError(t(accept.error));
      return;
    }
    void run(() => onAddFile(file, nameFromFile(file.name)));
  };

  const submitUrl = () => {
    const trimmed = url.trim();
    if (trimmed === '' || working) return;
    // У ссылки расширения может и не быть: адрес без хвоста отдаём движку,
    // а вот чужое расширение (например, страница .html) отсекаем сразу.
    const extension = extensionOf(trimmed);
    if (extension !== '' && !accept.extensions.includes(extension)) {
      showError(t(accept.error), true);
      return;
    }
    void run(
      () => withHostAccess(pendingKind, nameFromUrl(trimmed), trimmed, hostAccess, onAddUrl),
      true,
    );
  };

  /** Ссылка непустая: до этого кнопки «Добавить» в поле нет. */
  const hasLink = url.trim() !== '';
  // Пока добавление не завершилось, правку не трогаем: иначе легко отправить
  // второй файл или ссылку поверх ещё не законченной индексации.
  const canSubmit = hasLink && !working;

  return (
    <section className="glass-flat space-y-2.5 rounded-3xl p-4">
      <div className="flex items-center justify-between gap-2">
        {/* Обновление вшитого набора стоит сразу за названием группы: так видно, к чему
            оно относится, и не отнимает место у «Добавить» справа. */}
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[11px] font-semibold tracking-[0.12em] text-[var(--muted)] uppercase">
            {title}
          </p>
          {onRefresh && current?.bundled && (
            <button
              type="button"
              title={t('update')}
              onClick={() => void run(onRefresh)}
              className={REFRESH_PILL_CLASS}
            >
              {t('update')}
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {editing ? (
            <button
              type="button"
              className={`${PILL_CLASS} disabled:pointer-events-none disabled:opacity-50`}
              onClick={() => setEditing(false)}
              disabled={working}
            >
              {t('cancel')}
            </button>
          ) : (
            <button
              type="button"
              className={`${PILL_CLASS} disabled:pointer-events-none disabled:opacity-50`}
              onClick={() => setEditing(true)}
              disabled={working}
            >
              {t('add')}
            </button>
          )}
        </div>
      </div>

      {/*
       * Значение и правка живут в слоте одной высоты: переключение режима не меняет
       * высоту секции, а значит и не двигает всё, что ниже в панели. Высоту задаём
       * строкам явно: от текста она выходит дробной и даёт тот самый сдвиг в пиксель.
       */}
      <div className="flex min-h-[23px] flex-col justify-center">
        {!editing && (
          <>
            {current ? (
              <div className="space-y-1">
                <div className="flex h-[23px] items-center gap-2 text-[11px] text-[var(--text-2)]">
                  <span className="min-w-0 flex-1 truncate" title={current.name}>
                    {current.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--muted)]">{current.detail}</span>
                  {/*
                   * Пометка «встроенный» не зависит от того, есть ли у источника
                   * кнопка удаления: у вшитых её нет, а признак нужен.
                   */}
                  {current.bundled ? (
                    <span
                      className="shrink-0 rounded-full bg-[var(--soft)] px-2.5 py-[4px] text-[10px] text-[var(--muted)]"
                      title={t('bundledHint')}
                    >
                      {t('bundled')}
                    </span>
                  ) : (
                    onRemove && (
                      <button
                        type="button"
                        className={DANGER_PILL_CLASS}
                        onClick={() => void run(onRemove)}
                      >
                        {t('remove')}
                      </button>
                    )
                  )}
                </div>

                {/*
                 * Дополнительные источники. Вшитые убрать нельзя — только обновить
                 * кнопкой в заголовке; свои удаляются как обычно.
                 */}
                {extras && extras.length > 0 && (
                  <div className="space-y-1">
                    {extras.map((item) => (
                      <div
                        key={item.id}
                        className="flex h-[23px] items-center gap-2 text-[11px] text-[var(--text-2)]"
                      >
                        <span className="min-w-0 flex-1 truncate" title={item.name}>
                          {item.name}
                        </span>
                        <span className="shrink-0 text-[10px] text-[var(--muted)]">
                          {item.detail}
                        </span>
                        {item.bundled ? (
                          <span
                            className="shrink-0 rounded-full bg-[var(--soft)] px-2.5 py-[4px] text-[10px] text-[var(--muted)]"
                            title={t('bundledHint')}
                          >
                            {t('bundled')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className={DANGER_PILL_CLASS}
                            onClick={() => onRemoveExtra && void run(() => onRemoveExtra(item.id))}
                          >
                            {t('remove')}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[11px] leading-tight text-[var(--muted)]">{emptyText}</p>
            )}
          </>
        )}

        {editing && (
          <div className="flex h-[23px] items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={accept.extensions.join(',')}
              className="hidden"
              disabled={working}
              onChange={(event) => {
                handleFile(event.target.files?.[0] ?? null);
                event.target.value = '';
              }}
            />

            <span className="shrink-0 text-[11px] text-[var(--muted)]">{t('link')}</span>

            {/* Кнопка добавления — внутри поля, а не столбцом рядом: так она не отнимает
                ширину у ссылки и не висит впустую, пока ссылку не ввели. */}
            <div className="relative min-w-0 flex-1">
              <input
                className={`${INPUT_CLASS} ${hasLink ? INPUT_WITH_BUTTON : ''} ${
                  linkError ? INPUT_TONE_ERROR : INPUT_TONE
                }`}
                value={url}
                placeholder={urlPlaceholder}
                disabled={working}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (linkError) clearError();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitUrl();
                }}
              />

              {hasLink && (
                <button
                  type="button"
                  onClick={submitUrl}
                  disabled={working}
                  title={t('addByUrl')}
                  className={`${INLINE_SUBMIT_CLASS} ${
                    canSubmit
                      ? 'cursor-pointer bg-[var(--accent)] font-medium text-white hover:brightness-110'
                      : 'cursor-default bg-[var(--soft-2)] text-[var(--muted)]'
                  }`}
                >
                  {t('add')}
                </button>
              )}
            </div>

            <span className="shrink-0 text-[11px] text-[var(--muted)]">{t('or')}</span>

            <button
              type="button"
              className={`${PILL_CLASS} flex items-center gap-1.5 disabled:pointer-events-none disabled:opacity-50`}
              onClick={() => fileInputRef.current?.click()}
              disabled={working}
            >
              <FileIcon />
              {fileHint}
            </button>
          </div>
        )}
      </div>

      {/* Ошибка секции живёт рядом с ней и гаснет сама: на главной странице она
          оставалась висеть, а исправлять её нужно именно здесь. */}
      {error && <p className="text-[10px] leading-tight text-rose-400">{error}</p>}

      {warning && <div className="flex flex-wrap gap-1">{warning}</div>}

      {working && (
        <div className="flex items-center gap-2 text-[10px] text-[var(--muted)]">
          <Spinner size="sm" />
          <span>{t('processing')}</span>
        </div>
      )}

      {/* В настройках строка прогресса остаётся в потоке: она честно раздвигает
          секцию под себя и ничего не перекрывает. Абсолютное позиционирование
          нужно только на главном экране, где прогресс живёт поверх футера. */}
      {progress && (
        <div className="pointer-events-none">
          <ProgressLine progress={progress} />
        </div>
      )}
    </section>
  );
}

/**
 * Полный список имён из стилей, которых нет в шрифтах: открывается по клику на
 * облачко-предупреждение, потому что в строке секции он не помещается.
 */
function MissingNamesDialog({ names, onClose }: { names: string[]; onClose: () => void }) {
  const t = useT();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-3"
      // Закрываем только окно со списком и не трогаем панель под ним.
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className="flex max-h-full w-full flex-col gap-2 rounded-2xl bg-[var(--panel)] p-3 ring-1 ring-[var(--line)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <h3 className="text-[13px] font-semibold text-[var(--text)]">{t('missingTitle')}</h3>
            <p className="text-[10px] leading-tight text-amber-500">
              {names.length} {t('missingInFont')}
            </p>
            <p className="text-[10px] leading-tight text-[var(--muted)]">{t('missingHint')}</p>
          </div>
          <button
            type="button"
            aria-label={t('close')}
            title={t('close')}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--soft-2)] text-xs text-[var(--text-2)] transition hover:bg-[var(--soft-3)] hover:text-[var(--text)]"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="thin-scroll max-h-[220px] min-h-0 select-text overflow-y-auto rounded-xl bg-[var(--input)] p-2 ring-1 ring-[var(--line)]">
          {names.map((name) => (
            <p key={name} className="font-mono text-[11px] leading-[1.5] text-[var(--text-2)]">
              {name}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Сегментированный переключатель в духе iOS: выбранный вариант — светлая «капсула». */
function Segmented<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  label: string;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="glass-pill flex rounded-full p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={`cursor-pointer rounded-full px-3.5 py-1 text-[12px] transition ${
              active
                ? 'bg-[var(--soft-3)] font-medium text-[var(--text)] shadow-[0_1px_4px_rgb(0_0_0/0.25)]'
                : 'text-[var(--muted)] hover:text-[var(--text)]'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Стеклянная карточка настроек с заголовком. */
function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="glass-flat space-y-2 rounded-3xl p-4">
      {title && (
        <p className="text-[11px] font-semibold tracking-[0.12em] text-[var(--muted)] uppercase">
          {title}
        </p>
      )}
      {children}
    </section>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-[36px] items-center justify-between gap-3 text-[13px] text-[var(--text)]">
      <span className="min-w-0">{label}</span>
      {children}
    </div>
  );
}

export function SettingsPanel({
  fonts,
  styleSources,
  progress,
  hostAccess,
  glyphMissing,
  theme,
  lang,
  updateVersion,
  onUpdate,
  onClose,
  onTheme,
  onLang,
  onAddFontFile,
  onAddFontUrl,
  onAddGlyphFile,
  onAddGlyphUrl,
  onRemoveFont,
  onRemoveStyle,
  onRefreshFonts,
  onRefreshStyles,
}: Props) {
  const t = useT();
  const [closing, setClosing] = useState(false);
  /** Открыто ли окно со списком имён, для которых в шрифтах нет глифа. */
  const [missingOpen, setMissingOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const fontItems: SourceItem[] = fonts.map((font) => ({
    id: font.id,
    name: font.name,
    detail: `${font.glyphCount} ${t('glyphsCount')}`,
    bundled: isBundledSource(font.sourceValue),
  }));
  const styleItems: SourceItem[] = styleSources.map((source) => ({
    id: source.id,
    name: source.name,
    detail: `${source.iconCount} ${t('glyphsCount')}`,
    bundled: isBundledSource(source.sourceValue),
  }));

  /** Кнопка «убрать» есть только у своих источников: вшитые не удаляются. */
  const onRemoveFontOf = (item?: SourceItem) =>
    item && !item.bundled ? () => onRemoveFont(item.id) : undefined;
  const onRemoveStyleOf = (item?: SourceItem) =>
    item && !item.bundled ? () => onRemoveStyle(item.id) : undefined;

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  // Список мог опустеть, пока окно открыто: источники правятся на ходу.
  useEffect(() => {
    if (glyphMissing.length === 0) setMissingOpen(false);
  }, [glyphMissing.length]);

  /**
   * Закрытие с обратной анимацией: сначала проигрываем исчезновение, и только потом
   * родитель размонтирует панель. Иначе окно пропадало рывком.
   */
  const requestClose = useCallback(() => {
    if (closing) return;
    // При отключённой анимации ждать нечего — закрываем сразу.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, CLOSE_ANIM_MS);
  }, [closing, onClose]);

  /**
   * Конец обратной анимации закрывает панель раньше таймера и, что важнее,
   * без него: анимация может не дойти до конца — например, окно браузера
   * в этот момент перекрыли, и рисование вместе с таймерами приостановилось.
   */
  const finishClose = useCallback(() => {
    if (!closing) return;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    onClose();
  }, [closing, onClose]);

  // Escape закрывает панель, пока не открыто вложенное окно со списком.
  useEffect(() => {
    if (missingOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [missingOpen, requestClose]);

  /**
   * Имена из стилей, которых нет в шрифте, искать бессмысленно: их глифов в шрифте
   * просто нет (наборы бывают из разных версий). Без этой подсказки это выглядит
   * как провал распознавания: имя есть в стилях, а в выдаче не появляется никогда.
   */
  const glyphWarning =
    glyphMissing.length > 0 ? (
      <button
        type="button"
        className={WARNING_PILL_CLASS}
        title={t('missingHint')}
        onClick={() => setMissingOpen(true)}
      >
        {glyphMissing.length} {t('missingInFont')}
      </button>
    ) : null;

  return (
    <div
      // Затемнение не анимируется: оно появляется и исчезает вместе с панелью
      // (анимация прозрачности на слое поверх всего интерфейса умеет застывать недорисованной).
      className={`${closing ? 'settings-backdrop-out' : 'settings-backdrop'} absolute inset-0 z-10 flex items-start justify-center overflow-hidden p-2`}
      onClick={requestClose}
    >
      <div
        className={`${closing ? 'settings-card-out' : 'settings-card'} glass-strong flex h-full w-full flex-col rounded-[32px]`}
        // Клик внутри панели не должен её закрывать.
        onClick={(event) => event.stopPropagation()}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) finishClose();
        }}
      >
        <div className="flex shrink-0 items-center justify-between px-4 pt-4 pb-2.5">
          <h2 className="text-[17px] font-semibold tracking-tight text-[var(--text)]">
            {t('settings')}
          </h2>
          <button
            type="button"
            aria-label={t('close')}
            title={t('close')}
            className="glass-pill flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-xs text-[var(--text-2)] transition hover:text-[var(--text)]"
            onClick={requestClose}
          >
            ✕
          </button>
        </div>

        {/* Прокручивается только содержимое: заголовок остаётся на месте. */}
        <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
          <SourceSection
            title={t('sectionDictionary')}
            current={styleItems[0] ?? null}
            extras={styleItems.slice(1)}
            emptyText={t('glyphsEmpty')}
            urlPlaceholder="https://example.com/icons.less"
            fileHint={t('file')}
            pendingKind="less"
            hostAccess={hostAccess}
            onAddFile={onAddGlyphFile}
            onAddUrl={onAddGlyphUrl}
            onRemove={onRemoveStyleOf(styleItems[0])}
            onRemoveExtra={onRemoveStyle}
            onRefresh={onRefreshStyles}
            warning={glyphWarning}
          />

          <SourceSection
            title={t('sectionFont')}
            current={fontItems[0] ?? null}
            extras={fontItems.slice(1)}
            emptyText={t('fontEmpty')}
            urlPlaceholder="https://example.com/icons.woff2"
            fileHint={t('file')}
            pendingKind="font"
            hostAccess={hostAccess}
            onAddFile={onAddFontFile}
            onAddUrl={onAddFontUrl}
            onRemove={onRemoveFontOf(fontItems[0])}
            onRemoveExtra={onRemoveFont}
            onRefresh={onRefreshFonts}
            progress={progress}
          />

          <Card title={t('sectionAppearance')}>
            <Row label={t('theme')}>
              <Segmented<ThemeName>
                label={t('theme')}
                value={theme}
                onChange={onTheme}
                options={[
                  { value: 'light', label: t('themeLight') },
                  { value: 'dark', label: t('themeDark') },
                ]}
              />
            </Row>
            <Row label={t('language')}>
              <Segmented<Lang>
                label={t('language')}
                value={lang}
                onChange={onLang}
                options={[
                  { value: 'ru', label: 'RU' },
                  { value: 'en', label: 'EN' },
                ]}
              />
            </Row>
          </Card>

          {/* О программе — по центру: версия, набор иконок, автор; при новой версии — кнопка. */}
          <div className="flex flex-col items-center gap-1.5 px-1.5 mt-auto pt-1 text-center text-[10px] text-[var(--muted)]">
            <span>
              {t('version')} <span className="font-mono text-[var(--text-2)]">{APP_VERSION}</span>
              {' · '}
              {t('icons')} <span className="font-mono text-[var(--text-2)]">{SABY_VERSION}</span>
              {' · '}
              {APP_AUTHOR}
            </span>
            {updateVersion && onUpdate && (
              <button
                type="button"
                onClick={onUpdate}
                className="h-7 cursor-pointer rounded-full border border-white/30 bg-[var(--accent)] px-4 text-[11px] font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.4)] transition hover:brightness-110"
              >
                {t('updateOpen')} · {updateVersion}
              </button>
            )}
          </div>
        </div>
      </div>

      {missingOpen && (
        <MissingNamesDialog names={glyphMissing} onClose={() => setMissingOpen(false)} />
      )}
    </div>
  );
}
