declare const __INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT__: boolean;
declare const __INKSTONE_LOCAL_PERFORMANCE_GATE__: boolean;

/** Compile-time-only candidate boundary. Ordinary production and development builds are false. */
export const INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT =
  typeof __INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT__ !== 'undefined' &&
  __INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT__;

/** Compile-time-only automatic runner. It is absent from ordinary and physical-HAT builds. */
export const INKSTONE_LOCAL_PERFORMANCE_GATE =
  typeof __INKSTONE_LOCAL_PERFORMANCE_GATE__ !== 'undefined' && __INKSTONE_LOCAL_PERFORMANCE_GATE__;
