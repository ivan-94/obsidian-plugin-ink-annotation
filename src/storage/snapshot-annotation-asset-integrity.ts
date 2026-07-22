import { sha256Bytes } from '../domain/content-digest';
import { readPngImageDimensions } from '../domain/png-image';
import type { SnapshotAnnotationRecord } from '../domain/snapshot-annotation';

export async function assertSnapshotAssetBytes(
  record: SnapshotAnnotationRecord,
  pngBytes: Uint8Array,
): Promise<void> {
  try {
    const dimensions = readPngImageDimensions(pngBytes);
    if (
      dimensions.width !== record.asset.pixelWidth ||
      dimensions.height !== record.asset.pixelHeight ||
      pngBytes.byteLength !== record.asset.byteLength ||
      (await sha256Bytes(pngBytes)) !== record.asset.sha256
    ) {
      throw new Error('integrity mismatch');
    }
  } catch (cause) {
    throw new Error('Snapshot Annotation capture asset failed local integrity verification.', {
      cause,
    });
  }
}
