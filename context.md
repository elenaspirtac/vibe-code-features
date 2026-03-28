# BIM Web Authoring Tool

## Documentation Convention

- **ROADMAP.md**: Progress tracker. Use ✅ for completed items. Keep done items visible (don't remove them). Shows what's done vs what's next.
- **context.md** (this file): Guide for future contributions. Documents current architecture, patterns, and gotchas — not a progress log. Update when implementations introduce patterns or gotchas not obvious from the code.
- **Git history + code**: Authoritative source for how things were built and how they work now.

## What This Is

A web-based BIM (Building Information Modeling) authoring tool. Users place and edit building elements (walls, windows, floors, etc.) interactively. Geometry is always derived from semantic data contracts — a wall is defined by start/end points, height, thickness, and offset; a floor is defined by a boundary polygon referencing wall endpoints; geometry is a consequence, never hand-edited.

## Tech Stack

- **TypeScript + Vite** — standard web project
- **Three.js** — 3D rendering, interactive editing (handles, previews, raycasting)
- **@thatopen/fragments** — BIM visualization and persistence library (fragment delta models, tile-based GPU rendering)
- **web-ifc (WASM)** — GeometryEngine for deterministic geometry generation (`engine.getWall()`, `engine.getExtrusion()`, etc.)

## Repo Layout

**We own and maintain the fragments library** (`@thatopen/fragments`). It lives in a sibling repo at `../engine_fragment/packages/fragments/`. When the modeling library needs new fragment capabilities (e.g., `onViewUpdated`, `clearHiddenForEdit`), we add them directly — no workarounds needed. Changes there require rebuilding and copying the worker:
```
cd ../engine_fragment/packages/fragments && yarn build
cp dist/Worker/worker.mjs public/worker.mjs
```

```
src/
├── main.ts              # Bootstrap: scene, fragments, tools, UI, undo/redo, save/load
├── core/
│   ├── contracts.ts     # Data contract interfaces (BaseContract + WallContract, WindowContract, FloorContract, etc.)
│   ├── document.ts      # BimDocument: single source of truth, events, transactions
│   ├── registry.ts      # ElementRegistry: modular element type definitions + relationships
│   ├── transaction.ts   # Transaction recording (MutationRecord, TransactionRecord)
│   ├── undo-manager.ts  # UndoManager: stacks, recording chain, selection sessions
│   └── events.ts        # Typed event emitter
├── elements/
│   ├── wall.ts          # Wall element definition (geometry, relationships, handles)
│   ├── window.ts        # Window element definition
│   ├── floor.ts         # Floor element definition (boundary polygon, connectedTo walls)
│   ├── column.ts        # Column element definition (Gate 7 extensibility proof)
│   ├── wall-type.ts     # Wall type definition (data-only, shared params: height, thickness)
│   ├── window-type.ts   # Window type definition (data-only, shared params: width, height, sillHeight)
│   ├── column-type.ts   # Column type definition (data-only, shared params: height, width)
│   └── level.ts         # Level definition (data-only, elevation-based horizontal plane)
├── generators/
│   ├── engine.ts        # GeometryEngine singleton (WASM init)
│   ├── profiles.ts      # Profile extrusion primitive (rectangleProfile, circleProfile, hProfile, extrudeProfile)
│   ├── wall.ts          # WallContract → BufferGeometry (with boolean void cuts)
│   ├── window.ts        # WindowContract → BufferGeometry (frame + glass + void)
│   └── floor.ts         # FloorContract → BufferGeometry (polygon extrusion)
├── fragments/
│   ├── manager.ts           # Loads fragment model, holds FragmentsModels ref, save/load buffer
│   ├── sync.ts              # Bridges BimDocument events → fragment edit API
│   ├── overlay.ts           # Instant three.js overlay meshes during edits
│   ├── visibility-state.ts  # VisState enum + VisibilityStateMachine (per-element state tracking)
│   └── writer.ts            # Raw EditRequest builder (bypasses createElements)
├── utils/
│   ├── joints.ts        # Wall joint detection (shared endpoints, neighbor lookup)
│   ├── snap.ts          # Snapping utilities (grid, angle, endpoint, wall body, registry snap points)
│   └── spatial-index.ts # RBush R-tree for O(log n) broadphase spatial queries
├── tools/
│   ├── tool-manager.ts  # Active tool state machine, ground-plane raycasting
│   ├── wall-tool.ts     # Click two points → create wall
│   ├── window-tool.ts   # Hover wall → preview → click to place window
│   ├── floor-tool.ts    # Click wall endpoints / free points → draw boundary polygon → create floor
│   ├── column-tool.ts   # Click to place column (with snap preview)
│   ├── select-tool.ts   # Multi-select, drag handles, shared corner drag, delete
│   └── move-tool.ts     # Two-click move: pick base → pick destination, with stretch targets + hosted element extraction
├── handles/
│   ├── base.ts          # Reusable draggable handle mesh
│   ├── wall-handles.ts  # Start/end/height handles for wall editing
│   ├── floor-handles.ts # Vertex handles + profile outline for floor editing
│   └── column-handles.ts # Base handle for column drag
└── ui/
    ├── toolbar.ts           # Tool buttons
    ├── properties.ts        # Property panel for selected element
    ├── joint-menu.ts        # Context menu for wall joint type (butt/miter)
    ├── snap-panel.ts        # Snap settings panel
    ├── temp-dimensions.ts   # Temporary dimension overlay (lengths, distances)
    └── styles.css           # Layout styles
```

## Core Architecture

```
BimDocument (contracts + events)
    │
    │  onAdded / onUpdated / onRemoved
    ▼
FragmentSync
    │
    ├─ Overlay: instant three.js mesh (covers lag)
    ├─ Debounce: 100ms idle timer with operation coalescing
    └─ Fragment edit: editor.createElements() / editor.edit() / deleteElements()
```

**Principle: geometry is derived, never stored.** Contracts hold parameters; generators produce BufferGeometry; fragments persist the result.

**Two-speed rendering:** Interactive edits use fast three.js overlay meshes. Fragment edits (slow but persistent) run in the background. The overlay covers the gap.

## Transaction System

Every mutation (`doc.add`, `doc.update`, `doc.remove`) is recorded in a transaction. Explicit transactions group multiple mutations atomically:

```ts
doc.transaction(() => {
  doc.add(window);
  doc.update(wallId, { hostedElements: [...] });
});
```

Key design decisions:
- **Events fire immediately** during the transaction body — overlays update per-frame during drag. Transactions record what happened, they don't defer events.
- **Implicit transactions**: bare `doc.add/update/remove` calls auto-wrap in a single-op transaction. Fully backward compatible.
- **No nesting**: if already inside a transaction, inner mutations join it.
- **Cascade on delete**: `doc.remove(wallId)` auto-deletes hosted elements (windows) within the same transaction. Cascade rules are configured via `doc.setCascadeResolver()` (wired in `main.ts` using the registry).
- **Rollback on error**: if the transaction body throws, all mutations are reversed (contracts restored, no events for the rollback).
- **`onTransactionCommit` event**: fires once after all mutations, with a `TransactionRecord` containing before/after snapshots of every mutation.
- **`groupId` option**: `doc.transaction(fn, { groupId })` tags the record for coalescing rapid updates into a single undo step (e.g., drag operations).
- **`transactionGroupId` property**: When set on `BimDocument`, auto-wrapped transactions (bare `add/update/remove` calls) inherit this groupId. The select tool sets this during drag to coalesce all per-frame updates.
- **Undo/Redo**: `doc.undo(record)` reverses a transaction's mutations in reverse order, restoring `fragmentIds` mappings. Returns a redo record. Skips cascade (original transaction already has all cascaded removals).

`MutationRecord` stores `{ type, id, before, after, fragmentId? }` — sufficient to reverse any mutation. The `fragmentId` is captured from `doc.fragmentIds` before deletion so undo can restore the mapping.

## Undo/Redo with Fragment History

Two-layer undo managed by `UndoManager` (`core/undo-manager.ts`). Contract state and fragment visual state are kept in sync. The class owns the undo/redo stacks, recording chain, selection sessions, and grouped transactions — main.ts just wires it to buttons and events (~22 lines).

1. **Recording**: `undoMgr.recordTransaction(record)` is called from `doc.onTransactionCommit`. After `sync.flush()`, the fragment history index (`sync.lastFragmentRequestIndex`) is saved alongside the transaction record.
2. **Selection-session grouping**: while elements are extracted (selected), ALL mutations accumulate into a single `selectionRecord` — the entire select→edit→deselect cycle is one undo step. Fragment flushes are deferred (`drainPending()` skips when `vsm.hasAny(Extracted)`). On deselect, `restore()` flushes once → one `fragIndex` → one undo entry. This avoids both delta-rebuild blinks during editing and fragIndex mismatches.
3. **Grouped transactions** (drag without selection — fallback): accumulated into `pendingGroupRecord`, merging mutations across frames (keeping first `before` per contract ID). Only pushed to undo stack after `finalizePendingGroup()` flushes and captures the correct fragIndex.
4. **Batch merging**: when consecutive transactions share the same `fragIndex` (fast sequential creates batched into one `editor.edit()`), their mutations are merged into a single undo entry — no empty undo steps.
5. **Undo**: `sync.isUndoRedo = true` suppresses all fragment side effects during `doc.undo()`. Then `sync.refreshExtractedOverlays()` updates any active overlays (so cascade neighbors like miter-connected walls show correct geometry). Finally `sync.navigateFragmentHistory(prevIndex)` uses `editor.selectRequest()` + `editor.edit([], { removeRedo: false })` to restore the fragment visual state. No blink — base model elements stay visible during the delta rebuild, and bridge overlays cover affected elements.
6. **Redo**: same pattern, navigating forward to the saved fragment index.

**Fast undo/redo (S.27):** Uses translucent model + overlay stack instead of per-element fragment hiding (which caused blinks). On first fast press, `UndoManager.accumulateFast()` makes all fragment meshes semi-transparent (opacity 0.3) via `sync.setModelTranslucency(true)`, mutates contracts instantly, and shows overlays for **primary elements only** (not cascade neighbors). Subsequent rapid presses (within 800ms debounce) only update overlays — no fragment edits. When the user stops, the debounce fires `finalizeFast()` which runs `navigateFragmentHistory()` to rebuild fragments in one shot. Critical details:
- `sync.expandWithNeighbors()` must be called BEFORE `doc.undo()` because undo removes contracts and cleans up `dependentsOf` — the expanded set is used for the rebuild, while only primary IDs get overlays.
- `primaryMutationIds()` filters add/remove mutations as primary (the directly created/deleted items). Falls back to all IDs for pure-update transactions (e.g., wall moves).
- When undoing a creation (primary item's contract removed by undo), falls back to the previous undo entry's primary element for the overlay — so the user sees the element at the history position they landed on.
- `navigateFragmentHistory` checks `modelTranslucent` flag: when true (fast path), it skips bridge overlay creation and overlay cleanup — the translucent model covers cascade neighbors, and fast-phase overlays stay as the bridge. Opacity is restored inside navigate (after rebuild, before final overlay cleanup) so the user sees: translucent → opaque updated model → overlays removed.

**Key**: fragment deletions use raw DELETE requests (DELETE_SAMPLE, DELETE_GLOBAL_TRANSFORM, DELETE_ITEM, and conditionally DELETE_REPRESENTATION/DELETE_LOCAL_TRANSFORM/DELETE_MATERIAL for shared resources) via `editor.edit()`, creating real history entries that `selectRequest` can navigate. Cascade deletes are batched into a single `editor.edit()` call to prevent intermediate flashes (e.g., window briefly visible after host wall deleted).

**Drain guard during selection**: `drainPending()` bails out if `vsm.hasAny(VisState.Extracted)` or `draggingIds.size > 0`. Calling `editor.edit()` while elements are extracted would rebuild the delta model — briefly showing extracted elements as visible fragments. The guard prevents this; pending ops stay in the map and flush on `restore()` (deselect).

**Undo button and pending groups**: `updateButtons()` checks both `undoStack.length` and `pendingGroupRecord` to determine if undo is available. Without this, the undo button stays disabled after a drag because the grouped record isn't pushed to the stack until `finalizePendingGroup()` runs — which only happens when the undo button is clicked or a new transaction arrives. Clicking empty space to deselect doesn't trigger a transaction, so the button must account for the pending group.

**Overlay bridging during history navigation**: In the slow path (no fast undo/redo), `navigateFragmentHistory` creates overlays for **affected elements + cascade neighbors** before the delta rebuild. Base model elements stay visible (not hidden) — this is critical to prevent blinks during `editor.edit()`, which disposes the old delta before the new delta's tiles are rendered. After the rebuild, base visibility is reconciled (show non-edited, hide edited via `getEditedElements()`), the delta is re-shown before `mgr.update()`, and overlays are cleaned up. At `-1` (initial state, delta empty), overlays are kept alive until `onViewUpdated` fires (with 200ms fallback) to give the base tile system time to render. In the fast path (`modelTranslucent` flag), bridge overlay creation is skipped entirely — the translucent model and fast-phase overlays provide continuity.

**Cascade neighbor expansion in history navigation**: In the slow path, `navigateFragmentHistory` expands affected IDs to include cascade neighbors (relationships + `dependentsOf`) before creating transition overlays. In the fast path, this expansion is skipped — the translucent model visually covers neighbors.

**Reverse dependency index consistency**: `updateDependentsIndex()` runs *before* the `isUndoRedo` early return in `onAdded`/`onUpdated` handlers. `onAdded` re-indexes neighbors (they now have a new relationship). `onUpdated` captures old neighbors before re-indexing, then re-indexes both old AND new neighbors — old neighbors drop stale entries (e.g., wall moved away), new neighbors gain missing entries (e.g., wall reconnected after undo). `onRemoved` deletes the element's target entry immediately and defers neighbor re-indexing via `queueMicrotask` (contract must be deleted first so `getRelationships` no longer sees the removed element). This ensures `dependentsOf` stays consistent through adds, updates, removes, and undo/redo.

**Load-time rebuild ordering**: `loadFromJSON` bypasses `onAdded`/`onUpdated` events (contracts are set directly), so the incremental indexing path never runs. The load flow must explicitly call `spatialIndex.rebuild()` THEN `sync.rebuildDependentsIndex()` — in that order, because wall `getRelationships()` calls `findNeighborsAtEndpoint()` which queries the spatial index. A lazy dirty flag (`dependentsIndexDirty`) serves as a safety net: `reset()` sets it, and `ensureDependentsIndex()` (called by `getDependents()`) triggers a full rebuild on first access if still dirty.

## Element Registry

`ElementRegistry` (`core/registry.ts`) provides a modular, extensible system for element types. Each element type registers an `ElementTypeDefinition` with:
- `generateGeometry(engine, contract, doc)` — produces **base** BufferGeometry (no boolean cuts)
- `getRelationships(contract, doc)` — returns typed relationships (open `string` type, not a closed union)
- `getBooleanOperands?(engine, contract, doc)` — returns element-specific boolean cut meshes (wall: miters, T-junctions, window voids)
- `getVoidGeometry?(engine, contract, doc)` — the shape this element subtracts when it cuts another element via a `cuts` relationship
- `getSnapPoints?(contract)` — snap target points for generic element snapping
- `createHandles(scene, doc, engine, contract, camera, container)` — creates drag handles for selection
- `onRemove(contract, doc)` — cleanup on deletion (e.g., window removes itself from host wall's list)

Element definitions live in `src/elements/`. Adding a new element type requires:
1. **Element definition** (`src/elements/foo.ts`) — contract interface, `ElementTypeDefinition` with geometry/relationships/snap points/handles
2. **Tool** (`src/tools/foo-tool.ts`) — creation workflow
3. **Handles** (`src/handles/foo-handles.ts`) — drag editing (implements `ElementHandles`)
4. **Bootstrap** (`main.ts`) — `registry.register(fooElement)`, create tool, add to toolbar (~4 lines)

Zero changes to sync.ts, select-tool.ts, overlay.ts, undo-manager.ts. Selection, undo/redo, save/load, snap, spatial indexing all work generically. Validated with the column element type (Gate 7).

### Declarative Relationship Schema (S.5)

Each relationship type has a registered `RelationshipBehavior` that declares how it behaves across the five cascade systems. The registry comes pre-loaded with the three built-in types:

| Type | `onExtract` | `onRestore` | `onDelete` | `onChange` |
|------|-------------|-------------|------------|------------|
| `hosts` | recurse | recurse | cascade | refresh |
| `hostedBy` | recurse | recurse | skip | refresh |
| `connectedTo` | include | include | skip | refresh |
| `instanceOf` | skip | skip | skip | skip |

**Behavior meanings:**
- `onExtract`: `"recurse"` = extract target + walk its relationships; `"include"` = extract target only; `"skip"` = don't extract
- `onRestore`: `"recurse"` = restore target + walk; `"include"` = restore target + its hosted children; `"skip"` = don't restore
- `onDelete`: `"cascade"` = delete target too; `"skip"` = leave target alive
- `onChange`: `"refresh"` = regenerate target's overlay/fragment; `"skip"` = ignore

**Extension point:** `registry.registerRelationshipType(name, behavior)` adds a new type. Unknown types fall back to safe defaults (`include`/`include`/`skip`/`refresh`). Adding a new relationship type requires zero changes to `sync.ts`.

**Delete cascade:** `registry.resolveCascadeDelete(id, doc)` replaces the inline cascade resolver in `main.ts`. It reads `onDelete` behavior from the registry.

**Where `sync.ts` uses behaviors:**
- `collectExtract()` — reads `onExtract` to decide recurse vs include vs skip
- `collectRestoreCascade()` — reads `onRestore` to decide recurse vs include vs skip
- `restoreWithHostedChildren()` — reads `onDelete` to find which children to restore alongside a peer (children that would cascade-delete with it)
- `cascadeOnChange()` — reads `onChange` (currently all built-in types use `"refresh"`)
- `navigateFragmentHistory()` — expands affected IDs to cascade neighbors (relationship existence, not behavior type)

## Type/Instance Model

Separates *what* an element is (type) from *where* it is (instance). Like Revit's type selector — you pick "Generic Wall - 200mm" before drawing.

**Type contracts** (`WallTypeContract`, `WindowTypeContract`) hold shared parameters. They are **data-only** — no geometry, no fragments, no overlays. Registered with `dataOnly: true` on their `ElementTypeDefinition`.

**Instance contracts** (`WallContract`, `WindowContract`) hold placement + required `typeId` reference. Every instance must belong to a type — `createWall(start, end, typeId)` and `createWindow(hostId, position, typeId)` take `typeId` as a mandatory parameter.

**Parameter categories**: each parameter belongs to one of three categories:
- **Type-only** — always from type, not on instances (e.g. wall `thickness`). `WallContract` has no `thickness` field.
- **Instance-only** — only on instances (e.g. `start`, `end`, `position`, `offset`).
- **Defaultable** — type provides default, instance can override. On the instance interface these are optional (`height?: number`). `undefined` means "use type default". Wall `height`, window `width`/`height` are defaultable.
- **Instance-only (param)** — declared in `typeParams` with `category: "instance-only"`. Only shown on instance properties panel, not on type panel. Window `sillHeight` is instance-only.

**Resolution**: `resolveWallParams(wall, doc)` and `resolveWindowParams(win, doc)` return resolved params with all values guaranteed. For defaultable params, instance wins if set, else type default. For type-only params, always reads from type. `ResolvedWall` and `ResolvedWindow` type aliases combine the contract with guaranteed params — used by generators that need all values present.

**`instanceOf` relationship**: emitted by instances when `typeId` is set. All behaviors are `"skip"` — editing one window shouldn't extract all windows of the same type. The reverse direction (type → instances) uses the existing `dependentsOf` reverse index.

**Cascade flow**: type updated → `onUpdated` detects `isDataOnly` → calls `cascadeOnChange` → `dependentsOf[typeId]` contains all instance IDs → each instance gets overlay refresh + fragment rewrite with new type parameters. The cascade is **recursive**: after updating a dependent, `cascadeOnChange` is called again on the dependent so its own relationships are refreshed (e.g., window type change → window updated → host wall needs new void geometry). Same pattern for type deletion via `onRemoved`.

**`sync.ts` data-only guards**: `onAdded`, `onUpdated`, and `onRemoved` all check `registry.isDataOnly(kind)` to skip overlay/fragment operations for type contracts while still maintaining the dependency index and cascading to dependents. `cascadeOnChange` also skips data-only targets to avoid generating geometry for type contracts when an instance's relationships are traversed.

**UI — Side panel**: Full-height right sidebar (`SidePanel` in `ui/side-panel.ts`) with tabbed interface. **Types tab** (`TypesTab` in `ui/types-tab.ts`) lists all type contracts grouped by kind, supports inline editing, create (+ New), and delete. **Materials tab** (`MaterialsTab` in `ui/materials-tab.ts`) CRUD for global material contracts. **Properties tab** shows type-only params as read-only, defaultable params with override/reset button. A "reset" button clears the instance override so the value reverts to the type default. Type dropdown lets reassigning an element's type. Default types created on startup. Tools read `typeId` from the active type selection.

## Materials System

**Material contracts** (`MaterialContract` in `elements/material.ts`) are standalone `dataOnly` entities: name, color (RGB 0-1), opacity (0-1), doubleSided, stroke. Reusable across types.

**Material slots** are declared on **type definitions** via `materialSlots: string[]` (e.g., `["frame", "glass"]` on windowType, `["body"]` on wallType). The type contract stores `materials?: Record<slotName, materialId>` mapping slots to material contract IDs. The slot→sub-geometry mapping is element-specific logic in `generateLocalGeometry`, not framework-enforced — slots are semantic names that the type defines and the instance code interprets.

**Cascade**: Type definitions declare `usesMaterial` relationships for each materialId in their `materials` map. Material edit → `cascadeOnChange` → finds type dependents via `dependentsOf` → recurses through data-only types to reach instances → fragment writes with `UPDATE_REPRESENTATION` + `UPDATE_MATERIAL`.

**Material resolve**: `resolveMaterial(materialId, doc, fallback)` in `utils/material-resolve.ts` returns a cached `MeshLambertMaterial` from a material contract. Used by `generateLocalGeometry` (instanced elements) and `prepareUpdate`/`buildCreate` (unique elements). `PREVIEW_MATERIAL` is a shared translucent material used by all placement tools and drag overlays. Default element materials: window glass is transparent blue (`0x88bbdd`, opacity 0.3), door panel is warm wood (`0xc8a882`), frames default to light gray (`0xd6d6d1`).

**Generator splitting**: Window and door generators are split into sub-geometries (`generateWindowPartsLocal` → frame + glass, `generateDoorPartsLocal` → frame + panel). Each part gets its own material from the type's slot assignments and its own `geoHash` (which includes the materialId for dedup correctness). Column and wall remain single-part (`"body"` slot).

**Overlay**: Uses the first material slot's color for the merged overlay mesh (single-material approximation). Per-part overlay materials are a future optimization.

## Unified Boolean Pipeline

All boolean operations (miter cuts, T-junction trims, window voids, ad-hoc cuts) go through a single pipeline in `ElementRegistry.generateGeometry()`:

1. **Base geometry**: `def.generateGeometry(engine, contract, doc)` — produces geometry WITHOUT boolean cuts. Wall includes joint extensions (so the miter has material to cut) but no boolean operations.
2. **Element-specific operands**: `def.getBooleanOperands?(engine, contract, doc)` — returns `BooleanOperand[]` (each has `type: "DIFFERENCE" | "UNION"` and `mesh`). Wall returns miter cut boxes + T-junction cut boxes + window void meshes.
3. **Generic ad-hoc cuts**: `collectGenericCuts(engine, targetId, doc, registry)` scans contracts for `"cuts"` relationships targeting this element, calls `getVoidGeometry()` on each cutter.
4. **Apply all**: `applyBooleanOperands(engine, baseGeo, allOperands)` applies sequential boolean operations.

When `skipBooleans` is true (during drag), steps 2-4 are skipped entirely — only base geometry is generated.

**`"cuts"` relationship type** — registered with `{ onExtract: "skip", onRestore: "skip", onDelete: "skip", onChange: "refresh" }`. Cutter moves → target regenerates with updated void position. Cutter deleted → target regenerates without the void. No ownership implications.

**Adding a cuttable element**: Any element gets ad-hoc cuts automatically — the registry applies generic cuts to ALL elements. No per-element opt-in needed.

**Adding a cutting element**: Implement `getVoidGeometry(engine, contract, doc)` on the element type definition. Store cut targets in the contract (e.g., `cutTargets: ContractId[]`). Emit `{ type: "cuts", targetId }` from `getRelationships()`.

**High-level cut API**: `sync.addCut(cutterId, targetIds)` adds cut targets and refreshes geometry. `sync.removeCuts(contractId)` clears all cuts and refreshes former targets. These handle contract updates + `forceRefresh` in one call.

### forceRefresh (non-extracted element update)

`sync.forceRefresh(contractId)` forces geometry regeneration for an element that may not be extracted. Used when an external change (e.g., adding/removing a `cuts` relationship) affects an element's geometry but doesn't go through the normal extract/restore flow.

- **If extracted**: invalidates geo cache → `overlay.set()` → `markDirty()`. Normal restore will flush to fragments.
- **If not extracted**: bypasses `schedulePending` → `drainPending` entirely (which blocks while any element is extracted). Instead, directly enqueues an `onFlush` via `this.enqueue()` — overlay appears immediately, fragment write happens in the async queue.

**Why bypass drainPending?** `drainPending` has an extraction guard: `if (vsm.hasAny(Extracted)) return;`. This prevents fragment writes while elements are selected. But `forceRefresh` targets elements the user isn't editing — they need immediate updates regardless of what else is selected.

### Temporary Visibility

`sync.temporaryHide(ids)` / `sync.showAllTemporary()` toggle element visibility without affecting the extract/restore lifecycle. Used for "Hide Selected" / "Show All" UI actions.

- Hides both fragment (via delta model `setVisible(false)`) and overlay (via `overlay.hide()`).
- Tracked in a `tempHidden` Set, cleared on `reset()`.
- Show restores visibility on both fragment and overlay.

### Geometry Cache Reverse-Cuts Lookup

The geometry cache key must include contracts of elements that **cut** the current element (reverse direction). The `reverseCutsLookup` function on `GeometryCache` uses the `dependentsOf` reverse index for O(k) lookup instead of O(n) scanning all contracts. Set by `FragmentSync` in its constructor.

### Delete + Cuts Timing

When a cutter is deleted, `onRemoved` fires before `contracts.delete()`. If we regenerate the target immediately, `collectGenericCuts` still finds the deleted cutter. Solution: defer cut-target refresh via `queueMicrotask` so it runs after the contract is removed from the map.

When a **cut target** is deleted, elements that reference it via `cutTargets` have their stale entries pruned via `doc.update()` in the `onRemoved` handler (dependent refresh loop). This keeps the relationship graph consistent — without it, the cutter's `cutTargets` would contain a dangling reference, causing `dependentsOf` index mismatches.

**Overlay removal timing in `onRemoved`**: The `overlay.remove(id)` call must happen AFTER all cascade processing (relationship refresh, dependent pruning, `doc.update` calls). Cascade processing can trigger `cascadeOnChange` which re-creates overlays via `priorRelationships` if the removed element was a former cascade target. Removing the overlay early (before cascade) leaves a stale overlay in the scene.

### endDrag Cascade Refresh

When a drag ends, related elements that weren't extracted (e.g., a wall that gained a new miter neighbor during drag) need their overlays refreshed with full booleans. `endDrag` invalidates their geo cache and calls `overlay.set()` — but does NOT use `forceRefresh` (which triggers `onFlush` → delta rebuild → visible flash of stale fragment positions for extracted elements).

Instead, fragment writes stay as pending ops. They flush via `drainPending()` which is called at the end of `restore`'s enqueued task — once the dragged element is deselected and no elements are extracted, the pending ops for related elements finally execute.

`endDrag` also handles **reverse cascade** (dependents via `dependentsOf` index), not just direct relationships.

### restoreWithHostedChildren Guard

`restoreWithHostedChildren` skips elements that are NOT extracted (`if (!isExtracted(id)) return`). This prevents the restore cascade from deleting pending ops and removing overlays for elements that were never extracted — which happens when a new relationship forms during drag (e.g., wall 1 becomes wall 2's miter neighbor during drag, but wall 1 was never in wall 2's original extract cascade).

## Visibility State Machine

Every element has an explicit visibility state managed by `VisibilityStateMachine` (`src/fragments/visibility-state.ts`). This replaces the old ad-hoc `extractedIds`/`dirtyIds` sets with validated transitions:

| State | Meaning | Fragment | Overlay |
|-------|---------|----------|---------|
| **Normal** (default) | Not tracked — fragment renders normally | visible | none |
| **Extracted** | Selected for editing | hidden | active |
| **Restoring** | Deselected, waiting for fragment tiles | flushing | bridge |
| **~~FastUndo~~** | ~~Rapid undo/redo~~ *(VSM state unused — S.27 uses translucency instead)* | — | — |
| **Flushing** | Non-extracted element being written to fragments | visible | bridge |
| **HistoryNav** | Fragment history rebuild in progress | rebuilding | bridge |

**Dirty flag**: only meaningful in Extracted state. Tracks whether the element was modified during selection. Survives into Restoring (needed for restore flush), cleared on transition to Normal.

**Tiles-ready signal**: `waitForTilesReady()` uses the fragment library's `onViewUpdated` event (with 200ms safety fallback) instead of `setTimeout(500)` heuristics. Used in restore and history navigation to keep overlays alive until base tiles have rendered.

Access: `sync.vsm` is public readonly. Use `sync.vsm.getState(id)`, `sync.vsm.isDirty(id)`, `sync.vsm.inState(state)`, `sync.vsm.hasAny(state)`.

## Key Patterns

### Extract/Restore (selected elements)
When an element is selected, it's "extracted": state transitions Normal → Extracted, hidden in fragments via `setVisible(false)` on both base and delta models, shown as an overlay mesh. All edits during selection update only the overlay (instant) and mark the element dirty. On deselect, state transitions Extracted → Restoring, **all** restored elements are flushed to the delta model (not just dirty ones), and the overlay is removed after tiles are ready (Restoring → Normal). Flushing all elements to the delta (instead of relying on base `setVisible(true)` for non-dirty elements) prevents the tile system from leaving base-model elements invisible after delta rebuilds.

### Invariant Checking
`sync.assertInvariants()` validates internal consistency — call in dev builds, tests, or from the browser console (`__bim.sync.assertInvariants()`). Checks 10 categories: (1) every non-Normal vsm entry has a contract (all states, not just Extracted/Restoring), (2) extracted elements have overlays, (3) extracted elements have priorRelationships snapshots, (4) priorRelationships only for Extracted/Restoring, (5) `dependentsOf` matches registry relationships (bidirectional), (6) draggingIds are extracted, (7) dirty flags only on Extracted/Restoring, (8) pendingOps reference existing contracts, (9) tempHidden references existing contracts, (10) no orphan overlays (overlay exists but element is Normal with no pending op). Throws with a list of all violations found. No side effects (except lazy `dependentsOf` rebuild if dirty) — safe to call at any time.

### Edit Queue Serialization
All async fragment operations are serialized via a promise chain. Without this, rapid operations cause race conditions.

### Work Plane
All modeling operations happen on an active work plane. `ToolManager` owns the current `WorkPlane` (origin, normal, xAxis, yAxis). Raycasting projects the cursor onto this plane. Wall/window/floor generators derive the base elevation from the contract's Y coordinate (e.g., `contract.start[1]`), so geometry renders at the correct height. The preview geometry must also use the same elevation — if `engine.getWall()` gets `elevation: 0` while the contract stores Y=3, the preview and final geometry will mismatch. Default plane: XZ ground at Y=0. Change at runtime via `toolMgr.setWorkPlane(createGroundPlane(elevation))`.

### Stress Test
`generateStressTest(doc, opts)` in `utils/stress-test.ts` creates an N×M grid of connected rooms. Default 10×10 produces ~220 walls, ~110 windows, ~100 floors (~430 elements). Use the "Stress 10×10" button in the debug bar or `__bim.stressTest({ rows: 5, cols: 5 })` from the console. Custom options: `rows`, `cols`, `cellSize`, `height`, `thickness`, `windowEvery`, `floors`.

### Overlay Material
Uses negative `polygonOffset` (factor/units = -1) to push the overlay inward toward the camera, preventing z-fighting with fragment geometry. Combined with `renderOrder = 1` to draw on top of stale fragments.

## Fragment Model System

- Uses `@thatopen/fragments` with immutable flatbuffer delta models.
- Raw models (no saved file) have an empty base — all data in deltas.
- `model.deltaModelId` on the base model points to the current delta.
- Element `localId` must be preserved across edits — never delete+recreate.
- **Visibility must target both base and delta models.** After save/load (`editor.save()` flattens edits into base), elements live in the base model with no delta. `hideElements` and `reHideExtracted` call `setVisible` on both. On restore, all elements are flushed to the delta (ensuring they render from there); the base `setVisible(true)` fallback only runs for elements that somehow aren't in the delta (e.g., never-flushed creates).
- **Deletion**: build raw DELETE requests (DELETE_SAMPLE, DELETE_GLOBAL_TRANSFORM, DELETE_ITEM, and conditionally DELETE_REPRESENTATION/DELETE_LOCAL_TRANSFORM/DELETE_MATERIAL for unshared resources) then `editor.edit()`. This creates proper fragment history entries. Do NOT use `setVisible(false)` for deletion — it doesn't create history entries.
- **Fragment history API**: `editor.getModelRequests(modelId)` → `{ requests, undoneRequests }`. `editor.selectRequest(modelId, index)` navigates to a point in history. `editor.edit(modelId, [], { removeRedo: false })` rebuilds the delta model at that point.
- Three.js raycaster doesn't work on fragments — use fragments' own `model.raycast()`.
- `FragmentsModel.dispose()` does NOT remove from `models.list` — must delete explicitly.

## Profile Extrusion Primitive (2.3)

`generators/profiles.ts` provides the building block for creating profile-extruded elements (columns, beams, pipes, ducts, etc.).

**Profile generators** — each returns a flat `number[]` of 3D points in the XZ plane (Y=0), ready for `engine.getExtrusion()`:
- `rectangleProfile(width, depth)` — rectangular cross-section
- `circleProfile(radius, segments?)` — circular cross-section
- `hProfile(flangeWidth, depth, flangeThickness, webThickness)` — H/I-beam
- `tProfile(flangeWidth, depth, flangeThickness, webThickness)` — T-section
- `cProfile(width, depth, flangeThickness, webThickness)` — C-channel
- `lProfile(width, height, thickness)` — L-angle
- `customProfile(points: [x, z][])` — arbitrary 2D shape

**High-level helper:**
```ts
const geo = extrudeProfile(engine, {
  profile: rectangleProfile(0.3, 0.3),
  position: [5, 0, 3],
  direction: [0, 1, 0],  // up
  length: 3.0,
});
```

Uses `engine.getExtrusion()` (WASM) with automatic Three.js `ExtrudeGeometry` fallback. Supports holes via `holes` option.

**Reference implementation:** The column element (`elements/column.ts`) uses `extrudeProfile()` — copy it as a starting point for new profile-extruded element types.

**What's available but not yet wrapped:**
- `engine.getProfile()` — structural profiles (H/C/Z/T/L with fillets) as point data. Could feed into `extrudeProfile()`.
- `engine.getSweep()` — sweep profile along a 3D curve path (for curved beams, railings).
- `engine.getRevolve()` — revolve profile around an axis (for pipes, fittings).

## Geometry Preparation Pipeline

Generators produce raw `BufferGeometry` (often from `engine.getBooleanOperation`). Before the shell converter can process it, `sync.ts`'s `generateGeometry` normalizes the geometry:

1. **`mergeVertices(geo, 1e-4)`** — Boolean output has near-duplicate vertices (~1e-6 apart) that the shell converter's `Points` class (precision 1e-6) rounds to different values, breaking edge matching.
2. **`toNonIndexed()`** — Converts to non-indexed so `computeVertexNormals` produces flat face normals (not smooth averaged normals from shared vertices). The shell converter reads vertex normals to group coplanar triangles by plane ID.
3. **`computeVertexNormals()`** — Generates flat face normals via cross product.
4. **`quantizeNormals(flat, 1e-4)`** — Snaps normals to a coarse grid. Cross products on different coplanar triangles produce slightly different normals due to floating-point arithmetic with different vertex positions. The shell converter's `Plane` class rounds normals to group them, so even tiny differences break face merging. Quantizing ensures coplanar triangles get identical normals.
5. **Sequential index buffer** — Shell converter requires an index; add `[0, 1, 2, ..., N-1]`.

**Any new generator** that produces boolean or complex geometry benefits from this pipeline automatically — it runs in `sync.ts`, not in individual generators.

## Geometry Cache (S.9)

`GeometryCache` (`utils/geometry-cache.ts`) is a content-addressed cache that avoids redundant `generateGeometry()` calls.

- **Key**: stable JSON of the contract + all related contracts (neighbors for booleans, hosts for windows, boundary walls for floors). Two tiers: `F` (full, with booleans) and `S` (simple, without booleans).
- **Returns clones**: cached geometry is never handed out directly — callers get `.clone()` so they can dispose independently.
- **Invalidation**: `invalidate(contractId)` removes all entries whose key contains that ID (covers both the element itself and neighbors that included it).
- **Eviction**: FIFO at 2000 entries. Disposed geometries are freed.
- **Wired into**: `OverlayManager.set()` (overlay creation) and `FragmentSync.generateGeometry()` (fragment flush). Both paths go through the cache.
- **Skip-booleans during drag**: when `draggingIds` is non-empty, ALL overlays skip booleans (not just the dragged element). Cascade neighbors need fast updates during drag — full booleans are deferred to commit.
- **Stats**: `geoCache.hits`, `geoCache.misses`, `geoCache.size` — included in `debugDump()`.

## Overlay Budget (S.8)

`navigateFragmentHistory` only creates bridging overlays for **affected elements + cascade neighbors**, not all contracts. Unedited elements stay on the base model (which isn't hidden during rebuild). The affected set is expanded with `getRelationships()` + `dependentsOf`. Fallback: if no `affectedIds` are provided, all contracts get overlays (safe but slow).

## Raw Edit API (FragmentWriter)
All fragment operations (create, update, delete) use raw `EditRequest` arrays via `FragmentWriter` and `editor.edit()`. No Element API (`getElements`/`getMeshes`/`setMeshes`) is used. Key details:

- **TempId chaining**: Each create generates requests (item, global transform, and per-sample: local transform, representation, material, sample) linked by string tempIds. The worker resolves tempIds → localIds. `resolveAllIds()` returns a `FragmentElementIds` object with resolved localIds. For instanced elements, shared resources from `typeReprIds` are passed as resolved localIds (numbers) directly — no tempId needed.
- **`editor.edit()` mutates requests in-place** — after the call, each request object has `localId` set. Read it directly; don't try to correlate with the return array.
- **Conversion helpers** are exported from `@thatopen/fragments`: `GeomsFbUtils.representationFromGeometry()` (BufferGeometry → RawShell), `GeomsFbUtils.transformFromMatrix()` (Matrix4 → position + directions), `EditRequestType` enum.
- **Updates for unique elements**: `UPDATE_REPRESENTATION` with world-space geometry.
- **Updates for instanced elements**: `UPDATE_REPRESENTATION` (once per reprId, local-space geometry) + `UPDATE_GLOBAL_TRANSFORM` (per-instance, only if the transform changed since extraction). The GT update requires `{ ...gtData, itemId: ids.itemId }`.
- **All requests (creates + updates) merge into one array** → single `editor.edit()` → single `mgr.update(true)`.
- **`FragmentElementIds`**: stored per contract in `doc.fragmentIds`. Contains `itemId`, `gtId`, and a `samples` array where each sample has `sampleId`, `reprId`, `ltId`, `matId`. Supports N samples per element for future multi-geometry elements (current elements use 1 sample).
- **Type-level representation ownership**: Representations (repr + lt + mat) are owned by the type, not instances. `doc.typeReprIds` maps `typeId → geoHash → SharedReprIds`. On instance creation, `generateLocalGeometry` returns `{ worldTransform, parts: [{ geometry, geoHash }] }`. Each part's `geoHash` is looked up in `typeReprIds` — if found, the existing repr is reused (no new fragment entities created). If not found, a new repr is created and stored in `typeReprIds`. This means 500 windows of the same type share 1 representation regardless of how many separate flushes created them.
- **Type deletion cleanup**: When a type contract is deleted, its owned repr/lt/mat are cleaned up. If instances are cascade-deleting in the same batch, the repr deletes are included in `onDeleteBatch`. If no instances remain, they're deleted in a standalone `editor.edit()` call.

## Hosted Elements Pattern (Windows, Doors, etc.)
Each element type follows: **contract + generator + tool**. This is modular and extensible by AI.

### Host↔Guest Dependency
- Windows reference their host wall via `hostId`. Position is a 0–1 parameter along the wall centerline (moves with the wall automatically).
- **When a window changes, the host wall must re-render** (to update the boolean void cut). `scheduleHostWallUpdate()` handles this.
- **When a window is extracted (selected), its host wall is also extracted.** Both become overlays for instant feedback. On deselect, both are restored in a single batched `onFlush()`.
- Wall geometry generator accepts optional `hostedWindows` param and chains `engine.getBooleanOperation(DIFFERENCE)` for each (~5ms per cut).
- `generateWindowVoid()` creates an oversized box (wall thickness + 0.1) for clean boolean cuts.
- **Hosted element handles** (`src/handles/hosted-handles.ts`): Windows and doors can be dragged along their host wall after placement. The handle intersects the camera ray with the wall's near face (vertical plane offset by half thickness toward the camera), projecting onto the centerline for the 0–1 position parameter. During drag, a translucent material (`depthTest: false`) makes the element visible inside the wall.

### Wall Joints (Miter Cuts)
- Walls have `startJoin` and `endJoin` fields (`"butt"` | `"miter"`, default `"miter"`).
- **Miter geometry**: Walls sharing an endpoint get diagonal boolean cuts at the bisector angle. The wall is extended past the joint by `(thickness/2) / tan(halfAngle)` so the cuts meet flush (like a picture frame).
- **Miter cut plane**: The miter LINE runs along the bisector of two wall directions. The cutting PLANE is vertical with normal `cross(bisector, up)`. Each wall is cut on the neighbor's side.
- `findNeighborsAtEndpoint()` in `src/utils/joints.ts` finds walls sharing a coordinate.
- **Extract/restore includes neighbors**: When a wall is extracted for editing, all miter-connected neighbors are also extracted (hidden in fragments, shown as overlays) so stale fragment geometry doesn't bleed through. On restore, neighbors are restored with updated geometry.
- **During drag**: Neighbor overlays refresh instantly (no fragment writes). Fragment writes only happen on restore.
- **Background cascade writes during extraction**: When an extracted element changes (e.g., window resize), `cascadeOnChange` schedules fragment writes for cascade targets (e.g., host wall) immediately. These fragments stay hidden via `reHideExtracted` but are ready when restored, eliminating the flash of stale geometry.

### T-Junctions (Butt Joints at Wall Body)
- A T-junction occurs when a wall's endpoint meets another wall's body mid-span (not at an endpoint).
- **Contract-based, not spatial**: T-junction relationships are recorded at snap time, not detected spatially at geometry time. `WallContract` has optional `startTJunction` and `endTJunction` fields holding the host wall's ID.
- **Wall body snap**: `snap.ts` projects the cursor onto wall centerlines (excluding a margin near endpoints to avoid ambiguity with endpoint snap). Returns `type: "wallBody"` with the host wall's `targetId`. Orange indicator (0xff8800) distinguishes from endpoint snap (cyan).
- **Geometry approach**: The joining wall is extended past the host wall's centerline by `host.thickness/2 + 0.01`, then a boolean DIFFERENCE trims it at the host's near face. The receiving (host) wall is untouched.
- **`buildTJunctionCutBox`**: Computes the host wall's near face (the face closest to the joining wall's body), then places a large cutting box on the host's side of that face. Works for any angle between the two walls.
- **Cascade**: The joining wall declares a `connectedTo` relationship with the host wall, so changes to the host (move, resize) trigger the joining wall's geometry rebuild.

### Floors (Boundary Polygon Elements)
- First many-to-many relationship: a floor references multiple walls, a wall can be referenced by multiple floors.
- **Hybrid boundary model**: `FloorContract.boundary` is an array of `FloorBoundaryVertex`, each either `{ type: "wallEndpoint", wallId, endpoint }` (parametric — resolves to wall's current position at geometry time) or `{ type: "free", position }` (fixed coordinate). Extensible to future ref types (columns, grid intersections).
- **Floor tool**: 2D polygon drawing on XZ ground plane. Snaps to wall endpoints (existing snap system) but also accepts free clicks (grid snap). Close polygon by clicking first point or pressing Enter.
- **Geometry**: `engine.getExtrusion()` with flat 3D profile points in XZ plane, extruded downward by thickness. Fallback to `THREE.ExtrudeGeometry`. Winding order checked (CCW required).
- **Relationships**: Floor declares `connectedTo` for each unique wall in its boundary refs. Walls don't know about floors.
- **Reverse cascade**: The sync pipeline maintains a `dependentsOf` reverse index (`Map<targetId, Set<dependentId>>`). When a wall changes, `cascadeOnChange` looks up dependents and refreshes their overlays/fragments. This is what makes floors update when referenced walls move — the wall's forward relationships don't include the floor, but the reverse index does.
- **Floor handles**: `FloorHandles` implements `ElementHandles` with N draggable vertex spheres + a closed profile outline polyline. Drag uses `snapPoint()` — snapping to a wall endpoint creates a `wallEndpoint` vertex, otherwise a `free` vertex. Handles rebuild when vertex count changes, reposition otherwise.
- **Extract cascade for reverse deps**: `collectExtract` includes reverse dependents — when a wall is extracted (e.g., during drag), floors referencing it are also extracted (hidden in fragments) so stale floor geometry doesn't show alongside the overlay.

### Multi-Selection
- Shift+click adds/removes walls from selection. Each selected wall has its own handles.
- **Shared corner drag**: At drag start, `detectSharedCorners()` finds other selected walls sharing the dragged endpoint. During drag, `updateSharedCorners()` moves all peers via `doc.update()` + `handles.updateFromContract()`. All updates use the same `transactionGroupId` so they coalesce into one undo step.
- Fragment raycast can't find extracted (hidden) elements — `raycastOverlays()` on FragmentSync provides a fallback that raycasts against overlay meshes.

### Move Tool (1.6)
Two-click workflow: pick base point → pick destination. Moves selected elements and stretches connected neighbors at shared endpoints.

**Architecture:**
- **Stretch targets**: non-selected walls sharing endpoints with selected walls. One endpoint moves, the other stays fixed. Identified at activate time via `findNeighborsAtEndpoint`.
- **Hosted element extraction**: windows/doors on stretch-target walls are extracted + marked as dragging so their overlays update live during the move. Uses `getExtractCascade` filtered to only unhandled dependents.
- **RAF throttling**: `onPointerMove` stores the latest delta; a single `requestAnimationFrame` applies it. Prevents event queue backlog during fast mouse movement. `flushPendingRAF()` on commit ensures the final position is applied synchronously.
- **Batched transactions**: `applyDelta` wraps all N+M updates in one `doc.transaction()` (one commit event instead of N+M).
- **Cascade skip during drag**: `onUpdated` skips `cascadeOnChange` for elements in `draggingIds` — only `refreshDraggingDependents` runs (lightweight: only touches extracted+dragging dependents like hosted windows, no boolean cuts).
- **Batched endDrag**: `endDragAll` processes all elements then runs ONE cascade pass with a shared `cascadingIds` scope, so shared neighbors are processed once (not N+M times). Uses `skipOverlays=true` to avoid orphan overlays for non-extracted elements.
- **`applyTranslation` on registry**: each element type defines how a translation delta applies to its contract. Hosted elements (windows, doors) return `null` — they move implicitly with their host wall.
- **Snap to original positions**: moved/stretched walls are not excluded from snapping. Instead, `SnapOptions.contractOverrides` provides their original (pre-move) contracts so snap sees them at their frozen positions. Only hosted dependents are excluded.

### Extract/Restore Cascade
When a wall is extracted, the following are also extracted:
1. All hosted windows (`hostedElements`)
2. All miter-connected neighbor walls
3. All hosted windows of those neighbors
4. All reverse dependents (e.g., floors referencing this wall via `connectedTo`) — hidden but not recursed into

On restore, the same cascade runs in reverse. Each group must be tracked in `restoreIds` for both geometry writes and `setVisible(true)`.

## Snap System

`snap.ts` provides point snapping with a priority chain: angular constraint (Shift) > endpoint > midpoint > perpendicular > wall body > extension intersection > extension > grid.

**Current capabilities:**
- **Endpoint snap**: finds closest wall start/end within threshold (0.3m default). Linear scan over all contracts.
- **Midpoint snap**: center of each wall segment. Same threshold as endpoint.
- **Perpendicular snap**: when drawing from an anchor, snaps to the point on a wall that forms a perpendicular from the anchor.
- **Wall body snap**: projects point onto wall centerline for T-junctions. Excludes near-endpoint zones.
- **Extension snap**: projects wall axis to infinity, snaps to the nearest point in the extension zone (beyond wall endpoints). Dashed reference line from nearest wall endpoint to snap point. Also generates **perpendicular virtual axes**: when the anchor sits on a wall endpoint or body (e.g., T-junction), a perpendicular extension line is added at 90° to that wall, enabling perpendicular wall placement without angular constraint.
- **Extension intersection**: finds where two wall extension lines cross (including perpendicular virtual axes). Two dashed reference lines shown. Only triggers if at least one wall is in its extension zone.
- **Angular constraint**: Shift key constrains to 15° increments from the anchor point. Applied BEFORE other snaps so the constrained point can still snap to geometry.
- **Grid snap**: rounds to configurable step (0.1m default).
- **Snap indicator**: `SnapIndicator` shows a colored sphere (cyan=endpoint, green=midpoint, orange=wallBody, yellow=extension, magenta=extensionIntersection, blue=perpendicular, red=angular) + dashed reference lines for extension/perpendicular snaps.
- **Exclude IDs**: callers pass `excludeIds` to skip the wall being created/dragged. During shared-corner drag, all selected walls are excluded via `snapExcludeIds` on handles. Dragged walls also excluded from snap candidates.
- **Settings**: `snapSettings` object mutated by `SnapPanel` UI. Grid, endpoint, midpoint, extension, and perpendicular snap independently toggleable.

**Spatial index (2.10):** Endpoint, midpoint, perpendicular, and wall body snaps use `doc.spatialIndex` (RBush R-tree) for O(log n) broadphase. Falls back to linear scan if index is absent (e.g., in tests).

**Sticky snap:** Extension snaps use a "sticky" mechanism — when you snap to a wall (any snap type), that wall's extensions stay available regardless of cursor distance for 3 seconds (`STICKY_TIMEOUT_MS`). This prevents the frustrating UX of losing an extension guide while following it. Sticky state is module-level (`stickySnaps` map), cleared on tool deactivation via `clearStickySnaps()`. `recordStickySnap()` is called by all snap consumers (tools + handles) on each pointer move.

**Snap extensibility (3.4b):** Element types register custom snap points via `getSnapPoints()` on `ElementTypeDefinition`. Returns `{ position: Vector3, type: "endpoint" | "midpoint" | "center" }[]`. The snap system reads `doc.registry` automatically — no caller changes needed when adding new element types. The spatial index computes generic AABBs from snap points for unknown element types (fallback in `genericItem()`), so broadphase queries work out of the box.

**Cross-level snap groups:** `SnapGroupManager` (`snap-groups.ts`) provides a generic grouping concept for cross-level snapping. Levels register as snap groups, each containing their member elements. When snapping, candidates from enabled cross-groups have their Y projected to the current work plane before distance comparison — a wall endpoint at (5, 0, 10) on Level 0 appears at (5, 3, 10) when snapping from Level 1 (Y=3). Projection happens at the candidate-gathering stage (`edgeCandidates`, `extensionCandidates`, `getSnapPoints` loops), so all downstream `distanceTo` calls work without modification. Adjacent levels are auto-enabled by default; the user can toggle individual levels via checkboxes in the Levels panel. Manual toggles persist across level switches (`userTouched` set). The system is level-agnostic — future grouping concepts (Kilometer Points, reference planes) can register their own snap groups via the same `SnapGroupManager` API.

**Open contract system:** `BaseContract` has an index signature (`[key: string]: unknown`) enabling extensibility. New element types extend `BaseContract` with their own fields. `AnyContract = BaseContract` (open type, not a closed union). `BimDocument` holds optional `registry` and `spatialIndex` references set at bootstrap time — these enable snap and spatial queries without threading parameters through every caller.

## Temporary Dimensions

`TempDimensionRenderer` (`ui/temp-dimensions.ts`) shows context-sensitive measurements when elements are selected or being created.

**Current capabilities:**
- **Wall length**: blue dimension line offset from wall axis with witness ticks. Editable — double-click the label, type a value, press Enter to resize.
- **Distance to parallel walls**: perpendicular measurement to nearest parallel wall on each side (max 2). Read-only.
- **Distance from endpoints**: distance from each wall endpoint to nearest perpendicular wall. Read-only.
- **Creation-time dimension**: WallTool shows wall length while drawing (between start point and cursor).
- **Real-time update**: all dimensions refresh during drag via `doc.onUpdated` hook.
- **Rendering**: HTML labels (positioned via 3D→screen projection in a `requestAnimationFrame` loop) + Three.js `Line` objects for dimension lines and witness ticks. Labels have `pointer-events: none` except editable ones.

**Scalability:** Parallel and endpoint distance scans use `doc.spatialIndex` for broadphase (same R-tree as snap). Falls back to linear scan if absent.

**Relevance heuristics:** Currently shows nearest parallel + nearest perpendicular. Revit is smarter — prioritizes structurally related walls (same room, same alignment), shows distances to grids/reference planes, supports Tab cycling between alternatives, and varies dimensions based on what handle is being dragged. This needs iteration.

## Levels

Levels are data-only contracts (`LevelContract` in `elements/level.ts`) with `name` and `elevation`. They follow the same contract pattern as type definitions — no geometry, no fragments, automatic save/load and undo/redo.

**Active level:** `ToolManager` tracks `activeLevelId` and `setActiveLevel(id, elevation)` updates the work plane via `createGroundPlane(elevation)`. The grid helper moves to the active level's elevation.

**Element association:** Tools set `levelId` on created contracts from the active level. This is a tagging field for querying/filtering — geometry uses the actual Y coordinates from the work plane intersection.

**UI:** Levels tab in the side panel lists all levels sorted by elevation. Click to switch active level (updates work plane + grid). Inline editing for name and elevation. Default levels on startup: "Level 0" at 0m, "Level 1" at 3m.

**Level elevation cascade:** When a level's elevation changes, `LevelsTab.cascadeLevelElevation` shifts all elements with `levelId` matching (Y delta applied to start/end, base, or elevation) and recalculates height for elements with `topLevelId` (top constraint). Handled in LevelsTab via explicit transaction — NOT through `cascadeOnChange` — because `doc.update` inside a cascade hook creates re-entrant event storms with symmetric relationships like `connectedTo`.

**Level relationships:** Elements emit `belongsToLevel` and optionally `constrainedToLevel` from `getRelationships`. Both have `onChange: "skip"` — the cascade is driven by LevelsTab, not the dependency graph. The relationships exist for indexing/querying (which elements are on which level).

**Top level constraint:** Wall tool auto-sets `topLevelId` to the next level above when creating walls. Height is derived from `topLevel.elevation - baseLevel.elevation`. Editable per instance via "Top Level" dropdown in the properties panel (can be set to any level or removed). Preview uses the constrained height.

**Remaining:** Per-level visibility filtering.

**Planned:**
- **Dimension extensibility (1.10b)**: element types register dimension providers via the registry.
- **Tab cycling (1.10c)**: Tab to cycle between alternative dimensions at a point.
- **Drag-context dimensions (1.10d)**: different dimensions depending on which handle is being dragged.
- **Constraint integration (3.1)**: typing a dimension value optionally creates a persistent constraint.
- **Grid dimensions (3.3)**: distances to grids/reference planes.

## Patterns from chili3d

Reference: [chili3d](https://github.com/nicehash/chili3d) — browser-based CAD (OpenCascade WASM + Three.js, AGPL-3.0). Studied for architectural patterns applicable to our BIM library.

**License compliance:** chili3d is licensed under AGPL-3.0. We do NOT use, copy, or derive from any chili3d source code. No chili3d code exists in this repository. The patterns described below are generic software engineering patterns (lazy caching, command pattern, decorator metadata) that are not copyrightable and exist across many codebases. All implementations in this project are written from scratch based on our own architecture. This section documents design inspiration only — the same way one might study how Revit or ArchiCAD approaches a problem without copying their implementation.

### S.23 — Lazy geometry cache
**Problem:** Our `overlay.set()` eagerly calls `generateGeometry()` (WASM booleans) on every update. At 200+ overlays this will jank.

**Chili3d pattern:** `ShapeNode` stores `_mesh: IShapeMeshData | undefined`. Property changes set `_mesh = undefined` (invalidate). Next mesh access calls `createMesh()` (lazy regenerate). Mesh lives until next invalidation.

**How to adopt:** Add a `geometryCache: Map<ContractId, BufferGeometry>` to sync or overlay. `overlay.set(contract)` checks cache first; if valid (contract hasn't changed since last gen), reuse. Invalidate on `doc.onUpdated`. During `navigateFragmentHistory` (overlay bridging), only affected elements need regeneration — rest are cache hits.

### S.24 — Generic multi-step command
**Problem:** Each tool (WallTool, FloorTool, WindowTool) reimplements: step sequencing, live preview, cancellation, snap integration, transaction wrapping.

**Chili3d pattern:**
```
MultistepCommand
  ├─ getSteps(): IStep[]           (PointStep, LengthStep, SelectStep...)
  ├─ executeSteps()                (loops with cancellation)
  ├─ executeMainTask()             (wrapped in Transaction.execute)
  └─ repeatOperation               (create multiple without re-entering)
```
Each step shows a live preview via `displayMesh()`. The base class handles the loop, cancellation, and transaction wrapping.

**How to adopt:** Create `MultistepCommand` base in `src/tools/`. Refactor existing tools to declare steps. New element types just define their steps + `executeMainTask`. Snap integration is generic (each step declares what it snaps to).

### S.25 — Decorator-driven property metadata
**Problem:** Adding a new element type requires a custom property panel. Property panels hardcode field names, converters, and layout. No connection between property definition and serialization.

**Chili3d pattern:**
```typescript
@property("common.name", { group: "common", converter: StringConverter })
get name(): string { ... }

PropertyUtils.getProperties(object) → Property[]
// Drives: UI panels, serialization, history recording, command repeat
```

**How to adopt:** Add `@prop(displayKey, { group, converter })` decorator to contract fields. `PropertiesPanel` reads metadata and auto-generates inputs. Same metadata drives serialization and migration (S.7). Single source of truth for what a property is, how to display it, and how to serialize it.

### Gotchas
- `doc.onRemoved` fires BEFORE the contract is deleted from the map, so listeners can still read the contract.
- When extracting a window, always extract the host wall too — otherwise the wall fragment shows the old void underneath the overlay.
- Restoring a hosted element always restores its host wall, recursing into the host's relationships to also restore sibling children (e.g., other windows on the same wall).
- Properties panel uses `input` events (not `change`) for real-time overlay updates during editing.
- **Overlay removal must be delayed** until `onViewUpdated` fires (with 200ms safety fallback) after `setVisible + update` — fragment rendering is async and the GPU needs time to draw. Removing the overlay too early causes a blink. Guard with `isExtracted(id)` (checks vsm state) to prevent removing overlays of re-extracted elements.
- **Re-extract race condition**: When elements are restored and immediately re-extracted (e.g., rapid re-selection), three guards prevent stale fragment flash: (1) `restore` skips `setVisible(true)` for re-extracted IDs, (2) `onFlush` re-hides all extracted elements after `editor.edit()` before `mgr.update()`, (3) `onFlush` skips overlay removal for extracted elements.
- **Batch hide**: `extract()` collects all IDs to hide (including cascade) and enqueues a single `hideElements` call with one `setVisible` + `update`, rather than one per element.
- **When a wall is added/removed**, cascade updates fire so existing neighbors rebuild with/without the miter cut.
- **Hosted windows must be marked dirty** when their host wall moves — window geometry depends on wall position.
- **Cascade overlay preservation**: `onFlush` skips overlay removal for elements that have a newer `pendingOps` entry (`!this.pendingOps.has(c.id)`). This prevents the first flush from killing a miter overlay that cascade set while it was running — the overlay persists until the flush that actually updates that element's fragment.

## Save/Load Persistence

File format: single `.bim` JSON file containing `{ version, contracts, fragmentIds, fragBuffer }` where `fragBuffer` is the fragment model binary encoded as base64.

**Save flow:**
1. `selectTool.clearSelection()` — restore all extracted elements to fragments
2. `finalizePendingGroup()` + `sync.flush()` — finalize any pending drag transactions
3. `editor.save(modelId)` — flatten delta edits into base model (no more delta after this)
4. `model.getBuffer(true)` — get the raw binary (wait ~500ms after save for worker to finish)
5. `doc.toJSON((kind) => registry.getVersion(kind))` — serialize contracts + fragmentIds, stamping each contract with `_v` (schema version)
6. Combine as JSON with base64 frag buffer → download as `.bim`

**Load flow:**
1. `selectTool.clearSelection()` — clean up any active editing state
2. Wait for in-flight async ops, clear undo/redo stacks
3. `sync.reset()` — clear all sync state (overlays, pending ops, timers, extracted IDs)
4. `fragMgr.disposeModel(scene)` — remove old model + delta from scene, dispose
5. `fragMgr.loadModel(buffer, scene, camera)` — load saved buffer with same modelId
6. `doc.loadFromJSON(data, (contracts) => registry.migrateAll(contracts))` — repopulate contracts + fragmentIds, running schema migrations silently (no events)
7. `sync.rebuildDependentsIndex()` — reconstruct reverse dependency index from contracts

### Schema Versioning (S.7)

Each element type can declare a `version` and `migrations` map in its registration:

```ts
registry.register({
  kind: "wall",
  version: 2,
  migrations: {
    1: (c) => ({ ...c, material: "concrete" }), // v1→v2: add default
  },
  // ...
});
```

- **Save**: `doc.toJSON()` stamps each contract with `_v: <currentVersion>`
- **Load**: `registry.migrateAll()` reads `_v` (defaults to 1 if absent), runs chained migrations in sequence (v1→v2→v3→...current), stamps `_v` with the final version
- **Backward compatible**: files saved before versioning have no `_v` field — they're treated as v1
- **Safety**: missing migration in the chain throws immediately on load (fail fast)
- All element types currently at version 1 (no migrations needed yet)

**Key design decisions:**
- `doc.loadFromJSON()` does NOT fire `onAdded`/`onUpdated` events — the fragment model already has the geometry, firing events would trigger duplicate creates
- After load, there's no delta model (save flattened everything into base). The first edit creates a new delta. Visibility operations (hide/show) must work on the base model too.
- Undo/redo stacks are cleared — saved state is the new baseline
- `OverlayManager.clear()` removes all overlay meshes without disposing the shared material (keeps the manager reusable for future edits)

## Patched Bugs in Fragments Library

1. **edit-function.ts**: Shell update for raw models — newly-created representations check `reprsToUpdate` when building shells. Also fixed representation count overlap (`deltaReps` vs `reprsToCreate`).
2. **edit-helper.ts**: Old delta models explicitly removed from `models.list` before dispose.

## Testing

- **Framework**: vitest (`npm test` to run, `npm run test:watch` for watch mode)
- **Sync integration tests**: `src/fragments/__tests__/sync.test.ts` — covers the sync pipeline with mocked FragmentManager/FragmentWriter (no WASM dependency)
- **Coverage**: add/update/remove events, isUndoRedo suppression, extract/restore cascade (hosted children, miter peers, sibling windows), re-extract race condition, cascade on change, delete batching, pending ops coalescing, fragment history tracking, cascade overlay preservation, L-shaped wall scenarios, reverse cascade (floor updates when wall moves/deleted, floor extracted when referenced wall extracted, dependentsOf index restored after undo), drain guard (flush skipped during active drag), document serialization round-trip (toJSON/loadFromJSON), sync reset + rebuildDependentsIndex, base visibility reconciliation on fragment history navigation (undo past loaded state), multi-select restore of connected walls with windows
- **When fixing sync/overlay/cascade bugs**: add a regression test to this file that reproduces the scenario before applying the fix

## Debugging

- **`__bim.sync.debugDump()`** — logs full internal state to the console: vsm entries (element ID → state + dirty), active overlays, pendingOps, dependentsOf index, priorRelationships, fragment history index, edit queue status. Returns the dump object for programmatic inspection. Also shows a summary table with counts.
- **`__bim.sync.assertInvariants()`** — validates internal consistency (10 categories, see `assertInvariants()` in sync.ts). Throws with a list of all violations found. No side effects (except lazy `dependentsOf` rebuild if dirty). Check #5 (dependentsOf) skips relationships to deleted targets. Check #10 (orphan overlays) is skipped when async work is pending (transient state during flush). Auto-assert checkbox in the debug bar runs this after every transaction.
- Uncomment lines 20 and 1474-1478 in `edit-function.ts` to log full delta model data. Rebuild worker after.
- `engine_fragment/packages/fragments/src/FragmentsModels/test.ts` has commented-out API usage examples (visibility, raycast, highlight, bounding boxes, sections, geometry extraction).
