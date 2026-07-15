import { describe, expect, it, vi } from 'vitest';

import { waitForInkLayoutReadiness } from './ink-layout-readiness';

describe('Ink layout readiness', () => {
  it('waits for document fonts before layout reconciliation', async () => {
    let releaseFonts: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      releaseFonts = resolve;
    });
    const onReady = vi.fn();
    const waiting = waitForInkLayoutReadiness({ fonts: { ready } } as unknown as Document).then(
      onReady,
    );

    await Promise.resolve();
    expect(onReady).not.toHaveBeenCalled();

    releaseFonts?.();
    await waiting;

    expect(onReady).toHaveBeenCalledOnce();
  });

  it('continues immediately when the host does not expose the FontFaceSet API', async () => {
    await expect(waitForInkLayoutReadiness({} as unknown as Document)).resolves.toBeUndefined();
  });
});
