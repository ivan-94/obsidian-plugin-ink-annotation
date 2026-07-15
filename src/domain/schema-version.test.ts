import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, requireSupportedSchemaVersion } from './schema-version';

describe('requireSupportedSchemaVersion', () => {
  it('accepts the current version and fails closed for unknown versions', () => {
    expect(requireSupportedSchemaVersion(CURRENT_SCHEMA_VERSION)).toBe(1);
    expect(() => requireSupportedSchemaVersion(0)).toThrow('Unsupported schema version: 0');
    expect(() => requireSupportedSchemaVersion(2)).toThrow('Unsupported schema version: 2');
    expect(() => requireSupportedSchemaVersion('1')).toThrow('Unsupported schema version: 1');
  });
});
