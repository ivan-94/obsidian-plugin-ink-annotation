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

One user-authored mark with one stable identity. The canonical document snapshot stores it directly
in Note Logical World coordinates. Legacy bounded surfaces may decode it from linked fragments, but
fragmentation is no longer part of the production write contract.

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
canonical snapshot on the input path. It is the sole active editor for a note and remains in memory
until Done, Discard, or process loss.

## Canonical Ink Snapshot

The one complete logical document stored at the note's `ink.json`. Done blindly replaces this file;
the latest successful Done wins. A snapshot has no expected base, revision chain, merge obligation,
surface transaction, or render-cache dependency.

## Draft Buffer

A best-effort, device-local IndexedDB record containing the latest complete in-memory document. It
is replaced only after a clear background or sustained no-interaction signal. There is exactly one
record per note: no operation log, acknowledgement chain, compaction, or merge. A newer Draft may be
restored when entering Ink Mode; Preview remains canonical-only. Draft failure never blocks drawing
or Done.

## Legacy Recovery Journal

The retired S26/S26R1 device-local write-ahead format. Production no longer opens, arms, appends,
leases, acknowledges, compacts, garbage-collects, or restores it. Its codecs may remain temporarily
for explicit offline migration and old tests, but it cannot block the canonical document or create
an Ink Retry workflow.

## Stage Frame

The existing single coordinate contract relating client, Canvas, and note-logical coordinates. Every
Contact Batch uses exactly one complete Stage Frame epoch.

## Note Logical World

The existing stable per-note coordinate plane used by canonical Ink and the Ink Live Document. A
Projection Identity names one exact content snapshot in this plane; it does not create another
origin or coordinate formula. The origin is the Markdown display plane's logical top-left, and one
logical unit is one unscaled CSS pixel at 100% presentation. Pane-wide Ink may use negative X or X
beyond the 704 logical-px Markdown width. Existing schema positioning and Physical fragment
provenance globalize surface-local points. Scroll, zoom, DPR, viewport bounds, and Canvas backing
size project this world but never redefine it.

## World Tile Coordinate

The stable signed spatial `(LOD, column, row)` coordinate of one complete grid-aligned region in a
Note Logical World. It never includes content revision, renderer, viewport-clipped edges,
`scrollTop`, Canvas dimensions, or exact floating-point zoom.

## Tile Content Key

The exact disposable-pixel identity combining Projection Identity, Brush renderer/version, World
Tile Coordinate, per-coordinate Tile Content Token, and Raster Variant. Edit Scene Revision fences
work but does not globally invalidate unaffected coordinates whose Tile Content Token is inherited.

## Raster Variant

A disposable pixel representation of one World Tile Coordinate at a selected backing density,
color-space, and alpha contract. DPR and zoom help select a suitable LOD/variant; they do not mutate
Logical Stroke coordinates or Brush Geometry.

## Retained Tile Scene

A bounded historical-Ink presentation made from individually positioned reusable tiles under one
Stage Frame Camera transform. Existing or lower-LOD tiles remain visible until complete current
tiles replace them. The scene is neither one viewport bitmap nor an unbounded DOM/compositor layer
tree.

## Tile Residency

The visibility-aware in-memory lifecycle of decoded tile pixels: building, ready, visible,
near-visible, cold, dirty, stale, or disposed. Visible exact/fallback coverage is pinned; cold
resources are evicted first under the plugin-wide disposable-memory budget.

## Tile Build Worker

An optional long-lived, cooperatively resumable Worker Adapter that synchronizes acknowledged,
demand-first immutable projection slices, compiles Brush Geometry, rasters world tiles into a
bounded Worker-local OffscreenCanvas scratch pool, and returns transferable complete results. Pencil
input, Stage Frame/Camera updates, residency, scheduling policy, and DOM adoption remain on the main
thread. A resumable main-thread Tile Builder is always required as fallback.
