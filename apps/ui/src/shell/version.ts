/**
 * The bundle's versions. `UI_API` is the interface API this page speaks: the daemon's snapshot
 * carries its own `ui_api`, and a page whose number differs asks to be reloaded (plan §7.1).
 */
export const UI_API = 1;

/** Shown in Settings → About. */
export const UI_VERSION = '0.1.0';

declare const __FRIDAY_BUILT__: string | undefined;

/** When this bundle was built (ISO), set by the build; null in tests and the dev server's first load. */
export const UI_BUILT: string | null = typeof __FRIDAY_BUILT__ === 'string' ? __FRIDAY_BUILT__ : null;

/** "18 Nov, 00:17" in the person's own time, or '' when the build did not say. */
export function builtWords(iso: string | null = UI_BUILT): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "Friday 0.1.0 · built 18 Nov, 00:17": what tells two builds of one version apart. */
export function versionWords(iso: string | null = UI_BUILT): string {
  const built = builtWords(iso);
  return built ? `Friday ${UI_VERSION} · built ${built}` : `Friday ${UI_VERSION}`;
}
