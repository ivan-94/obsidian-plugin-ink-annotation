/** Passive rendering may diagnose layout drift, but only explicit Ink entry may persist it. */
export function shouldPersistInkReconciliation(input: {
  readonly currentRevision: number;
  readonly interactive: boolean;
  readonly reconciledRevision: number;
}): boolean {
  return input.interactive && input.reconciledRevision !== input.currentRevision;
}
