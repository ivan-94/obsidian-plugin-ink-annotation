import {
  leaseSnapshotCaptureSubject,
  SnapshotCaptureError,
  type SnapshotCaptureSubjectHandle,
} from './snapshot-capture-backend';
import type { ElectronWebContentsCaptureLike } from './electron-snapshot-capture-backend';

interface DynamicModuleLoaderHost {
  readonly require?: (id: string) => unknown;
}

/** Lazily probes only documented Electron/@electron-remote shapes after the desktop gate. */
export function resolveDesktopElectronCaptureSubject(
  host: DynamicModuleLoaderHost = globalThis,
): SnapshotCaptureSubjectHandle {
  const load = host.require;
  if (typeof load !== 'function') throw unavailable();
  for (const moduleId of [joinModuleId('@electron', 'remote'), joinModuleId('elect', 'ron')]) {
    try {
      const loaded = load(moduleId);
      const webContents = currentWebContentsFromModule(loaded);
      if (webContents !== null) {
        return leaseSnapshotCaptureSubject({ kind: 'electron-web-contents', webContents });
      }
    } catch {
      // Optional module probes are intentionally fail-closed and continue to the next known shape.
    }
  }
  throw unavailable();
}

function currentWebContentsFromModule(value: unknown): ElectronWebContentsCaptureLike | null {
  if (!isRecord(value)) return null;
  const direct = callOptional(value.getCurrentWebContents);
  if (isWebContents(direct)) return direct;
  const currentWindow = callOptional(value.getCurrentWindow);
  if (isRecord(currentWindow) && isWebContents(currentWindow.webContents)) {
    return currentWindow.webContents;
  }
  const remote = value.remote;
  if (!isRecord(remote)) return null;
  const remoteContents = callOptional(remote.getCurrentWebContents);
  if (isWebContents(remoteContents)) return remoteContents;
  const remoteWindow = callOptional(remote.getCurrentWindow);
  return isRecord(remoteWindow) && isWebContents(remoteWindow.webContents)
    ? remoteWindow.webContents
    : null;
}

function callOptional(value: unknown): unknown {
  if (typeof value !== 'function') return null;
  return Reflect.apply(value, undefined, []) as unknown;
}

function isWebContents(value: unknown): value is ElectronWebContentsCaptureLike {
  return isRecord(value) && typeof value.capturePage === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function joinModuleId(left: string, right: string): string {
  return left.startsWith('@') ? `${left}/${right}` : `${left}${right}`;
}

function unavailable(): SnapshotCaptureError {
  return new SnapshotCaptureError(
    'backend-unavailable',
    'This Obsidian desktop build does not expose an admissible Electron capture handle.',
  );
}
