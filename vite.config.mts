import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { zipDirectory } from './scripts/zip.ts';

/** Каталог проекта: `__dirname` в ESM-конфиге недоступен. */
const root = import.meta.dirname;

/**
 * Имя папки расширения и архива рядом с ней. Одно и то же: архив распаковывается
 * ровно в такую папку, поэтому его и прикладывают к релизу на GitHub как есть.
 */
const RELEASE_NAME = 'saby-icon-search-extension';

/**
 * Vite сам собирает в `dist/`, а этот плагин перекладывает готовое в `dist/<имя>/`
 * и пакует рядом zip того же содержимого. Второй шаг в `npm run build` не нужен,
 * а `public/` с иконками и вшитыми файлами попадает в архив вместе с остальным.
 */
function releasePackage(): Plugin {
  return {
    name: 'saby-icon-search-release',
    apply: 'build',
    closeBundle() {
      const dist = resolve(root, 'dist');
      const folder = resolve(dist, RELEASE_NAME);
      mkdirSync(folder, { recursive: true });

      for (const name of readdirSync(dist)) {
        if (name === RELEASE_NAME) continue;
        const entry = resolve(dist, name);
        // Архив от прошлой сборки не перекладываем — он пересоберётся ниже.
        if (name === `${RELEASE_NAME}.zip`) rmSync(entry, { force: true, recursive: true });
        else renameSync(entry, resolve(folder, name));
      }

      const zip = zipDirectory(folder, resolve(dist, `${RELEASE_NAME}.zip`));
      this.info(
        `расширение: dist/${RELEASE_NAME}, архив: dist/${RELEASE_NAME}.zip ` +
          `(${zip.files} файлов, ${Math.round(zip.zipBytes / 1024)} КБ из ${Math.round(zip.rawBytes / 1024)} КБ)`,
      );
    },
  };
}

/**
 * Автор и версии берутся из package.json и подставляются в код сборкой:
 * в интерфейсе они показываются в панели настроек, и второе место правки не нужно.
 */
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  version: string;
  author: string;
  'saby-version': string;
};

/**
 * Сборка MV3-расширения: popup + offscreen-документ + service worker.
 * Никакого dev-сервера — расширение грузится из dist/ как unpacked.
 */
export default defineConfig({
  plugins: [tailwindcss(), releasePackage()],
  publicDir: 'public',
  define: {
    __APP_AUTHOR__: JSON.stringify(pkg.author),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __SABY_VERSION__: JSON.stringify(pkg['saby-version']),
  },
  server: {
    port: 5173,
    // `npm run dev` должен сам собрать стенд и открыть его в браузере.
    open: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        popup: resolve(root, 'popup.html'),
        offscreen: resolve(root, 'offscreen.html'),
        'service-worker': resolve(root, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
      // HeroUI и Radix помечают модули директивой "use client" для React Server Components.
      // В расширении это не имеет смысла, а Rolldown предупреждает про каждый такой файл.
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
    },
  },
});
