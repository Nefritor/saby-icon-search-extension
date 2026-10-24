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
import { ToolSwitch } from './ToolSwitch';

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

type Tool = 'brush' | 'eraser' | 'fill';

/**
 * Итог заливки. `ink` — щелчок пришёлся на сам штрих, `edge` — область дошла
 * до края холста (это уже фон, а не фигура).
 */
type FillOutcome = 'filled' | 'ink' | 'edge';

/**
 * Внутренний размер холста. Движок рассчитан на масштаб именно такой ширины (толщина кисти
 * 4 px → 1,6 px в растре 128×128), поэтому на экране холст только растягивается по CSS,
 * а его размер в пикселях остаётся прежним.
 */
const CANVAS_WIDTH = 324;
const CANVAS_HEIGHT = 170;
const STROKE_RGB = [24, 24, 27] as const;
const STROKE_COLOR = `rgb(${STROKE_RGB[0]}, ${STROKE_RGB[1]}, ${STROKE_RGB[2]})`;
/** Минимум — прежняя толщина, максимум — в пять раз больше. */
const BRUSH_MIN = 4;
const BRUSH_MAX = BRUSH_MIN * 5;
const STORAGE_KEY = 'last-sketch';
/**
 * Сглаживание штриха: доля пути, на которую кисть отстаёт от курсора (как «стабилизация»
 * в Fresco или Procreate). Режим один — сильный: дрожащая рука не ломает форму.
 */
const SMOOTHING = 0.75;
/** Ластик шире кисти: стирать узкой линией неудобно. */
const ERASER_SCALE = 1.6;
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
/** Инструменты в порядке на панели: клавиша, подпись и значок. */
const TOOLS: Array<{
  id: Tool;
  labelKey: 'brush' | 'eraser' | 'fill';
  key: string;
  Icon: () => React.JSX.Element;
}> = [
  { id: 'brush', labelKey: 'brush', key: 'B', Icon: () => <BrushIcon /> },
  { id: 'eraser', labelKey: 'eraser', key: 'E', Icon: () => <EraserIcon /> },
  { id: 'fill', labelKey: 'fill', key: 'F', Icon: () => <RollerIcon /> },
];

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

/** Ластик: скошенный брусок с линией стирания. */
function EraserIcon() {
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
      <path d="m7 21-4-4a2 2 0 0 1 0-2.8l10.2-10.2a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8L11 21" />
      <path d="M7 21h13M9 9l6 6" />
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
  /** Сглаженное положение кисти и середина последнего отрезка: по ним строятся кривые. */
  const smoothed = useRef<{ x: number; y: number } | null>(null);
  const lastMid = useRef<{ x: number; y: number } | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
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
    try {
      return {
        image: context.getImageData(0, 0, canvas.width, canvas.height),
        hasInk: hasInk.current,
      };
    } catch {
      // Снимок нужен только для отмены: сбой чтения не должен ломать рисование.
      return null;
    }
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
    const context = canvas?.getContext('2d', { willReadFrequently: true });
    if (!canvas || !context) return;
    context.putImageData(entry.image, 0, 0);
    hasInk.current = entry.hasInk;
    smoothed.current = null;
    lastMid.current = null;
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
        const context = canvas?.getContext('2d', { willReadFrequently: true });
        if (!canvas || !context) return;
        const wasEmpty = !hasInk.current;
        context.clearRect(0, 0, canvas.width, canvas.height);
        hasInk.current = false;
        smoothed.current = null;
        lastMid.current = null;
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
        const context = canvas.getContext('2d', { willReadFrequently: true });
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

  // Горячие клавиши: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — история, B / E / F — инструменты.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const key = event.key.toLowerCase();
      const code = event.code;
      if (event.ctrlKey || event.metaKey) {
        if (code === 'KeyZ') {
          event.preventDefault();
          step(event.shiftKey ? 1 : -1);
        } else if (code === 'KeyY') {
          event.preventDefault();
          step(1);
        }
        return;
      }
      if (event.altKey) return;
      if (code === 'KeyB' || key === 'b') setTool('brush');
      else if (code === 'KeyE' || key === 'e') setTool('eraser');
      else if (code === 'KeyF' || key === 'f') setTool('fill');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [step]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  /** Реальная толщина текущего инструмента, px холста. */
  const strokeWidth = tool === 'eraser' ? brushWidth * ERASER_SCALE : brushWidth;

  /** Кольцо-превью повторяет толщину кисти или ластика прямо под курсором. */
  const moveCursor = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const ring = cursorRef.current;
    if (!ring) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const diameter = strokeWidth * (rect.width / event.currentTarget.width);
    ring.style.width = `${diameter}px`;
    ring.style.height = `${diameter}px`;
    ring.style.transform = `translate(${event.clientX - rect.left - diameter / 2}px, ${
      event.clientY - rect.top - diameter / 2
    }px)`;
    ring.style.opacity = '1';
  };

  const hideCursor = () => {
    if (cursorRef.current) cursorRef.current.style.opacity = '0';
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    // Рисуем только основной кнопкой: правый клик вызывал контекстное меню и оставлял точку.
    if (event.pointerType === 'mouse' && event.button !== 0) return;
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
    const context = event.currentTarget.getContext('2d', { willReadFrequently: true });
    drawing.current = true;
    smoothed.current = point;
    lastMid.current = point;
    hasInk.current = true;
    if (!context) return;
    context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    context.fillStyle = STROKE_COLOR;
    context.beginPath();
    context.arc(point.x, point.y, strokeWidth / 2, 0, Math.PI * 2);
    context.fill();
  };

  /** Один шаг штриха: кривая от прошлой середины к новой, а прошлая точка — опорная. */
  const strokeTo = (context: CanvasRenderingContext2D, target: { x: number; y: number }) => {
    const previous = smoothed.current;
    const from = lastMid.current;
    if (!previous || !from) return;

    const follow = 1 - SMOOTHING;
    const next = {
      x: previous.x + (target.x - previous.x) * follow,
      y: previous.y + (target.y - previous.y) * follow,
    };
    const mid = { x: (previous.x + next.x) / 2, y: (previous.y + next.y) / 2 };

    context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    context.strokeStyle = STROKE_COLOR;
    context.lineWidth = strokeWidth;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.quadraticCurveTo(previous.x, previous.y, mid.x, mid.y);
    context.stroke();

    smoothed.current = next;
    lastMid.current = mid;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    moveCursor(event);
    if (!drawing.current) return;
    const context = event.currentTarget.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    // Браузер склеивает быстрые движения в одно событие: берём все промежуточные точки,
    // иначе при быстром рисовании линия превращалась бы в ломаную.
    const native = event.nativeEvent;
    const batch =
      typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const events = batch.length > 0 ? batch : [native];
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    for (const item of events) {
      strokeTo(context, {
        x: ((item.clientX - rect.left) / rect.width) * canvas.width,
        y: ((item.clientY - rect.top) / rect.height) * canvas.height,
      });
    }
  };

  const handlePointerUp = (event?: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;

    // Кисть отстаёт от курсора: на отпускании дотягиваем линию до последней точки.
    if (event && smoothed.current) {
      const canvas = event.currentTarget;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const rect = canvas.getBoundingClientRect();
      const end = {
        x: ((event.clientX - rect.left) / rect.width) * canvas.width,
        y: ((event.clientY - rect.top) / rect.height) * canvas.height,
      };
      if (context) {
        for (let i = 0; i < 12; i += 1) strokeTo(context, end);
        const last = lastMid.current;
        if (last) {
          context.beginPath();
          context.moveTo(last.x, last.y);
          context.lineTo(end.x, end.y);
          context.stroke();
        }
      }
    }

    smoothed.current = null;
    lastMid.current = null;
    commit();
    scheduleSearch();
    scheduleSave();
  };

  return (
    <div className="flex shrink-0 flex-col gap-2">
      {/* Инструменты — трёхпозиционный переключатель: у выбранного показано название,
          у остальных только значок. Если места мало (узкий контейнер), названия скрываются. */}
      <div className="@container flex h-9 items-center gap-3">
        <ToolSwitch<Tool>
          value={tool}
          onChange={setTool}
          ariaLabel={t('tool')}
          items={TOOLS.map(({ id, labelKey, key, Icon }) => ({
            id,
            label: t(labelKey),
            title: `${t(labelKey)} (${key})`,
            icon: <Icon />,
          }))}
        />

        {/* Толщина нужна кисти и ластику: заливка заливает область целиком. */}
        {tool !== 'fill' && (
          <input
            type="range"
            min={BRUSH_MIN}
            max={BRUSH_MAX}
            step={0.1}
            value={brushWidth}
            onChange={(event) => setBrushWidth(Number(event.target.value))}
            className="brush-slider"
            style={{
              ['--fill' as string]: `${((brushWidth - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)) * 100}%`,
            }}
            aria-label={t('brushWidth')}
          />
        )}
      </div>

      {/* Холст и его подсказка — одна относительная коробка: угол подсказки
          считается от кромки холста. */}
      <div className="relative">
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => handlePointerUp()}
          onPointerLeave={() => {
            hideCursor();
            handlePointerUp();
          }}
          onContextMenu={(event) => event.preventDefault()}
          className={`block w-full touch-none rounded-3xl border border-[var(--canvas-line)] bg-[var(--canvas)] shadow-[inset_0_1px_0_rgb(255_255_255/0.9),0_14px_30px_-16px_rgb(0_0_0/0.55)] ${
            tool === 'fill' ? 'cursor-copy' : 'cursor-none'
          }`}
          style={{ aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}` }}
        />

        {/* Кольцо-превью: диаметр равен толщине кисти (у ластика — пунктир). */}
        {tool !== 'fill' && (
          <div
            ref={cursorRef}
            aria-hidden="true"
            className={`pointer-events-none absolute top-0 left-0 rounded-full border border-zinc-900/70 opacity-0 transition-opacity duration-100 ${
              tool === 'eraser' ? 'border-dashed bg-white/40' : 'bg-zinc-900/10'
            }`}
          />
        )}

        {/* Холст светлый в обеих темах, поэтому подсказка — тёмная плашка. */}
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
