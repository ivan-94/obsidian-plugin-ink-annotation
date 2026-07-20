# Inkstone Domain Context

This glossary names the Ink concepts introduced by the native-feel performance and brush-fidelity
work. It complements `AGENTS.md`; it does not replace the product specifications.

## Ink Sample

A normalized, note-logical measurement captured from one confirmed stylus or mouse contact. It
contains position, monotonic time, pressure capability/value, and optional tilt. Predicted browser
samples are transient presentation inputs and are never Ink Samples in canonical sidecars.

## Contact Batch

The parent input event and its coalesced measurements, converted under one immutable Stage Frame
epoch. Processing cost depends only on the number of measurements in the batch, not on document
history.

## Active Stroke

The in-progress Pen or Highlighter mark owned by the current contact. Runtime error paths retain it
in mounted memory. Contact completion seals its incremental geometry and appends one Logical Stroke
to the Ink Live Document without waiting for storage. Only a successful canonical sidecar commit
makes it canonical.

## Active Stroke Presentation

The latency-first, mounted presentation of one Active Stroke. It consumes confirmed Ink Samples
incrementally and may also show a separately tagged provisional predicted tail. Its per-frame work
depends only on newly confirmed samples plus a bounded mutable tail, never on already painted stroke
length or document history. Canvas pixels, predicted samples, presentation buffers, and frame
bookkeeping are disposable and never become canonical Ink.

## Presentation Frame Generation

A monotonically increasing identifier assigned when Active Stroke Presentation requests a frame. It
binds the confirmed Contact Batches covered by that request to the exact render callback that
submits them. A later contact, viewport redraw, or unrelated frame can never complete the latency
measurement for an earlier generation.

## Logical Stroke

One user-authored mark with one stable identity. A Logical Stroke may be persisted as linked
fragments across bounded Ink surfaces while remaining one Undo, draft, selection, and render
identity.

## Brush Control Trace

The confirmed, causal, pressure/tilt-aware control points persisted for a completed Logical Stroke.
It is the canonical input to brush compilation. Disposable contours, meshes, masks, and Canvas
pixels are not part of the trace.

## Brush Geometry

Deterministic renderer-neutral contours, conservative bounds, and blend semantics compiled from a
Brush Control Trace. Brush Geometry is disposable and can always be rebuilt from canonical Ink.

## Brush Render Version

The immutable per-stroke identifier selecting the Pen or Highlighter physical model. Missing
metadata means `legacy-round-v1` only while decoding schema v1/v2. A schema v3 Pen/Highlighter with
missing or unknown metadata is unsupported and fails closed; it never silently selects another
model.

## Ink Live Document

The mounted, incremental read-and-command model that presents stable logical-stroke references,
viewport queries, exact changes, Undo/Redo, and persistence state without rebuilding a composite
canonical snapshot on the input path.

## Draft Buffer

A best-effort, device-local queue of completed Add operations written asynchronously after a stroke
is already usable. Draft v1 intentionally excludes relative editing commands that cannot be replayed
idempotently after a sidecar-write/Draft-delete crash. It is neither a write-ahead log nor a commit
prerequisite. Canonical sidecars remain authoritative; a canonical save of revision `N` permits
deletion of draft operations through `N`. Draft failure leaves mounted Ink usable and visibly
unsaved.

## Legacy Recovery Journal

The retired S26/S26R1 device-local write-ahead format. Production may read it only during a bounded,
cold migration into the Live Document/Draft Buffer model. New input never arms, appends, leases,
acknowledges, compacts, or garbage-collects a Recovery Journal. Stale or incompatible legacy bytes
are preserved but cannot block the canonical document or create an Ink Retry workflow.

## Stage Frame

The existing single coordinate contract relating client, Canvas, and note-logical coordinates. Every
Contact Batch uses exactly one complete Stage Frame epoch.
