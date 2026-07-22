export interface SnapshotBackendAcceptanceMetrics {
  readonly backendId: string;
  readonly bundleBytes: number;
  readonly cancellationCreatesNoRecords: boolean;
  readonly capturesWithoutGrowth: boolean;
  readonly desktopVerified: boolean;
  readonly exactFixtureLineBreaks: boolean;
  readonly feedbackMs: number;
  readonly localImagesComplete: boolean;
  readonly mainThreadTaskP95Ms: number;
  readonly physicalIpadVerified: boolean;
  readonly pngP95Ms: number;
  readonly rectangleErrorCssPx: number;
  readonly unsupportedContentHandled: boolean;
}

export interface SnapshotBackendAcceptanceResult {
  readonly backendId: string;
  readonly desktopAccepted: boolean;
  readonly failures: readonly string[];
  readonly metrics: SnapshotBackendAcceptanceMetrics;
  readonly mobileAccepted: boolean;
}

export function evaluateSnapshotBackendAcceptance(
  metrics: SnapshotBackendAcceptanceMetrics,
): SnapshotBackendAcceptanceResult {
  const failures: string[] = [];
  if (metrics.rectangleErrorCssPx > 1) failures.push('capture rectangle exceeds 1 CSS px');
  if (!metrics.exactFixtureLineBreaks) failures.push('fixture line breaks differ');
  if (!metrics.localImagesComplete) failures.push('required local images are missing');
  if (!metrics.unsupportedContentHandled)
    failures.push('unsupported content is silently omitted or aborts the whole capture');
  if (metrics.feedbackMs > 100) failures.push('capture feedback exceeds 100 ms');
  if (metrics.pngP95Ms > 1_000) failures.push('visible PNG P95 exceeds 1,000 ms');
  if (metrics.mainThreadTaskP95Ms > 50) failures.push('main-thread task P95 exceeds 50 ms');
  if (!metrics.cancellationCreatesNoRecords) failures.push('cancellation leaks records or Drafts');
  if (!metrics.capturesWithoutGrowth)
    failures.push('repeated capture retains decoded-image growth');
  const hardBudgetsPass = failures.length === 0;
  return Object.freeze({
    backendId: metrics.backendId,
    desktopAccepted: hardBudgetsPass && metrics.desktopVerified,
    failures: Object.freeze(failures),
    metrics: Object.freeze({ ...metrics }),
    mobileAccepted: hardBudgetsPass && metrics.desktopVerified && metrics.physicalIpadVerified,
  });
}

export function selectSnapshotBackendDefault(
  results: readonly SnapshotBackendAcceptanceResult[],
  platform: 'desktop' | 'mobile',
): string {
  const selected = results.find((result) =>
    platform === 'desktop' ? result.desktopAccepted : result.mobileAccepted,
  );
  if (selected === undefined) {
    throw new Error(`No Snapshot backend has passed ${platform} acceptance.`);
  }
  return selected.backendId;
}
