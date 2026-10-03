import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { extractAlpha } from '../../core/image/binarize';
import { bytesToBase64 } from '../../core/image/bits';
import { SKETCH_SOURCE_SIZE } from '../../shared/constants';
import { getLocal, removeLocal, setLocal } from '../../shared/storage';
import { useT } from '../i18n';

export interface SketchPayload {
  sketch: string;
  width: number;
  height: number;
}

export interface SketchHandle {
  clear(): void;
  undo(): void;
  redo(): void;
  export(): SketchPayload | null;
  isEmpty(): boolean;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

type Tool = 'brush' | 'fill';

/**
 * Итог заливки. `ink` — щелчок пришёлся на сам штрих, `edge` — область дошла
 * до края холста (это уже фон, а не фигура).
 */
type FillOutcome = 'filled' | 'ink' | 'edge';

const CANVAS_WIDTH = 324;
/** Высота задаёт и высоту столбика инструментов: чем выше холст, тем длиннее ползунок. */
const CANVAS_HEIGHT = 226;
const STROKE_RGB = [24, 24, 27] as const;
const STROKE_COLOR = `rgb(${STROKE_RGB[0]}, ${STROKE_RGB[1]}, ${STROKE_RGB[2]})`;
/** Минимум — прежняя толщина, максимум — в пять раз больше. */
const BRUSH_MIN = 4;
const BRUSH_MAX = BRUSH_MIN * 5;
const STORAGE_KEY = 'last-sketch';
const SEARCH_DELAY = 320;
const SAVE_DELAY = 500;
/** Пиксель считается чернилами, если он хотя бы чуть темнее фона холста. */
const INK_ALPHA = 32;
/**
 * Порог «это граница, а не область». Кромка штриха сглажена, поэтому всё, что
 * светлее этого значения, заливка проходит насквозь, а всё, что темнее — стена.
 */
const EDGE_ALPHA = 240;
const MIN_INK_PIXELS = 12;
/** Сколько шагов рисования помним. Снимок — 4 байта на пиксель, поэтому немного. */
const MAX_HISTORY = 24;

interface Props {
  onSketch: (payload: SketchPayload) => void;
  onEmpty: () => void;
  /** Заливка отказалась работать: область доходит до края холста. */
  onFillBlocked?: () => void;
  /** Что можно отменить и что вернуть — для кнопок в заголовке. */
  onHistory?: (state: HistoryState) => void;
  /**
   * Подсказка поверх холста, в правом верхнем углу. Живёт внутри компонента,
   * а не рядом с ним: холст — последний элемент строки, и только тут известно,
   * где именно у него правый верхний угол.
   */
  hint?: string | null;
}

interface HistoryEntry {
  image: ImageData;
  hasInk: boolean;
}

/** Карандаш: минимальный, но однозначный «это инструмент рисования». */
function BrushIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5.5 18.5 6.8 14 17.6 3.2a1.9 1.9 0 0 1 2.7 0l.5.5a1.9 1.9 0 0 1 0 2.7L10 17.2l-4.5 1.3Z" />
      <path d="m15.9 4.9 3.2 3.2" />
    </svg>
  );
}

/** Ведро под наклоном, ручка-дуга и капля: тот же силуэт, что у заливки в редакторах. */
function RollerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
      {/* Ведро нарисовано прямым и повёрнуто целиком: так проще держать форму. */}
      <g transform="translate(9.9 10.2) scale(1.15) translate(-12 -12) rotate(45 12 12)">
        <path
          d="M6.6 7.6H17l-1.4 8.8a1.8 1.8 0 0 1-1.8 1.6H10.2a1.8 1.8 0 0 1-1.8-1.6L6.6 7.6Z"
          fill="currentColor"
        />
        <path
          d="M15.6 7.6h3.2a1 1 0 0 1 .8 1.6l-1.7 2.2a1 1 0 0 1-.8.4h-1.5V7.6Z"
          fill="currentColor"
        />
        <path
          d="M7.9 7.6c0-3.3 1.7-5.1 3.9-5.1s3.9 1.8 3.9 5.1"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </g>
      {/* Капля падает из носика. */}
      <path d="M20.6 16.2c1.3 1.9 2 3.1 2 4a2 2 0 0 1-4 0c0-.9.7-2.1 2-4Z" fill="currentColor" />
    </svg>
  );
}

/**
 * Заливка замкнутой области — как ведро в графическом редакторе.
 *
 * Обход ровно один и только 4-связный: он закрашивает ту область, в которую попал
 * щелчок. Прежняя версия дополнительно закрашивала всё, что «замкнуто контуром»
 * (фон, недостижимый от рамки холста), и это заливало соседние области — например,
 * обе половины круга, разделённого линией.
 *
 * Граница — почти непрозрачное ядро штриха, а не любой пиксель с чернилами: canvas
 * сглаживает край, и кромка штриха — это смесь чернил с фоном холста. Если считать
 * границей такие пиксели, заливка встаёт раньше времени и вдоль контура остаётся
 * светлая пунктирная полоска. Порог `EDGE_ALPHA` пропускает кромку и упирается
 * в ядро: там пиксель почти непрозрачен, а его цвет и так совпадает с заливкой.
 *
 * Область, дошедшая до края холста, не заливается совсем: это фон, и одним щелчком
 * по нему закрасился бы весь холст вместе с рисунком.
 */
function floodFill(canvas: HTMLCanvasElement, startX: number, startY: number): FillOutcome {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return 'ink';

  const { width, height } = canvas;
  const x0 = Math.round(startX);
  const y0 = Math.round(startY);
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return 'ink';

  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const startIndex = y0 * width + x0;
  // Щелчок по самому штриху ничего не заливает: это граница, а не область.
  if (data[startIndex * 4 + 3] >= EDGE_ALPHA) return 'ink';

  // Каждый пиксель помечается при постановке в стек, поэтому дублей не будет
  // и стек гарантированно не переполнится.
  const stack = new Int32Array(width * height);
  const filledMask = new Uint8Array(width * height);
  let top = 0;
  let filled = 0;

  const paint = (index: number): void => {
    const offset = index * 4;
    data[offset] = STROKE_RGB[0];
    data[offset + 1] = STROKE_RGB[1];
    data[offset + 2] = STROKE_RGB[2];
    data[offset + 3] = 255;
    filledMask[index] = 1;
  };

  const tryPush = (index: number): void => {
    if (filledMask[index]) return;
    if (data[index * 4 + 3] >= EDGE_ALPHA) return;
    paint(index);
    filled += 1;
    stack[top] = index;
    top += 1;
  };

  tryPush(startIndex);

  while (top > 0) {
    top -= 1;
    const index = stack[top];
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) tryPush(index - 1);
    if (x < width - 1) tryPush(index + 1);
    if (y > 0) tryPush(index - width);
    if (y < height - 1) tryPush(index + width);
  }

  if (filled === 0) return 'ink';

  /*
   * Заливка дошла до края холста — значит, щёлкнули по фону. Такую область
   * не заливаем: иначе одним нажатием закрасится весь холст вместе с рисунком.
   */
  let touchesEdge = false;
  for (let x = 0; x < width && !touchesEdge; x += 1) {
    if (filledMask[x] || filledMask[(height - 1) * width + x]) touchesEdge = true;
  }
  for (let y = 0; y < height && !touchesEdge; y += 1) {
    if (filledMask[y * width] || filledMask[y * width + width - 1]) touchesEdge = true;
  }
  if (touchesEdge) return 'edge';

  context.putImageData(image, 0, 0);
  return 'filled';
}

export const SketchCanvas = forwardRef<SketchHandle, Props>(function SketchCanvas(
  { onSketch, onEmpty, onFillBlocked, onHistory, hint },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const searchTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const callbacks = useRef({ onSketch, onEmpty, onFillBlocked, onHistory });
  callbacks.current = { onSketch, onEmpty, onFillBlocked, onHistory };

  /** Стек состояний холста: [0] — пустой лист, дальше каждый законченный штрих. */
  const history = useRef<HistoryEntry[]>([]);
  const historyIndex = useRef(-1);

  const [tool, setTool] = useState<Tool>('brush');
  const [brushWidth, setBrushWidth] = useState(BRUSH_MIN);
  const t = useT();

  const snapshot = useCallback((): HistoryEntry | null => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d', { willReadFrequently: true });
    if (!canvas || !context) return null;
    return {
      image: context.getImageData(0, 0, canvas.width, canvas.height),
      hasInk: hasInk.current,
    };
  }, []);

  const emitHistory = useCallback(() => {
    callbacks.current.onHistory?.({
      canUndo: historyIndex.current > 0,
      canRedo: historyIndex.current >= 0 && historyIndex.current < history.current.length - 1,
    });
  }, []);

  /** Кладём текущее состояние в историю. Вызывается после каждого законченного действия. */
  const commit = useCallback(() => {
    const entry = snapshot();
    if (!entry) return;
    history.current = history.current.slice(0, historyIndex.current + 1);
    history.current.push(entry);
    if (history.current.length > MAX_HISTORY) history.current.shift();
    historyIndex.current = history.current.length - 1;
    emitHistory();
  }, [emitHistory, snapshot]);

  const resetHistory = useCallback(() => {
    const entry = snapshot();
    history.current = entry ? [entry] : [];
    historyIndex.current = history.current.length - 1;
    emitHistory();
  }, [emitHistory, snapshot]);

  const applyEntry = useCallback((entry: HistoryEntry) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.putImageData(entry.image, 0, 0);
    hasInk.current = entry.hasInk;
    lastPoint.current = null;
    drawing.current = false;
  }, []);

  const exportSketch = useCallback((): SketchPayload | null => {
    const source = canvasRef.current;
    if (!source || !hasInk.current) return null;

    const temp = document.createElement('canvas');
    temp.width = SKETCH_SOURCE_SIZE;
    temp.height = SKETCH_SOURCE_SIZE;
    const context = temp.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    const scale = Math.min(SKETCH_SOURCE_SIZE / source.width, SKETCH_SOURCE_SIZE / source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    context.drawImage(
      source,
      (SKETCH_SOURCE_SIZE - width) / 2,
      (SKETCH_SOURCE_SIZE - height) / 2,
      width,
      height,
    );

    const image = context.getImageData(0, 0, SKETCH_SOURCE_SIZE, SKETCH_SOURCE_SIZE);
    const alpha = extractAlpha(image.data, SKETCH_SOURCE_SIZE, SKETCH_SOURCE_SIZE);

    let ink = 0;
    for (let i = 0; i < alpha.length; i += 1) {
      if (alpha[i] >= INK_ALPHA) ink += 1;
    }
    if (ink < MIN_INK_PIXELS) return null;

    return {
      sketch: bytesToBase64(alpha),
      width: SKETCH_SOURCE_SIZE,
      height: SKETCH_SOURCE_SIZE,
    };
  }, []);

  const scheduleSearch = useCallback(() => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      const payload = exportSketch();
      if (payload) callbacks.current.onSketch(payload);
      else callbacks.current.onEmpty();
    }, SEARCH_DELAY);
  }, [exportSketch]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (!hasInk.current) {
        void removeLocal(STORAGE_KEY);
        return;
      }
      void setLocal(STORAGE_KEY, canvas.toDataURL('image/png'));
    }, SAVE_DELAY);
  }, []);

  /** Шаг по истории: -1 — отменить, +1 — вернуть. */
  const step = useCallback(
    (delta: number) => {
      const next = historyIndex.current + delta;
      const entry = history.current[next];
      if (!entry) return;

      historyIndex.current = next;
      applyEntry(entry);
      emitHistory();
      // Набросок изменился — значит нужно и найти заново, и сохранить.
      if (hasInk.current) scheduleSearch();
      else callbacks.current.onEmpty();
      scheduleSave();
    },
    [applyEntry, emitHistory, scheduleSave, scheduleSearch],
  );

  useImperativeHandle(
    ref,
    () => ({
      clear() {
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;
        const wasEmpty = !hasInk.current;
        context.clearRect(0, 0, canvas.width, canvas.height);
        hasInk.current = false;
        lastPoint.current = null;
        void removeLocal(STORAGE_KEY);
        callbacks.current.onEmpty();
        // Стирание — тоже шаг истории: рисунок возвращается кнопкой «вернуть».
        if (!wasEmpty) commit();
      },
      undo: () => step(-1),
      redo: () => step(1),
      export: exportSketch,
      isEmpty: () => !hasInk.current,
    }),
    [commit, exportSketch, resetHistory, step],
  );

  // Восстанавливаем прошлый набросок: popup легко закрыть случайным кликом.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    void getLocal<string>(STORAGE_KEY).then((dataUrl) => {
      if (typeof dataUrl !== 'string') return;

      const image = new Image();
      image.onload = () => {
        const context = canvas.getContext('2d');
        if (!context) return;
        // Только уменьшаем: если сохранённый снимок меньше холста (например, canvas
        // был другого размера), растягивать его нельзя — штрихи распухают.
        const scale = Math.min(1, canvas.width / image.width, canvas.height / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(
          image,
          (canvas.width - width) / 2,
          (canvas.height - height) / 2,
          width,
          height,
        );
        hasInk.current = true;
        resetHistory();
        scheduleSearch();
      };
      image.src = dataUrl;
    });
  }, [resetHistory, scheduleSearch]);

  useEffect(
    () => () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = pointFromEvent(event);

    if (tool === 'fill') {
      const outcome = floodFill(event.currentTarget, point.x, point.y);
      if (outcome === 'filled') {
        hasInk.current = true;
        commit();
        scheduleSearch();
        scheduleSave();
      } else if (outcome === 'edge') {
        // Молча ничего не делать нельзя: непонятно, сработало ли нажатие.
        callbacks.current.onFillBlocked?.();
      }
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const context = event.currentTarget.getContext('2d');
    drawing.current = true;
    lastPoint.current = point;
    hasInk.current = true;
    if (!context) return;
    context.fillStyle = STROKE_COLOR;
    context.beginPath();
    context.arc(point.x, point.y, brushWidth / 2, 0, Math.PI * 2);
    context.fill();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    const point = pointFromEvent(event);
    const previous = lastPoint.current ?? point;
    context.strokeStyle = STROKE_COLOR;
    context.lineWidth = brushWidth;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPoint.current = point;
  };

  const handlePointerUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    lastPoint.current = null;
    commit();
    scheduleSearch();
    scheduleSave();
  };

  const toolClass = (active: boolean): string =>
    `flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl transition ${
      active
        ? 'bg-[var(--accent)] text-white'
        : 'bg-[var(--soft-2)] text-[var(--text-2)] hover:bg-[var(--soft-3)] hover:text-[var(--text)]'
    }`;

  return (
    <div className="flex shrink-0 items-stretch gap-2">
      {/* Столбик инструментов ровно той же высоты, что и холст: иначе ползунок
          и кружок толщины уезжают ниже края канвы. */}
      <div
        className="flex w-9 shrink-0 flex-col items-center gap-1.5"
        style={{ height: CANVAS_HEIGHT }}
      >
        <button
          type="button"
          className={toolClass(tool === 'brush')}
          onClick={() => setTool('brush')}
          aria-label={t('brush')}
          title={t('brush')}
        >
          <BrushIcon />
        </button>
        <button
          type="button"
          className={toolClass(tool === 'fill')}
          onClick={() => setTool('fill')}
          aria-label={t('fill')}
          title={t('fill')}
        >
          <RollerIcon />
        </button>

        {/* Толщина нужна только кисти: заливка заливает область целиком. */}
        {tool === 'brush' && (
          <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 pt-1">
            {/* Слот фиксированной высоты: кружок растёт внутри него и не сдвигает
                ползунок — иначе при увеличении толщины ползунок становится короче. */}
            <span className="flex h-6 w-full shrink-0 items-center justify-center">
              {/* Кружок — ровно та толщина, которой рисует кисть: 1 px канвы = 1 px экрана. */}
              <span
                className="rounded-full bg-[var(--text-2)]"
                style={{ width: brushWidth, height: brushWidth }}
              />
            </span>
            <input
              type="range"
              min={BRUSH_MIN}
              max={BRUSH_MAX}
              step={2}
              value={brushWidth}
              onChange={(event) => setBrushWidth(Number(event.target.value))}
              className="brush-slider"
              aria-label={t('brushWidth')}
            />
          </div>
        )}
      </div>

      {/* Холст и его подсказка — одна относительная коробка: угол подсказки
          считается от кромки холста, а не от всей строки с инструментами. */}
      <div className="relative shrink-0">
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerUp}
          className={`block shrink-0 touch-none rounded-xl bg-[var(--canvas)] ring-1 ring-[var(--canvas-line)] ${
            tool === 'fill' ? 'cursor-copy' : 'cursor-crosshair'
          }`}
          style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
        />

        {/* Холст светлый в обеих темах, поэтому подсказка — тёмная плашка: янтарный
            текст на белом холсте не читался, а тут виден с любого фона. */}
        {hint && (
          <p
            role="status"
            className="pointer-events-none absolute top-2 right-2 max-w-[80%] rounded-lg bg-zinc-900/85 px-2 py-1 text-[10px] leading-tight text-amber-300"
          >
            {hint}
          </p>
        )}
      </div>
    </div>
  );
});
