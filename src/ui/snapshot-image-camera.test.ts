import { describe, expect, it } from 'vitest';

import { SnapshotImageCamera } from './snapshot-image-camera';

describe('Snapshot image camera', () => {
  it('caps Fit at 100% and centers a smaller image in the viewport', () => {
    const camera = new SnapshotImageCamera({ imageHeight: 400, imageWidth: 600 });

    expect(camera.fit({ height: 800, width: 1_000 })).toMatchObject({
      epoch: 1,
      scale: 1,
      translateX: 200,
      translateY: 200,
    });
  });

  it('keeps one atomic inverse transform across Fit, anchored zoom, and pan', () => {
    const camera = new SnapshotImageCamera({ imageHeight: 400, imageWidth: 600 });

    const fit = camera.fit({ height: 200, width: 300 });
    expect(fit).toMatchObject({ epoch: 1, scale: 0.5, translateX: 0, translateY: 0 });
    expect(camera.toImagePoint({ x: 150, y: 100 }, fit)).toEqual({ x: 300, y: 200 });

    const zoomed = camera.zoomAt({ factor: 2, screenX: 150, screenY: 100 });
    expect(zoomed).toMatchObject({ epoch: 2, scale: 1, translateX: -150, translateY: -100 });
    expect(camera.toImagePoint({ x: 150, y: 100 }, zoomed)).toEqual({ x: 300, y: 200 });

    const panned = camera.panBy({ x: 20, y: -10 });
    expect(panned).toMatchObject({ epoch: 3, translateX: -130, translateY: -110 });
    expect(camera.toImagePoint({ x: 170, y: 90 }, panned)).toEqual({ x: 300, y: 200 });
  });
});
