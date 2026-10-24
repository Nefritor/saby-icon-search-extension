import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface ToolItem<T extends string> {
  id: T;
  label: string;
  title: string;
  icon: ReactNode;
}

interface Props<T extends string> {
  value: T;
  items: ToolItem<T>[];
  ariaLabel: string;
  onChange: (id: T) => void;
}

/** Ячейка значка: ширина и высота капсулы без подписи. */
const SLOT = 32;
/** Внутренний отступ контейнера. */
const PAD = 2;
/** Рамка контейнера `.glass-pill`. */
const BORDER = 1;
/** Длительность смены инструмента, мс. */
const MOVE_MS = 220;

/**
 * Переключатель инструментов: у выбранного показана подпись, у остальных только значок.
 * Ширина всего переключателя постоянна (рассчитана на самую длинную подпись), поэтому соседние
 * элементы не двигаются; капсула выбранного инструмента плавно переезжает и меняет ширину.
 * Ширину подписей измеряем, а положение считаем по сетке из одинаковых ячеек.
 */
export function ToolSwitch<T extends string>({ value, items, ariaLabel, onChange }: Props<T>) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const measureRefs = useRef<Record<string, HTMLSpanElement | null>>({});

  // Ширина каждой подписи в натуральную величину; пересчитывается при смене языка.
  const labelKey = items.map((item) => item.label).join('|');
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    for (const item of items) next[item.id] = measureRefs.current[item.id]?.offsetWidth ?? 0;
    setWidths(next);
  }, [labelKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const thumbIndex = Math.max(
    0,
    items.findIndex((item) => item.id === value),
  );
  // Ширина всего переключателя неизменна: она рассчитана на самую длинную подпись,
  // а выбранная ячейка занимает всё место, не занятое двумя значками. Меняется только
  // капсула внутри, поэтому соседние элементы (слайдер) не прыгают.
  const longest = Math.max(0, ...items.map((item) => widths[item.id] ?? 0));
  // +2: рамка стеклянного контейнера (по 1 px) входит в его ширину и иначе съедала бы место.
  const total = BORDER * 2 + PAD * 2 + SLOT * (items.length - 1) + SLOT + longest + 14;
  const expandedWidth = total - BORDER * 2 - PAD * 2 - SLOT * (items.length - 1);
  const thumbWidth = expandedWidth;
  const easing = 'cubic-bezier(0.4, 0, 0.2, 1)';

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="glass-pill relative flex shrink-0 rounded-full"
      style={{ padding: PAD, width: total }}
    >
      {/* Капсула выбранного инструмента: двигается и меняет ширину плавно. */}
      <span
        aria-hidden="true"
        className="absolute rounded-full bg-[var(--soft-3)] shadow-[0_1px_4px_rgb(0_0_0/0.25)]"
        style={{
          top: PAD,
          height: SLOT,
          width: thumbWidth,
          transform: `translateX(${thumbIndex * SLOT}px)`,
          left: PAD,
          transition: `width ${MOVE_MS}ms ${easing}, transform ${MOVE_MS}ms ${easing}`,
        }}
      />

      {items.map((item) => {
        const active = item.id === value;
        const open = active;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={item.label}
            title={item.title}
            onClick={() => onChange(item.id)}
            className={`relative z-[1] flex h-8 cursor-pointer items-center overflow-hidden rounded-full transition-colors ${
              active ? 'text-[var(--text)]' : 'text-[var(--muted)] hover:text-[var(--text)]'
            }`}
            style={{
              width: open ? expandedWidth : SLOT,
              transition: `width ${MOVE_MS}ms ${easing}, color 150ms`,
            }}
          >
            <span className="flex shrink-0 items-center justify-center" style={{ width: SLOT }}>
              {item.icon}
            </span>
            <span
              className="text-[12px] font-medium whitespace-nowrap"
              style={{ opacity: open ? 1 : 0, transition: `opacity ${MOVE_MS - 40}ms` }}
            >
              {item.label}
            </span>
          </button>
        );
      })}

      {/* Невидимые копии подписей — только чтобы измерить их ширину. */}
      <div aria-hidden="true" className="pointer-events-none invisible absolute -z-10">
        {items.map((item) => (
          <span
            key={item.id}
            ref={(node) => {
              measureRefs.current[item.id] = node;
            }}
            className="inline-block text-[12px] font-medium whitespace-nowrap"
          >
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
