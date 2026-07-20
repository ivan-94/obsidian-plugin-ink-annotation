import { describe, expect, it } from 'vitest';

import * as legacyRecoveryPatch from './ink-recovery-patch';

describe('Legacy Recovery read-only public contract', () => {
  it('does not export writer-era command producers', () => {
    expect(legacyRecoveryPatch).not.toHaveProperty('prepareInkAddCommandPatch');
    expect(legacyRecoveryPatch).not.toHaveProperty('prepareInkCommandPatch');
  });
});
