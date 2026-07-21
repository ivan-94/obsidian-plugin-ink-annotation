declare const __INKSTONE_TILE_WORKER_SOURCE__: string;
declare const __INKSTONE_TILE_WORKER_DIGEST__: string;

export { INK_TILE_WORKER_PROTOCOL_VERSION } from './ink-tile-worker-protocol';

/** Build-generated classic Worker payload embedded in main.js; empty only in unbundled tests. */
export const INK_TILE_WORKER_SOURCE =
  typeof __INKSTONE_TILE_WORKER_SOURCE__ === 'string' ? __INKSTONE_TILE_WORKER_SOURCE__ : '';

/** SHA-256 of the exact embedded Worker payload. */
export const INK_TILE_WORKER_DIGEST =
  typeof __INKSTONE_TILE_WORKER_DIGEST__ === 'string' ? __INKSTONE_TILE_WORKER_DIGEST__ : '';
