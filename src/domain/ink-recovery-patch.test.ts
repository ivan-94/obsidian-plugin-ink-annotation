import { describe, expect, it } from 'vitest';

import { digestInkBrushGolden } from './ink-brush-contract';
import { encodeInkSurfaceRecord, type InkStroke, type InkSurfaceRecord } from './ink-surface';
import {
  applyPreparedInkCommand,
  applyPreparedInkPhysicalSchemaActivation,
  hashRecoveryBytes,
  type InkPreparedCommandPatch,
  type InkPreparedPhysicalSchemaActivation,
  type InkPreparedPhysicalSchemaPlan,
  type InkPreparedPhysicalStroke,
} from './ink-recovery-patch';

describe('Ink Recovery v4 frozen patch', () => {
  it('stores and reapplies only exact add/replace/delete footprints', () => {
    const top = surface('top', [stroke('keep'), stroke('replace'), stroke('delete')]);
    const bottom = surface('bottom', [stroke('bottom-keep')]);
    const replacementDigest = strokeDigest(stroke('replace'));
    const command: InkPreparedCommandPatch = {
      commandId: 'command-1',
      commandKind: 'move',
      documentGeneration: 7,
      formatVersion: 1,
      surfacePatches: [
        {
          deleted: [{ digest: strokeDigest(stroke('delete')), id: 'delete' }],
          surfaceId: 'top',
          upserted: [
            {
              index: 1,
              previousDigest: replacementDigest,
              stroke: { ...stroke('replace'), color: '#ff0000' },
            },
            { index: 2, previousDigest: null, stroke: stroke('added') },
          ],
        },
        {
          deleted: [],
          surfaceId: 'bottom',
          upserted: [{ index: 1, previousDigest: null, stroke: stroke('bottom-added') }],
        },
      ],
    };
    expect(replacementDigest).toMatch(/^[0-9a-f]{8}$/u);

    expect(command.surfacePatches).toMatchObject([
      {
        deleted: [{ id: 'delete' }],
        surfaceId: 'top',
        upserted: [
          { index: 1, previousDigest: replacementDigest, stroke: { id: 'replace' } },
          { index: 2, previousDigest: null, stroke: { id: 'added' } },
        ],
      },
      {
        deleted: [],
        surfaceId: 'bottom',
        upserted: [{ index: 1, previousDigest: null, stroke: { id: 'bottom-added' } }],
      },
    ]);
    expect(applyPreparedInkCommand([top, bottom], command)).toEqual([
      {
        ...top,
        strokes: [stroke('keep'), { ...stroke('replace'), color: '#ff0000' }, stroke('added')],
      },
      { ...bottom, strokes: [stroke('bottom-keep'), stroke('bottom-added')] },
    ]);
  });

  it('fails the complete cross-surface command when one previous digest diverges', () => {
    const top = surface('top', [stroke('crossing-top')]);
    const bottom = surface('bottom', [stroke('crossing-bottom')]);
    const command: InkPreparedCommandPatch = {
      commandId: 'crossing-restyle',
      commandKind: 'restyle',
      documentGeneration: 1,
      formatVersion: 1,
      surfacePatches: [
        {
          deleted: [],
          surfaceId: 'top',
          upserted: [
            {
              index: 0,
              previousDigest: strokeDigest(stroke('crossing-top')),
              stroke: { ...stroke('crossing-top'), width: 8 },
            },
          ],
        },
        {
          deleted: [],
          surfaceId: 'bottom',
          upserted: [
            {
              index: 0,
              previousDigest: strokeDigest(stroke('crossing-bottom')),
              stroke: { ...stroke('crossing-bottom'), width: 8 },
            },
          ],
        },
      ],
    };
    const divergent = { ...bottom, strokes: [{ ...stroke('crossing-bottom'), color: '#abcdef' }] };

    expect(() => applyPreparedInkCommand([top, divergent], command)).toThrow(
      /previous stroke digest/u,
    );
    expect(top.strokes[0]?.width).toBe(4);
    expect(divergent.strokes[0]?.width).toBe(4);
  });

  it('atomically materializes one frozen all-v3 schema plan and its first physical fragments', () => {
    const top = surface('top', [stroke('legacy-top')]);
    const bottom = surface('bottom', [stroke('legacy-bottom')]);
    const candidates = [legacyV3(top), legacyV3(bottom)];
    const sourceCanonicalBytes = [top, bottom].map(encodeInkSurfaceRecord);
    const candidateCanonicalBytes = candidates.map(encodeInkSurfaceRecord);
    const sourceBaseDigest = digestInkBrushGolden({ sourceSurfaceBytes: sourceCanonicalBytes });
    const candidateDigest = digestInkBrushGolden({
      candidateSurfaceBytes: candidateCanonicalBytes,
    });
    const planCore = {
      candidateCanonicalBytes,
      candidateDigest,
      formatVersion: 1 as const,
      kind: 'ink-schema-v3-preparation' as const,
      readGeneration: 4,
      sourceBaseDigest,
      sourceCanonicalBytes,
    };
    const planDigest = digestInkBrushGolden({
      candidateSurfaceBytes: planCore.candidateCanonicalBytes,
      formatVersion: planCore.formatVersion,
      kind: planCore.kind,
      readGeneration: planCore.readGeneration,
      sourceBaseDigest: planCore.sourceBaseDigest,
      sourceSurfaceBytes: planCore.sourceCanonicalBytes,
    });
    const plan: InkPreparedPhysicalSchemaPlan = {
      ...planCore,
      planDigest,
      planReference: `ink-schema-v3-plan:${planDigest}`,
    };
    const command: InkPreparedPhysicalSchemaActivation = {
      commandId: 'physical-crossing',
      formatVersion: 1,
      fragments: [
        {
          stroke: physicalStroke('physical-top', 'physical-crossing', 590, 'top'),
          surfaceId: 'top',
        },
        {
          stroke: physicalStroke('physical-bottom', 'physical-crossing', 10, 'bottom'),
          surfaceId: 'bottom',
        },
      ],
      kind: 'activate-physical-schema-v3',
      planDigest,
      planReference: plan.planReference,
      readGeneration: 4,
      sourceBaseDigest,
    };

    const result = applyPreparedInkPhysicalSchemaActivation([top, bottom], plan, command);

    expect(result).toMatchObject([
      {
        id: 'top',
        schemaVersion: 3,
        strokes: [
          { brushRenderVersion: 'legacy-round-v1', id: 'legacy-top' },
          { brushRenderVersion: 'pen-physical-v1', id: 'physical-top' },
        ],
      },
      {
        id: 'bottom',
        schemaVersion: 3,
        strokes: [
          { brushRenderVersion: 'legacy-round-v1', id: 'legacy-bottom' },
          { brushRenderVersion: 'pen-physical-v1', id: 'physical-bottom' },
        ],
      },
    ]);
    expect([top, bottom].map(({ schemaVersion }) => schemaVersion)).toEqual([2, 2]);

    expect(() =>
      applyPreparedInkPhysicalSchemaActivation([top, bottom], plan, {
        ...command,
        fragments: command.fragments.slice(0, 1),
      }),
    ).toThrow(/incomplete physical fragment boundary/u);

    const divergentBottom = command.fragments[1];
    if (divergentBottom === undefined) throw new Error('Missing divergent Recovery fragment.');
    expect(() =>
      applyPreparedInkPhysicalSchemaActivation([top, bottom], plan, {
        ...command,
        fragments: [
          command.fragments[0] as (typeof command.fragments)[number],
          {
            ...divergentBottom,
            stroke: {
              ...divergentBottom.stroke,
              points: divergentBottom.stroke.points.map((point) =>
                point.fragmentBoundary === undefined ? point : { ...point, pressure: 0.7 },
              ),
            },
          },
        ],
      }),
    ).toThrow(/divergent physical fragment boundary/u);

    for (const forged of [
      {
        ...stroke('forged-legacy'),
        brushRenderVersion: 'legacy-round-v1' as const,
        inputProfile: {
          pressure: 'legacy-unknown' as const,
          tilt: 'legacy-unknown' as const,
        },
        linkedStrokeId: 'physical-crossing',
      },
      {
        ...stroke('forged-eraser'),
        linkedStrokeId: 'physical-crossing',
        tool: 'eraser' as const,
      },
    ]) {
      expect(() =>
        applyPreparedInkPhysicalSchemaActivation([top, bottom], plan, {
          ...command,
          fragments: [
            {
              stroke: forged as unknown as InkPreparedPhysicalStroke,
              surfaceId: 'top',
            },
            command.fragments[1] as (typeof command.fragments)[number],
          ],
        }),
      ).toThrow(/physical fragment|physical brush/u);
    }
    const topFragment = command.fragments[0];
    if (topFragment === undefined) throw new Error('Missing top Recovery fragment.');
    expect(() =>
      applyPreparedInkPhysicalSchemaActivation([top, bottom], plan, {
        ...command,
        fragments: [
          {
            ...topFragment,
            stroke: {
              ...topFragment.stroke,
              points: topFragment.stroke.points.map((point) => {
                const {
                  fragmentBoundary: _boundary,
                  fragmentBoundaryEdge: _edge,
                  fragmentBoundaryId: _boundaryId,
                  ...withoutBoundary
                } = point;
                void _boundary;
                void _edge;
                void _boundaryId;
                return withoutBoundary;
              }),
            },
          },
        ],
      }),
    ).toThrow(/omitted internal boundary provenance/u);
    expect(candidates.map(({ strokes }) => strokes.map(({ id }) => id))).toEqual([
      ['legacy-top'],
      ['legacy-bottom'],
    ]);
  });
});

function strokeDigest(value: InkStroke): string {
  return hashRecoveryBytes(JSON.stringify(value));
}

function surface(id: string, strokes: readonly InkStroke[]): InkSurfaceRecord {
  return {
    createdAt: '2026-07-17T00:00:00.000Z',
    filePath: 'Ink.md',
    id,
    layout: {
      blockFingerprints: [],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 600,
      logicalWidth: 704,
      originY: id === 'top' ? 0 : 600,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note',
    revision: 1,
    schemaVersion: 2,
    status: 'active',
    strokes,
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

function stroke(id: string): InkStroke {
  return {
    color: '#111111',
    id,
    points: [{ pressure: 0.5, time: 0, x: 10, y: 20 }],
    tool: 'pen',
    width: 4,
  };
}

function legacyV3(record: InkSurfaceRecord): InkSurfaceRecord {
  return {
    ...record,
    schemaVersion: 3,
    strokes: record.strokes.map((candidate) =>
      candidate.tool === 'eraser' ||
      candidate.brushRenderVersion === 'pen-physical-v1' ||
      candidate.brushRenderVersion === 'highlighter-chisel-v1'
        ? candidate
        : {
            ...candidate,
            brushRenderVersion: 'legacy-round-v1' as const,
            inputProfile: {
              pressure: 'legacy-unknown' as const,
              tilt: 'legacy-unknown' as const,
            },
          },
    ),
  };
}

function physicalStroke(
  id: string,
  linkedStrokeId: string,
  y: number,
  side: 'bottom' | 'top',
): InkPreparedPhysicalStroke {
  const authored = {
    fragmentGlobalY: side === 'top' ? y : 600 + y,
    fragmentTraceOrder: side === 'top' ? 0 : 1,
    orientation: { kind: 'unavailable' } as const,
    pressure: 0.6,
    pressureKind: 'measured' as const,
    time: side === 'top' ? 1 : 2,
    x: side === 'top' ? 10 : 20,
    y,
  };
  const boundary = {
    fragmentBoundary: 'synthetic-clip' as const,
    fragmentBoundaryEdge: side === 'top' ? ('end' as const) : ('start' as const),
    fragmentBoundaryId: `${linkedStrokeId}:boundary:0.5`,
    fragmentGlobalY: 600,
    fragmentTraceOrder: 0.5,
    orientation: { kind: 'unavailable' } as const,
    pressure: 0.6,
    pressureKind: 'measured' as const,
    time: 1.5,
    x: 15,
    y: side === 'top' ? 600 : 0,
  };
  return {
    brushRenderVersion: 'pen-physical-v1',
    color: '#112233',
    id,
    inputProfile: { pressure: 'measured', tilt: 'unavailable' },
    linkedStrokeId,
    points: side === 'top' ? [authored, boundary] : [boundary, authored],
    tool: 'pen',
    width: 4,
  };
}
