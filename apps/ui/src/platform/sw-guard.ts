/**
 * The service-worker guard (plan §7.1, FD-04, LESSONS UI-24). The address `http://127.0.0.1:<port>`
 * may have been served earlier by another program that registered a service worker, which would
 * then run inside Friday's page. Before anything else the page checks: when a worker controls it
 * or any registration exists, it unregisters them all and answers `removed`, and the page then
 * neither exchanges a login code nor calls the daemon. It never throws and never hangs.
 */

export type GuardResult = 'clean' | 'removed';

/** How long the guard waits for the browser to list registrations. */
export const GUARD_TIMEOUT_MS = 2000;

type MinimalRegistration = Pick<ServiceWorkerRegistration, 'unregister'>;

interface MinimalContainer {
  readonly controller: unknown;
  getRegistrations(): Promise<readonly MinimalRegistration[]>;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export async function guardServiceWorkers(
  nav: Pick<Navigator, 'serviceWorker'> | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): Promise<GuardResult> {
  let container: MinimalContainer | undefined;
  try {
    container = (nav as { serviceWorker?: MinimalContainer } | undefined)?.serviceWorker;
  } catch {
    return 'clean';
  }
  if (!container) return 'clean';
  let controlled = false;
  try {
    controlled = !!container.controller;
  } catch {
    controlled = false;
  }
  let registrations: readonly MinimalRegistration[] = [];
  try {
    registrations = await withTimeout(Promise.resolve(container.getRegistrations()), GUARD_TIMEOUT_MS, []);
  } catch {
    registrations = [];
  }
  if (!controlled && registrations.length === 0) return 'clean';
  await withTimeout(
    Promise.all(
      registrations.map((r) => {
        try {
          return Promise.resolve(r.unregister()).catch(() => false);
        } catch {
          return Promise.resolve(false);
        }
      }),
    ),
    GUARD_TIMEOUT_MS,
    [],
  );
  return 'removed';
}
