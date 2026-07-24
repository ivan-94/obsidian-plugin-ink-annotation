import { describe, expect, it } from 'vitest';

import { validateProductionBundle } from './check-production-bundle.mjs';

describe('production bundle validation', () => {
  it('accepts a compact production bundle without an embedded source map', () => {
    const bundle =
      '/* Inkstone Annotations */\n"use strict";var answer=42;module.exports={answer};\n';

    expect(validateProductionBundle(bundle)).toEqual({
      bytes: bundle.length,
      nonEmptyLines: 2,
    });
  });

  it('rejects a readable multi-line development bundle', () => {
    const bundle = Array.from(
      { length: 1_000 },
      (_, index) => `const developmentValue${index} = ${index};`,
    ).join('\n');

    expect(() => validateProductionBundle(bundle)).toThrow(/not minified/u);
  });

  it('rejects a production bundle that exceeds the explicit release budget', () => {
    expect(() => validateProductionBundle('x'.repeat(1_000_001))).toThrow(/release budget/u);
  });

  it('rejects an embedded source map', () => {
    expect(() =>
      validateProductionBundle(
        '/* Inkstone Annotations */\n"use strict";\n//# sourceMappingURL=data:application/json;base64,e30=\n',
      ),
    ).toThrow(/source map/u);
  });

  it('rejects acceptance-only commands from the public runtime', () => {
    expect(() =>
      validateProductionBundle(
        '/* Inkstone Annotations */\nconst commandName="Snapshot acceptance: use fixture backend";\n',
      ),
    ).toThrow(/acceptance-only/u);
  });

  it('allows the one unreachable html-to-image clone helper but rejects an added fetch path', () => {
    expect(() =>
      validateProductionBundle(
        '/* Inkstone Annotations */\n"use strict";const videoPoster=url=>fetch(url);\n',
      ),
    ).not.toThrow();
    expect(() =>
      validateProductionBundle(
        '/* Inkstone Annotations */\n"use strict";const videoPoster=url=>fetch(url),unexpected=url=>fetch(url);\n',
      ),
    ).toThrow(/unexpected network fetch/u);
  });
});
