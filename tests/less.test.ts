import { describe, expect, it } from 'vitest';
import { decodeCssEscapes, parseLessIcons } from '../src/core/less/parseLess';

const SAMPLE = `
.icon-Button::before {
   content: '\\eb7e';
}

.icon-Antiseptic::before {
   content: '\\eb7f';
}

.icon-ClientChat::before {
   content: '\\eb80';
}
`;

describe('decodeCssEscapes', () => {
  it('раскрывает шестнадцатеричные escape-последовательности', () => {
    expect(decodeCssEscapes('\\eb7e')).toBe('\uEB7E');
    expect(decodeCssEscapes('\\e900')).toBe('\uE900');
    expect(decodeCssEscapes('\\0021')).toBe('!');
  });

  it('раскрывает экранированные литералы', () => {
    expect(decodeCssEscapes('\\+')).toBe('+');
  });

  it('оставляет обычный текст как есть', () => {
    expect(decodeCssEscapes('ab')).toBe('ab');
  });
});

describe('parseLessIcons', () => {
  it('разбирает пример из реальных стилей', () => {
    const icons = parseLessIcons(SAMPLE);
    expect(icons).toEqual([
      { codePoint: 0xeb7e, className: 'icon-Button' },
      { codePoint: 0xeb7f, className: 'icon-Antiseptic' },
      { codePoint: 0xeb80, className: 'icon-ClientChat' },
    ]);
  });

  it('понимает двойные кавычки и лишние пробелы', () => {
    const icons = parseLessIcons('.icon-A::before{content:"\\e001";}');
    expect(icons).toEqual([{ codePoint: 0xe001, className: 'icon-A' }]);
  });

  it('находит иконки внутри вложенных блоков, например @media', () => {
    const icons = parseLessIcons(`
      @media (min-width: 100px) {
        .icon-B::before { content: '\\e002'; }
      }
    `);
    expect(icons).toEqual([{ codePoint: 0xe002, className: 'icon-B' }]);
  });

  it('берёт первый класс, если в селекторе их несколько', () => {
    const icons = parseLessIcons('.icon-C, .icon-D { content: "\\e003"; }');
    expect(icons).toEqual([{ codePoint: 0xe003, className: 'icon-C' }]);
  });

  it('сохраняет нелатинские буквы в имени класса', () => {
    // В наборе Saby есть `.icon-Сollapse` с кириллической «С».
    const icons = parseLessIcons(".icon-Сollapse::before { content: '\\ebc0'; }");
    expect(icons).toEqual([{ codePoint: 0xebc0, className: 'icon-Сollapse' }]);
  });

  it('пропускает служебные значения content', () => {
    const icons = parseLessIcons(`
      .clearfix { content: ''; }
      .hidden { content: none; }
      .reset { content: normal; }
      .icon-E { content: '\\e004'; }
    `);
    expect(icons).toEqual([{ codePoint: 0xe004, className: 'icon-E' }]);
  });

  it('пропускает content из нескольких символов', () => {
    const icons = parseLessIcons(`
      .icon-bad { content: 'ab'; }
      .icon-also-bad { content: '\\e005\\e006'; }
      .icon-F { content: '\\e007'; }
    `);
    expect(icons).toEqual([{ codePoint: 0xe007, className: 'icon-F' }]);
  });

  it('игнорирует правила без класса в селекторе', () => {
    const icons = parseLessIcons(`
      :root { content: '\\e008'; }
      .icon-G { content: '\\e009'; }
    `);
    expect(icons).toEqual([{ codePoint: 0xe009, className: 'icon-G' }]);
  });

  it('при дубле кодпоинта оставляет первое объявление', () => {
    const icons = parseLessIcons(`
      .icon-First { content: '\\e00a'; }
      .icon-Second { content: '\\e00a'; }
    `);
    expect(icons).toEqual([{ codePoint: 0xe00a, className: 'icon-First' }]);
  });

  it('на пустом файле возвращает пустой список', () => {
    expect(parseLessIcons('// только комментарий')).toEqual([]);
  });
});
