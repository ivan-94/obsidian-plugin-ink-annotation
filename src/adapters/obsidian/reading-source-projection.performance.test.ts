// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  buildSourceProjection,
  OBSIDIAN_SOURCE_DIALECT_VERSION,
} from '../../domain/source-projection';
import { bindReadingBlocks } from './reading-source-projection';

describe('Reading View Source Projection binding performance', () => {
  it('binds one 100-block visible section without a 50 ms long task', () => {
    const paragraphs = Array.from({ length: 100 }, (_, index) => `Visible paragraph ${index}.`);
    const source = paragraphs.join('\n\n');
    const projection = buildSourceProjection({
      dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
      filePath: 'Visible section.md',
      source,
      sourceRevision: 'revision-1',
    });
    const root = document.createElement('section');
    for (const text of paragraphs) {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      root.append(paragraph);
    }
    const startedAt = performance.now();

    const result = bindReadingBlocks({
      projection,
      root,
      sectionRange: () => ({ end: source.length, start: 0 }),
    });
    const durationMs = performance.now() - startedAt;

    expect(result.failures).toEqual([]);
    expect(result.bindings.size).toBe(100);
    expect(durationMs).toBeLessThan(50);
  });
});
