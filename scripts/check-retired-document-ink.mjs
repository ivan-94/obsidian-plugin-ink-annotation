import { access, readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const RETIRED_DOCUMENT_INK_MARKERS = Object.freeze([
  'Toggle Ink Mode',
  'Exit Ink Mode',
  '开始涂鸦',
  'Show Ink preview by default',
  'Ink presentation renderer',
  'inkstone-ink-preview-projection',
  'Close the existing Ink preview',
]);

export const RETIRED_DOCUMENT_INK_SOURCE_PATHS = Object.freeze([
  'src/adapters/obsidian/ink-mode-manager.ts',
  'src/application/ink-document-session.ts',
  'src/runtime/ink-tile-worker-entry.ts',
  'src/ui/ink-canvas-controller.ts',
  'src/ui/ink-render-runtime.ts',
]);

export const RETIRED_DOCUMENT_INK_STYLE_MARKERS = Object.freeze([
  '.view-action[data-inkstone-ink-action',
  '.inkstone-ink-workspace',
  '.inkstone-ink-surface',
  '.inkstone-ink-rebase-dialog',
  '.is-ink-mode',
]);

/** @param {string} bundle */
export function findRetiredDocumentInkMarkers(bundle) {
  return RETIRED_DOCUMENT_INK_MARKERS.filter((marker) => bundle.includes(marker));
}

/** @param {string} stylesheet */
export function findRetiredDocumentInkStyleMarkers(stylesheet) {
  return RETIRED_DOCUMENT_INK_STYLE_MARKERS.filter((marker) => stylesheet.includes(marker));
}

async function main() {
  const bundlePath = process.env.INKSTONE_BUNDLE ?? new URL('../main.js', import.meta.url);
  const bundle = await readFile(bundlePath, 'utf8');
  const matches = findRetiredDocumentInkMarkers(bundle);
  if (matches.length > 0) {
    throw new Error(`Production bundle still contains retired document Ink: ${matches.join(', ')}`);
  }
  const projectRoot = new URL('../', import.meta.url);
  const stylesheet = await readFile(new URL('styles.css', projectRoot), 'utf8');
  const styleMatches = findRetiredDocumentInkStyleMarkers(stylesheet);
  if (styleMatches.length > 0) {
    throw new Error(
      `Production stylesheet still contains retired document Ink: ${styleMatches.join(', ')}`,
    );
  }
  const retainedSources = [];
  for (const path of RETIRED_DOCUMENT_INK_SOURCE_PATHS) {
    try {
      await access(new URL(path, projectRoot));
      retainedSources.push(path);
    } catch {
      // Missing is the required retirement state.
    }
  }
  if (retainedSources.length > 0) {
    throw new Error(`Retired document Ink source still exists: ${retainedSources.join(', ')}`);
  }
  console.log('Retired document Ink bundle check passed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
