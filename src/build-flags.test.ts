import { expect, it } from 'vitest';

import {
  INKSTONE_LOCAL_PERFORMANCE_GATE,
  INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT,
} from './build-flags';

it('keeps the unpublished physical Ink candidate off when no build define is injected', () => {
  expect(INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT).toBe(false);
  expect(INKSTONE_LOCAL_PERFORMANCE_GATE).toBe(false);
});
