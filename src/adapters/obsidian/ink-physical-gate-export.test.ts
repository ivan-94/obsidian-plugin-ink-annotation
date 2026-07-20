import { describe, expect, it } from 'vitest';

import { InkPhysicalGateExport } from './ink-physical-gate-export';

describe('InkPhysicalGateExport', () => {
  it('reads a condition and writes privacy-safe diagnostics only in an owned synthetic Vault', async () => {
    const files = new Map<string, string>([
      ['.inkstone-hat-owned', 'Inkstone S00 device HAT Vault\n'],
      ['.inkstone-s22-performance-hat.json', '{"schemaVersion":1}\n'],
      [
        'S27 Condition.json',
        JSON.stringify({
          adapter: 'pointer',
          buildDigest: 'a'.repeat(64),
          conditionId: 'empty-writing',
          deviceDigest: 'd'.repeat(64),
          fixtureDigest: 'b'.repeat(64),
          presentationAdapter: 'main-canvas-2d',
          protocolDigest: 'c'.repeat(64),
          runIndex: 1,
          schemaVersion: 2,
          tester: 'Ivan',
        }),
      ],
    ]);
    const adapter = adapterFixture(files);
    const exporter = new InkPhysicalGateExport(adapter);

    await expect(exporter.readCondition()).resolves.toMatchObject({
      conditionId: 'empty-writing',
      presentationAdapter: 'main-canvas-2d',
      runIndex: 1,
    });
    await exporter.writeCapture({
      capturedAt: '2026-07-17T12:00:00.000Z',
      condition: await exporter.readCondition(),
      diagnostics: { distributions: [], recentSpans: [] },
      longTasks: { available: false, durationsMs: [] },
      schemaVersion: 2,
    });

    expect(files.get('S27 Diagnostics.json')).toContain('empty-writing');
    expect(files.get('S27 Diagnostics.json')).not.toMatch(/path|coordinate|pressure|tilt|color/iu);

    files.delete('.inkstone-hat-owned');
    await expect(exporter.readCondition()).rejects.toThrow(
      'S27 capture is allowed only in the owned synthetic Vault.',
    );
  });
});

function adapterFixture(files: Map<string, string>) {
  return {
    exists: (path: string) => Promise.resolve(files.has(path)),
    read: (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return Promise.resolve(value);
    },
    write: (path: string, contents: string) => {
      files.set(path, contents);
      return Promise.resolve();
    },
  };
}
