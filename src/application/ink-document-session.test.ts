import { describe, expect, it } from 'vitest';

import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { InkDocumentSession } from './ink-document-session';

describe('continuous Ink document session', () => {
  it('presents multiple bounded records as one continuous invisible-boundary surface', () => {
    const session = createSession([surface('a', 600), surface('b', 400)]).session;

    expect(session.snapshot().surface.layout).toMatchObject({
      logicalHeight: 1000,
      logicalWidth: 960,
    });
    expect(session.snapshot().surface.id).toBe('document:a:b');
  });

  it('splits one crossing user stroke into linked local fragments and persists both', async () => {
    const { session, writer } = createSession([surface('a', 600), surface('b', 400)]);

    session.addStroke(stroke('user-stroke', 550, 650));
    await session.background();

    expect(writer.records).toHaveLength(2);
    expect(writer.records.map((record) => record.id)).toEqual(['a', 'b']);
    expect(writer.records.map((record) => record.strokes[0]?.linkedStrokeId)).toEqual([
      'user-stroke',
      'user-stroke',
    ]);
    expect(writer.records[0]?.strokes[0]?.points.at(-1)).toMatchObject({ y: 600 });
    expect(writer.records[1]?.strokes[0]?.points[0]).toMatchObject({ y: 0 });
  });

  it('joins stored local fragments for rendering without a visible boundary seam', () => {
    const linkedA: InkStroke = {
      ...fragment('fragment-a', 'user-stroke', 550, 600),
      points: [point(100, 550), point(150, 600)],
    };
    const linkedB: InkStroke = {
      ...fragment('fragment-b', 'user-stroke', 0, 50),
      points: [point(150, 0), point(200, 50)],
    };
    const session = createSession([
      { ...surface('a', 600), strokes: [linkedA] },
      { ...surface('b', 400), strokes: [linkedB] },
    ]).session;

    const rendered = session.snapshot().surface.strokes;
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({
      id: 'user-stroke',
      points: [{ y: 550 }, { y: 600 }, { y: 650 }],
    });
  });

  it('does not include needs-rebase or unanchored geometry in the composite render', () => {
    const session = createSession([
      { ...surface('a', 600), status: 'needs-rebase', strokes: [fragment('a-1', 'lost', 1, 2)] },
      { ...surface('b', 400), status: 'unanchored', strokes: [fragment('b-1', 'lost-2', 1, 2)] },
    ]).session;

    expect(session.snapshot().surface.strokes).toEqual([]);
  });

  it('keeps drawing intent and reports the failing bounded write on exit', async () => {
    const writer = new RecordingWriter('b');
    const session = new InkDocumentSession({
      onChange: () => undefined,
      surfaces: [surface('a', 600), surface('b', 400)],
      writer,
    });
    session.addStroke(stroke('user-stroke', 550, 650));

    await expect(session.exit()).rejects.toThrow('b unavailable');

    expect(session.snapshot().surface.strokes).toHaveLength(1);
    expect(session.snapshot().persistence).toMatchObject({ kind: 'error' });
  });

  it('undoes and redoes a crossing user stroke as one command across all fragments', async () => {
    const { session, writer } = createSession([surface('a', 600), surface('b', 400)]);
    session.addStroke(stroke('user-stroke', 550, 650));

    expect(session.canUndo()).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.snapshot().surface.strokes).toEqual([]);
    expect(session.canRedo()).toBe(true);
    expect(session.redo()).toBe(true);
    expect(session.snapshot().surface.strokes).toHaveLength(1);
    await session.background();

    expect(writer.records.slice(-2).map((record) => record.strokes)).toMatchObject([
      [{ linkedStrokeId: 'user-stroke' }],
      [{ linkedStrokeId: 'user-stroke' }],
    ]);
  });

  it('hit-erases linked fragments as one command and undo restores them', () => {
    const linkedA: InkStroke = {
      ...fragment('fragment-a', 'user-stroke', 550, 600),
      points: [point(100, 550), point(150, 600)],
    };
    const linkedB: InkStroke = {
      ...fragment('fragment-b', 'user-stroke', 0, 50),
      points: [point(150, 0), point(200, 50)],
    };
    const session = createSession([
      { ...surface('a', 600), strokes: [linkedA] },
      { ...surface('b', 400), strokes: [linkedB] },
    ]).session;

    expect(session.eraseStrokeAt(point(151, 601), 8)).toBe('user-stroke');
    expect(session.snapshot().surface.strokes).toEqual([]);
    expect(session.undo()).toBe(true);
    expect(session.snapshot().surface.strokes).toHaveLength(1);
  });

  it('reloads to the same composite after persisted undo and redo boundaries', async () => {
    const { session, writer } = createSession([surface('a', 600), surface('b', 400)]);
    session.addStroke(stroke('user-stroke', 550, 650));
    await session.background();
    session.undo();
    await session.background();
    session.redo();
    await session.background();
    const latest = ['a', 'b'].map((id) =>
      [...writer.records].reverse().find((record) => record.id === id),
    );
    if (latest.some((record) => record === undefined))
      throw new Error('Missing persisted surface.');

    const reloaded = createSession(latest as InkSurfaceRecord[]).session;

    expect(reloaded.snapshot().surface.strokes).toEqual(session.snapshot().surface.strokes);
  });
});

function createSession(surfaces: readonly InkSurfaceRecord[]) {
  const writer = new RecordingWriter();
  return {
    session: new InkDocumentSession({ onChange: () => undefined, surfaces, writer }),
    writer,
  };
}

class RecordingWriter {
  readonly records: InkSurfaceRecord[] = [];

  constructor(private readonly failSurfaceId?: string) {}

  updateSurface(record: InkSurfaceRecord): Promise<void> {
    if (record.id === this.failSurfaceId) {
      return Promise.reject(new Error(`${record.id} unavailable`));
    }
    this.records.push(record);
    return Promise.resolve();
  }
}

function surface(id: string, height: number): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: [`block-${id}`],
      headingPath: [id],
      sectionFingerprint: `section-${id}`,
      sourceEnd: 100,
      sourceStart: 0,
    },
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id,
    layout: {
      blockFingerprints: [`block-${id}`],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: height,
      logicalWidth: 960,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [],
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function stroke(id: string, startY: number, endY: number): InkStroke {
  return {
    color: '#4f46d8',
    id,
    points: [point(100, startY), point(200, endY)],
    tool: 'pen',
    width: 4,
  };
}

function fragment(id: string, linkedStrokeId: string, startY: number, endY: number): InkStroke {
  return { ...stroke(id, startY, endY), linkedStrokeId };
}

function point(x: number, y: number) {
  return { pressure: 0.5, time: x + y, x, y };
}
