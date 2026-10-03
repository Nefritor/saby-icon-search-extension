import type { ProgressPush } from '../../shared/messaging';
import { useT, type TranslationKey } from '../i18n';

const PHASE_KEYS: Record<ProgressPush['phase'], TranslationKey> = {
  fetch: 'phaseFetch',
  scan: 'phaseScan',
  index: 'phaseIndex',
};

export function ProgressLine({ progress }: { progress: ProgressPush }) {
  const t = useT();
  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2 text-[10px] text-[var(--muted)]">
        <span className="truncate">
          {progress.fontName} — {t(PHASE_KEYS[progress.phase])}
        </span>
        <span className="shrink-0 font-mono">{percent}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-[var(--soft-2)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
