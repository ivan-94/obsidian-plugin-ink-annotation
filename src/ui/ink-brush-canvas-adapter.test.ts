import { describe, expect, it } from 'vitest';

import { createInkBrushCompiledGeometry } from '../domain/ink-brush-geometry-contract';
import {
  drawInkBrushGeometryToCanvas,
  drawInkBrushSelectionChromeToCanvas,
} from './ink-brush-canvas-adapter';

describe('shared Ink Brush Canvas adapter', () => {
  it('fills every Pen contour in one renderer-neutral path without using lineWidth stroke', () => {
    const context = new RecordingContext();

    drawInkBrushGeometryToCanvas(context.asCanvas(), physicalGeometry('pen'));

    expect(context.operations).toEqual([
      'save',
      'beginPath',
      'moveTo:0,0',
      'lineTo:5,0',
      'lineTo:5,5',
      'lineTo:0,5',
      'lineTo:0,0',
      'closePath',
      'moveTo:2,2',
      'lineTo:3,2',
      'lineTo:3,3',
      'lineTo:2,3',
      'lineTo:2,2',
      'closePath',
      'fill:nonzero',
      'restore',
    ]);
    expect(context.fillStyle).toBe('#112233');
    expect(context.globalAlpha).toBe(1);
    expect(context.globalCompositeOperation).toBe('source-over');
    expect(context.operations).not.toContain('stroke');
  });

  it('applies Highlighter optical density once even when its coverage contours overlap', () => {
    const context = new RecordingContext();

    drawInkBrushGeometryToCanvas(context.asCanvas(), physicalGeometry('highlighter'));

    expect(context.operations.filter((operation) => operation === 'fill:nonzero')).toHaveLength(1);
    expect(context.globalAlpha).toBe(0.35);
    expect(context.fillStyle).toBe('#ffcc00');
  });

  it('preserves historical round centerline color alpha and logical-grid projection', () => {
    const context = new RecordingContext();

    drawInkBrushGeometryToCanvas(context.asCanvas(), legacyGeometry());

    expect(context.operations).toEqual([
      'save',
      'beginPath',
      'moveTo:1,2',
      'lineTo:4,5',
      'stroke',
      'restore',
    ]);
    expect(context.strokeStyle).toBe('#abcdef');
    expect(context.globalAlpha).toBeCloseTo(0x80 / 255);
    expect(context.lineWidth).toBe(2);
    expect(context.lineCap).toBe('round');
    expect(context.lineJoin).toBe('round');
  });

  it('renders a one-point legacy tap as its exact bounded round footprint', () => {
    const context = new RecordingContext();

    drawInkBrushGeometryToCanvas(context.asCanvas(), legacyTapGeometry());

    expect(context.operations).toEqual([
      'save',
      'beginPath',
      `arc:2,3,1,0,${Math.PI * 2}`,
      'fill:nonzero',
      'restore',
    ]);
    expect(context.fillStyle).toBe('#112233');
  });

  it('projects physical selection chrome from the same contours instead of its centerline', () => {
    const context = new RecordingContext();

    drawInkBrushSelectionChromeToCanvas(
      context.asCanvas(),
      physicalGeometry('highlighter'),
      'rgba(79, 70, 229, 0.45)',
      4,
    );

    expect(context.operations.at(1)).toBe('beginPath');
    expect(context.operations.filter((operation) => operation === 'closePath')).toHaveLength(2);
    expect(context.operations).toContain('stroke');
    expect(context.lineWidth).toBe(8);
    expect(context.strokeStyle).toBe('rgba(79, 70, 229, 0.45)');
  });
});

function physicalGeometry(tool: 'highlighter' | 'pen') {
  return createInkBrushCompiledGeometry({
    blend: {
      alpha: { kind: 'fixed', value: tool === 'pen' ? 1 : 0.35 },
      application: 'once-per-logical-stroke',
      colorSpace: 'srgb',
      composite: 'source-over',
    },
    bounds: { height: 5, width: 5, x: 0, y: 0 },
    color: tool === 'pen' ? '#112233' : '#ffcc00',
    coverage: {
      contours: [
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
          { x: 0, y: 0 },
        ],
        [
          { x: 4, y: 4 },
          { x: 6, y: 4 },
          { x: 6, y: 6 },
          { x: 4, y: 6 },
          { x: 4, y: 4 },
        ],
      ],
      kind: 'quantized-filled-contours',
    },
    hitShape: { fillRule: 'nonzero', kind: 'filled-contour-distance' },
    logicalStrokeId: `${tool}-physical`,
    quantization: { logicalGrid: 0.5 },
    tool,
    traceDigest: '1234abcd',
    version: tool === 'pen' ? 'pen-physical-v1' : 'highlighter-chisel-v1',
  });
}

function legacyGeometry() {
  return createInkBrushCompiledGeometry({
    blend: {
      alpha: { kind: 'from-canonical-color' },
      application: 'once-per-logical-stroke',
      colorSpace: 'srgb',
      composite: 'source-over',
    },
    bounds: { height: 5, width: 5, x: 0, y: 1 },
    color: '#abcdef80',
    coverage: {
      centerline: [
        { x: 2, y: 4 },
        { x: 8, y: 10 },
      ],
      diameterUnits: 4,
      kind: 'legacy-round-centerline',
    },
    hitShape: { kind: 'round-centerline-distance', radius: 1 },
    logicalStrokeId: 'legacy',
    quantization: { logicalGrid: 0.5 },
    tool: 'highlighter',
    traceDigest: '1234abcd',
    version: 'legacy-round-v1',
  });
}

function legacyTapGeometry() {
  return createInkBrushCompiledGeometry({
    blend: {
      alpha: { kind: 'from-canonical-color' },
      application: 'once-per-logical-stroke',
      colorSpace: 'srgb',
      composite: 'source-over',
    },
    bounds: { height: 2, width: 2, x: 1, y: 2 },
    color: '#112233',
    coverage: {
      centerline: [{ x: 4, y: 6 }],
      diameterUnits: 4,
      kind: 'legacy-round-centerline',
    },
    hitShape: { kind: 'round-centerline-distance', radius: 1 },
    logicalStrokeId: 'legacy-tap',
    quantization: { logicalGrid: 0.5 },
    tool: 'pen',
    traceDigest: '1234abcd',
    version: 'legacy-round-v1',
  });
}

class RecordingContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  lineWidth = 1;
  readonly operations: string[] = [];
  strokeStyle: string | CanvasGradient | CanvasPattern = '';

  asCanvas(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }

  beginPath(): void {
    this.operations.push('beginPath');
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.operations.push(`arc:${x},${y},${radius},${startAngle},${endAngle}`);
  }

  closePath(): void {
    this.operations.push('closePath');
  }

  fill(rule?: CanvasFillRule): void {
    this.operations.push(`fill:${rule ?? 'nonzero'}`);
  }

  lineTo(x: number, y: number): void {
    this.operations.push(`lineTo:${x},${y}`);
  }

  moveTo(x: number, y: number): void {
    this.operations.push(`moveTo:${x},${y}`);
  }

  restore(): void {
    this.operations.push('restore');
  }

  save(): void {
    this.operations.push('save');
  }

  stroke(): void {
    this.operations.push('stroke');
  }
}
