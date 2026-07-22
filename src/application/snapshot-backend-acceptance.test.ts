import { describe, expect, it } from 'vitest';

import {
  evaluateSnapshotBackendAcceptance,
  selectSnapshotBackendDefault,
} from './snapshot-backend-acceptance';

describe('Snapshot backend acceptance decision', () => {
  it('selects only a backend with retained platform evidence and every hard budget', () => {
    const electron = evaluateSnapshotBackendAcceptance({
      backendId: 'electron-capture-page',
      bundleBytes: 0,
      cancellationCreatesNoRecords: true,
      capturesWithoutGrowth: true,
      desktopVerified: true,
      exactFixtureLineBreaks: true,
      feedbackMs: 20,
      localImagesComplete: true,
      mainThreadTaskP95Ms: 10,
      physicalIpadVerified: false,
      pngP95Ms: 180,
      rectangleErrorCssPx: 0,
      unsupportedContentHandled: true,
    });
    const web = evaluateSnapshotBackendAcceptance({
      backendId: 'html-to-image',
      bundleBytes: 498_000,
      cancellationCreatesNoRecords: true,
      capturesWithoutGrowth: true,
      desktopVerified: true,
      exactFixtureLineBreaks: true,
      feedbackMs: 25,
      localImagesComplete: true,
      mainThreadTaskP95Ms: 42,
      physicalIpadVerified: true,
      pngP95Ms: 760,
      rectangleErrorCssPx: 1,
      unsupportedContentHandled: true,
    });

    expect(electron).toMatchObject({ desktopAccepted: true, mobileAccepted: false });
    expect(web).toMatchObject({ desktopAccepted: true, mobileAccepted: true });
    expect(selectSnapshotBackendDefault([electron, web], 'desktop')).toBe('electron-capture-page');
    expect(selectSnapshotBackendDefault([electron, web], 'mobile')).toBe('html-to-image');
  });

  it('keeps mobile blocked until physical iPad evidence exists', () => {
    const pending = evaluateSnapshotBackendAcceptance({
      backendId: 'inkstone-foreign-object',
      bundleBytes: 0,
      cancellationCreatesNoRecords: true,
      capturesWithoutGrowth: true,
      desktopVerified: true,
      exactFixtureLineBreaks: true,
      feedbackMs: 10,
      localImagesComplete: true,
      mainThreadTaskP95Ms: 20,
      physicalIpadVerified: false,
      pngP95Ms: 500,
      rectangleErrorCssPx: 0,
      unsupportedContentHandled: true,
    });

    expect(() => selectSnapshotBackendDefault([pending], 'mobile')).toThrow(
      'No Snapshot backend has passed mobile acceptance',
    );
  });
});
