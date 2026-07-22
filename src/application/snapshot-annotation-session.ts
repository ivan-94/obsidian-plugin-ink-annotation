import { sha256Bytes } from '../domain/content-digest';
import {
  assertSnapshotAnnotationRecord,
  type SnapshotAnnotationRecord,
  type SnapshotCaptureProvenance,
  type SnapshotSourceBinding,
} from '../domain/snapshot-annotation';
import type { InkPoint, InkStroke } from '../domain/ink-surface';
import type {
  SnapshotAnnotationDraft,
  SnapshotAnnotationDraftStore,
} from './snapshot-annotation-draft-store';

export interface SnapshotAnnotationWriter {
  create(record: SnapshotAnnotationRecord, pngBytes: Uint8Array): Promise<void>;
}

export type SnapshotAnnotationSessionPersistence =
  | { readonly kind: 'editing' }
  | { readonly kind: 'saving-draft' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'draft-saved' }
  | { readonly kind: 'saved-locally' }
  | { readonly error: unknown; readonly kind: 'error' };

export class SnapshotAnnotationSession {
  private dirty: boolean;
  private isNew: boolean;
  private readonly now: () => string;
  private pendingRecord: SnapshotAnnotationRecord | null = null;
  private persistence: SnapshotAnnotationSessionPersistence = { kind: 'editing' };
  private pngBytes: Uint8Array;
  private record: SnapshotAnnotationRecord;

  private constructor(
    record: SnapshotAnnotationRecord,
    pngBytes: Uint8Array,
    input: {
      readonly dirty: boolean;
      readonly isNew: boolean;
      readonly now: () => string;
    },
  ) {
    this.dirty = input.dirty;
    this.isNew = input.isNew;
    this.now = input.now;
    this.record = record;
    this.pngBytes = Uint8Array.from(pngBytes);
  }

  static async create(input: {
    readonly backend: SnapshotCaptureProvenance;
    readonly capturedAt: string;
    readonly deviceId?: string;
    readonly filePath: string;
    readonly id: string;
    readonly logicalHeight: number;
    readonly logicalWidth: number;
    readonly noteId: string;
    readonly pixelHeight: number;
    readonly pixelRatio: number;
    readonly pixelWidth: number;
    readonly pngBytes: Uint8Array;
    readonly source: SnapshotSourceBinding;
    readonly now?: () => string;
  }): Promise<SnapshotAnnotationSession> {
    const digest = await sha256Bytes(input.pngBytes);
    const record: SnapshotAnnotationRecord = {
      asset: {
        backend: { ...input.backend },
        byteLength: input.pngBytes.byteLength,
        fileName: `capture-${digest}.png`,
        logicalHeight: input.logicalHeight,
        logicalWidth: input.logicalWidth,
        mimeType: 'image/png',
        pixelHeight: input.pixelHeight,
        pixelRatio: input.pixelRatio,
        pixelWidth: input.pixelWidth,
        sha256: digest,
      },
      capturedAt: input.capturedAt,
      createdAt: input.capturedAt,
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
      filePath: input.filePath,
      id: input.id,
      ink: {
        logicalHeight: input.logicalHeight,
        logicalWidth: input.logicalWidth,
        strokes: [],
      },
      noteId: input.noteId,
      revision: 1,
      schemaVersion: 1,
      source: structuredClone(input.source),
      status: 'active',
      updatedAt: input.capturedAt,
    };
    assertSnapshotAnnotationRecord(record);
    return new SnapshotAnnotationSession(record, input.pngBytes, {
      dirty: false,
      isNew: true,
      now: input.now ?? (() => new Date().toISOString()),
    });
  }

  static reopen(
    record: SnapshotAnnotationRecord,
    pngBytes: Uint8Array,
    input: { readonly now?: () => string } = {},
  ): SnapshotAnnotationSession {
    assertSnapshotAnnotationRecord(record);
    return new SnapshotAnnotationSession(structuredClone(record), pngBytes, {
      dirty: false,
      isNew: false,
      now: input.now ?? (() => new Date().toISOString()),
    });
  }

  static resumeDraft(
    draft: SnapshotAnnotationDraft,
    input: { readonly now?: () => string } = {},
  ): SnapshotAnnotationSession {
    assertSnapshotAnnotationRecord(draft.record);
    return new SnapshotAnnotationSession(structuredClone(draft.record), draft.pngBytes, {
      dirty: true,
      isNew: draft.isNew,
      now: input.now ?? (() => new Date().toISOString()),
    });
  }

  addStroke(stroke: InkStroke): void {
    if (isPersistenceLocked(this.persistence)) {
      throw new Error('Cannot change a Snapshot Annotation while or after it is committed.');
    }
    if (this.record.ink.strokes.some(({ id }) => id === stroke.id)) {
      throw new Error(`Snapshot Annotation stroke ID already exists: ${stroke.id}`);
    }
    const clipped = cloneAndClipStroke(
      stroke,
      this.record.ink.logicalWidth,
      this.record.ink.logicalHeight,
    );
    const record = {
      ...this.record,
      ink: { ...this.record.ink, strokes: [...this.record.ink.strokes, clipped] },
    };
    assertSnapshotAnnotationRecord(record);
    this.record = record;
    this.dirty = true;
    this.pendingRecord = null;
    this.persistence = { kind: 'editing' };
  }

  replaceStrokes(strokes: readonly InkStroke[]): void {
    if (isPersistenceLocked(this.persistence)) {
      throw new Error('Cannot change a Snapshot Annotation while or after it is committed.');
    }
    const ids = new Set<string>();
    const replacement = strokes.map((stroke) => {
      if (ids.has(stroke.id)) throw new Error('Snapshot Annotation stroke IDs must be unique.');
      ids.add(stroke.id);
      return cloneAndClipStroke(
        stroke,
        this.record.ink.logicalWidth,
        this.record.ink.logicalHeight,
      );
    });
    const record = { ...this.record, ink: { ...this.record.ink, strokes: replacement } };
    assertSnapshotAnnotationRecord(record);
    this.record = record;
    this.dirty = true;
    this.pendingRecord = null;
    this.persistence = { kind: 'editing' };
  }

  snapshot(): {
    readonly persistence: SnapshotAnnotationSessionPersistence;
    readonly record: SnapshotAnnotationRecord;
  } {
    return { persistence: this.persistence, record: this.record };
  }

  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  captureBytes(): Uint8Array {
    return Uint8Array.from(this.pngBytes);
  }

  async saveDraft(store: SnapshotAnnotationDraftStore): Promise<void> {
    if (this.persistence.kind === 'saving' || this.persistence.kind === 'saving-draft') {
      throw new Error('Snapshot Annotation persistence is already running.');
    }
    if (this.persistence.kind === 'saved-locally' || this.persistence.kind === 'draft-saved') {
      return;
    }
    this.persistence = { kind: 'saving-draft' };
    try {
      await store.replace({
        draftKey: snapshotDraftKey(this.record.filePath, this.record.id),
        isNew: this.isNew,
        pngBytes: Uint8Array.from(this.pngBytes),
        record: structuredClone(this.record),
        savedAt: this.now(),
      });
      this.persistence = { kind: 'draft-saved' };
    } catch (error) {
      this.persistence = { error, kind: 'error' };
      throw error;
    }
  }

  async done(repository: SnapshotAnnotationWriter): Promise<SnapshotAnnotationRecord> {
    if (this.record.ink.strokes.length === 0) {
      throw new Error('Draw at least one stroke before saving this Snapshot Annotation.');
    }
    if (this.persistence.kind === 'saving') {
      throw new Error('Snapshot Annotation save is already running.');
    }
    if ((!this.dirty && !this.isNew) || this.persistence.kind === 'saved-locally') {
      this.persistence = { kind: 'saved-locally' };
      return this.record;
    }
    this.pendingRecord ??= this.isNew
      ? this.record
      : { ...this.record, revision: this.record.revision + 1, updatedAt: this.now() };
    this.persistence = { kind: 'saving' };
    try {
      await repository.create(this.pendingRecord, this.pngBytes);
      this.record = this.pendingRecord;
      this.pendingRecord = null;
      this.dirty = false;
      this.isNew = false;
      this.persistence = { kind: 'saved-locally' };
      return this.record;
    } catch (error) {
      this.persistence = { error, kind: 'error' };
      throw error;
    }
  }
}

export function snapshotDraftKey(filePath: string, snapshotId: string): string {
  if (filePath.length === 0 || snapshotId.length === 0) {
    throw new Error('Snapshot Draft identity must not be empty.');
  }
  return `${filePath}:${snapshotId}`;
}

function isPersistenceLocked(persistence: SnapshotAnnotationSessionPersistence): boolean {
  return (
    persistence.kind === 'saving' ||
    persistence.kind === 'saving-draft' ||
    persistence.kind === 'saved-locally' ||
    persistence.kind === 'draft-saved'
  );
}

function cloneAndClipStroke(stroke: InkStroke, width: number, height: number): InkStroke {
  const points = stroke.points.map((point): InkPoint => ({
    ...point,
    x: clipFinite(point.x, width),
    y: clipFinite(point.y, height),
  }));
  return {
    ...stroke,
    ...(stroke.inputProfile === undefined ? {} : { inputProfile: { ...stroke.inputProfile } }),
    points,
  };
}

function clipFinite(value: number, maximum: number): number {
  if (!Number.isFinite(value))
    throw new Error('Snapshot Annotation Ink coordinates must be finite.');
  return Math.min(maximum, Math.max(0, value));
}
