# Getting Started: Add Your Own Element Type

This guide shows how to add a new element type to the modeling library. The column element is the reference — you can copy it and modify.

## What You'll Create

3 files + 4 lines of wiring in `main.ts`:

| File | Purpose |
|------|---------|
| `src/elements/your-element.ts` | Contract (data) + element definition (geometry, relationships, snap points) |
| `src/tools/your-element-tool.ts` | Creation workflow (click/drag to place) |
| `src/handles/your-element-handles.ts` | Drag handles for editing after placement |

**Zero changes to**: `sync.ts`, `select-tool.ts`, `overlay.ts`, `undo-manager.ts`. Selection, undo/redo, save/load, spatial indexing all work automatically.

---

## Step 1: Define the Contract + Element

The contract is the source of truth — just data, no geometry. The element definition tells the system how to turn that data into geometry, relationships, snap points, and handles.

**`src/elements/beam.ts`** (example):

```ts
import * as THREE from "three";
import type { ElementTypeDefinition, ElementRelationship } from "../core/registry";
import type { BaseContract, ContractId, AnyContract } from "../core/contracts";
import type { BimDocument } from "../core/document";
import type { BeamTypeContract } from "./beam-type";
import { rectangleProfile, extrudeProfile } from "../generators/profiles";
import { BeamHandles } from "../handles/beam-handles";

// ── Contract ──────────────────────────────────────────────────────

export interface BeamContract extends BaseContract {
  kind: "beam";
  typeId: ContractId;
  start: [number, number, number];
  end: [number, number, number];
}

export function isBeam(c: BaseContract): c is BeamContract {
  return c.kind === "beam";
}

export function createBeam(
  start: [number, number, number],
  end: [number, number, number],
  typeId: ContractId
): BeamContract {
  return {
    id: crypto.randomUUID(),
    kind: "beam",
    typeId,
    start,
    end,
  };
}

// ── Parameter resolution ──────────────────────────────────────────

export interface ResolvedBeamParams {
  width: number;
  depth: number;
}

export function resolveBeamParams(
  beam: { typeId: ContractId },
  doc: { contracts: ReadonlyMap<ContractId, AnyContract> }
): ResolvedBeamParams {
  const type = doc.contracts.get(beam.typeId) as BeamTypeContract | undefined;
  return {
    width: type?.width ?? 0.2,
    depth: type?.depth ?? 0.4,
  };
}

// ── Element definition ────────────────────────────────────────────

export const beamElement: ElementTypeDefinition = {
  kind: "beam",
  typeKind: "beamType",

  generateGeometry(engine, contract, doc) {
    const b = contract as BeamContract;
    const { width, depth } = resolveBeamParams(b, doc);
    const s = new THREE.Vector3(...b.start);
    const e = new THREE.Vector3(...b.end);
    const dir = new THREE.Vector3().subVectors(e, s);
    const length = dir.length();
    if (length < 0.001) return new THREE.BufferGeometry();
    dir.normalize();

    return extrudeProfile(engine, {
      profile: rectangleProfile(width, depth),
      position: b.start,
      direction: [dir.x, dir.y, dir.z],
      length,
    });
  },

  getRelationships(contract, _doc) {
    const beam = contract as BeamContract;
    const rels: ElementRelationship[] = [];
    if (beam.typeId) {
      rels.push({ type: "instanceOf", targetId: beam.typeId });
    }
    if (beam.levelId) {
      rels.push({ type: "belongsToLevel", targetId: beam.levelId as string });
    }
    return rels;
  },

  getSnapPoints(contract) {
    const b = contract as BeamContract;
    const s = new THREE.Vector3(...b.start);
    const e = new THREE.Vector3(...b.end);
    const mid = s.clone().lerp(e, 0.5);
    return [
      { position: s, type: "endpoint" as const },
      { position: e, type: "endpoint" as const },
      { position: mid, type: "midpoint" as const },
    ];
  },

  createHandles(scene, doc, _engine, contract) {
    return new BeamHandles(scene, doc, contract as BeamContract);
  },
};
```

### Key concepts

- **`BaseContract`**: All contracts extend this. Has `id` (UUID), `kind` (string), and an open index signature for extensibility.
- **`generateGeometry(engine, contract, doc)`**: Pure function → `BufferGeometry`. Use the profile helpers or call `engine` methods directly.
- **`getRelationships(contract, doc)`**: Return `{ type, targetId }[]`. Built-in types: `"hosts"`, `"hostedBy"`, `"connectedTo"`, `"instanceOf"`, `"belongsToLevel"`. Register custom types via `registry.registerRelationshipType()`.
- **`getSnapPoints(contract, doc)`**: Other tools will snap to these points. Types: `"endpoint"`, `"midpoint"`, `"center"`.
- **`createHandles(scene, doc, engine, contract, camera, container)`**: Return an `ElementHandles` implementation or `null`.
- **`typeKind`**: Links instances to their type definition (e.g., `"beamType"`). Drives the toolbar type dropdown.

### Additional hooks (optional)

| Hook | Purpose |
|------|---------|
| `generateLocalGeometry(engine, contract, doc)` | Return local-space geometry + `worldTransform` for instanced elements. Enables representation sharing — all instances of the same type share one geometry in the fragment model. |
| `getRepresentationKey(contract, doc)` | Return a string key for instancing deduplication. Elements with the same key share representations. |
| `getVoidGeometry(engine, contract, doc)` | Return a `THREE.Mesh` that gets subtracted from the host via boolean DIFFERENCE. Used by windows/doors to cut holes in walls. |
| `getLinearEdges(contract, doc)` | Return `LinearEdge[]` for snap and spatial indexing. Walls use this — other tools snap to edge endpoints, midpoints, and extensions. |
| `getSpatialBounds(contract, doc)` | Return explicit AABB `{ min, max }`. Falls back to `getLinearEdges` or `getSnapPoints` if not provided. |
| `getBooleanOperands(engine, contract, doc)` | Return element-specific boolean operands (e.g., wall miters). |

---

## Step 2: Create the Tool

The tool handles the creation workflow — what happens when the user clicks/drags on the canvas.

**`src/tools/beam-tool.ts`** (example — two-click placement):

```ts
import * as THREE from "three";
import type { Tool, ToolManager } from "./tool-manager";
import type { BimDocument } from "../core/document";
import type { ContractId } from "../core/contracts";
import { createBeam } from "../elements/beam";
import { snapPoint, SnapIndicator, recordStickySnap } from "../utils/snap";
import { PREVIEW_MATERIAL } from "../utils/material-resolve";

export class BeamTool implements Tool {
  name = "beam";
  typeKind = "beamType";
  private doc: BimDocument;
  private scene: THREE.Scene;
  private toolMgr: ToolManager;
  private snapIndicator: SnapIndicator;
  private startPoint: THREE.Vector3 | null = null;
  private preview: THREE.Mesh | null = null;

  typeId: ContractId | null = null;
  levelId: ContractId | null = null;

  constructor(doc: BimDocument, scene: THREE.Scene, toolMgr: ToolManager) {
    this.doc = doc;
    this.scene = scene;
    this.toolMgr = toolMgr;
    this.snapIndicator = new SnapIndicator(scene);
  }

  activate() {
    document.body.style.cursor = "crosshair";
  }

  deactivate() {
    document.body.style.cursor = "default";
    this.startPoint = null;
    this.snapIndicator.hide();
    this.clearPreview();
  }

  onPointerDown(event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (event.button !== 0 || !intersection || !this.typeId) return;

    const result = snapPoint(intersection, this.doc, {
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    const pos = result.position;

    if (!this.startPoint) {
      // First click: set start
      this.startPoint = pos.clone();
    } else {
      // Second click: create beam
      const beam = createBeam(
        [this.startPoint.x, this.startPoint.y, this.startPoint.z],
        [pos.x, pos.y, pos.z],
        this.typeId
      );
      if (this.levelId) beam.levelId = this.levelId;
      this.doc.add(beam);
      this.clearPreview();
      this.startPoint = null;
    }
  }

  onPointerMove(_event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (!intersection) {
      this.snapIndicator.hide();
      this.toolMgr.hideCursor();
      return;
    }

    const result = snapPoint(intersection, this.doc, {
      anchor: this.startPoint ?? undefined,
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    recordStickySnap(result);
    this.snapIndicator.update(result);
    this.toolMgr.setCursorPosition(result.position);

    if (this.startPoint) {
      this.updatePreview(this.startPoint, result.position);
    }
  }

  onPointerUp() {}

  onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      this.startPoint = null;
      this.clearPreview();
    }
  }

  private updatePreview(start: THREE.Vector3, end: THREE.Vector3) {
    this.clearPreview();
    const dir = new THREE.Vector3().subVectors(end, start);
    const length = dir.length();
    if (length < 0.001) return;

    const geo = new THREE.BoxGeometry(0.2, 0.4, length);
    this.preview = new THREE.Mesh(geo, PREVIEW_MATERIAL);

    // Position at midpoint, orient along direction
    const mid = start.clone().lerp(end, 0.5);
    this.preview.position.copy(mid);
    this.preview.lookAt(end);
    this.preview.renderOrder = 5;
    this.scene.add(this.preview);
  }

  private clearPreview() {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview.geometry.dispose();
      this.preview = null;
    }
  }
}
```

### Tool interface

Every tool implements:

```ts
interface Tool {
  name: string;
  typeKind?: string;              // which type dropdown to show (e.g. "beamType")
  typeId?: string | null;         // active type ID, set by type selection system
  levelId?: string | null;        // active level ID, set when user switches levels
  activate(): void;               // called when tool becomes active
  deactivate(): void;             // called when switching away
  onPointerDown(event, intersection): void;
  onPointerMove(event, intersection): void;
  onPointerUp(event): void;
  onKeyDown(event): void;
}
```

`intersection` is the cursor position on the work plane (ground by default), or `null` if the ray missed.

### Snapping

```ts
import { snapPoint, SnapIndicator, recordStickySnap } from "../utils/snap";

const result = snapPoint(worldPoint, doc, {
  excludeIds: [myElementId],                        // don't snap to yourself
  anchor: startPoint,                                // for perpendicular + angular snaps
  elevation: toolMgr.workPlane.origin.y,             // work plane Y for cross-level projection
  snapGroupManager: toolMgr.snapGroupManager ?? undefined,  // enables cross-level snapping
});

// result.position        — snapped world position
// result.type            — "endpoint" | "midpoint" | "perpendicular" | "extension" | "grid" | ...
// result.targetId        — which element was snapped to (if any)
// result.sourceElevation — original Y of source element (set for cross-level snaps)

recordStickySnap(result);          // keeps extension snaps alive for 3s
snapIndicator.update(result);      // shows the visual indicator
```

### Cursor dot

Show a cursor dot at the snapped position for visual feedback:

```ts
this.toolMgr.setCursorPosition(result.position);  // show dot
this.toolMgr.hideCursor();                          // hide dot (e.g. when no intersection)
```

### Preview material

Use the shared preview material for translucent placement previews:

```ts
import { PREVIEW_MATERIAL } from "../utils/material-resolve";

this.preview = new THREE.Mesh(geo, PREVIEW_MATERIAL);
```

Don't dispose `PREVIEW_MATERIAL` — it's shared across all tools.

---

## Step 3: Create the Handles

Handles let users edit the element after placement by dragging control points.

**`src/handles/beam-handles.ts`** (example):

```ts
import * as THREE from "three";
import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";
import type { ToolManager } from "../tools/tool-manager";
import { HandleMesh } from "./base";
import { snapPoint, SnapIndicator, recordStickySnap } from "../utils/snap";
import type { BeamContract } from "../elements/beam";
import type { ElementHandles } from "../core/registry";

export class BeamHandles implements ElementHandles {
  contract: BeamContract;
  activeTarget: string | null = null;
  snapExcludeIds: ContractId[] = [];

  private startHandle: HandleMesh;
  private endHandle: HandleMesh;
  private snapIndicator: SnapIndicator;
  private doc: BimDocument;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene, doc: BimDocument, contract: BeamContract) {
    this.scene = scene;
    this.doc = doc;
    this.contract = contract;

    const sphereGeo = new THREE.SphereGeometry(0.12, 12, 12);
    this.startHandle = new HandleMesh(sphereGeo, 0x44ff44, new THREE.Vector3(...contract.start));
    this.endHandle = new HandleMesh(sphereGeo.clone(), 0x44ff44, new THREE.Vector3(...contract.end));
    this.snapIndicator = new SnapIndicator(scene);

    scene.add(this.startHandle.mesh);
    scene.add(this.endHandle.mesh);
  }

  checkHit(event: PointerEvent, toolMgr: ToolManager, _camera: THREE.PerspectiveCamera): boolean {
    const hits = toolMgr.raycastObjects(event, [
      this.startHandle.mesh,
      this.endHandle.mesh,
    ]);
    if (hits.length === 0) return false;

    if (hits[0].object === this.startHandle.mesh) {
      this.activeTarget = "start";
      this.startHandle.mesh.visible = false;
    } else {
      this.activeTarget = "end";
      this.endHandle.mesh.visible = false;
    }
    return true;
  }

  onDrag(groundPoint: THREE.Vector3, _event: PointerEvent) {
    if (!this.activeTarget) return;

    const anchor = this.activeTarget === "start"
      ? new THREE.Vector3(...this.contract.end)
      : new THREE.Vector3(...this.contract.start);

    const result = snapPoint(groundPoint, this.doc, {
      excludeIds: [this.contract.id, ...this.snapExcludeIds],
      anchor,
    });
    recordStickySnap(result);
    this.snapIndicator.update(result);
    const pos = result.position;

    const update: Partial<BeamContract> = {
      [this.activeTarget]: [pos.x, pos.y, pos.z],
    };
    this.contract = { ...this.contract, ...update };
    this.doc.update(this.contract.id, this.contract);

    if (this.activeTarget === "start") {
      this.startHandle.setPosition(pos);
    } else {
      this.endHandle.setPosition(pos);
    }
  }

  onDragEnd() {
    if (!this.activeTarget) return;
    if (this.activeTarget === "start") this.startHandle.mesh.visible = true;
    else this.endHandle.mesh.visible = true;
    this.activeTarget = null;
    this.snapIndicator.hide();
  }

  updateFromContract(contract: AnyContract) {
    this.contract = contract as BeamContract;
    this.startHandle.setPosition(new THREE.Vector3(...this.contract.start));
    this.endHandle.setPosition(new THREE.Vector3(...this.contract.end));
  }

  dispose() {
    this.scene.remove(this.startHandle.mesh);
    this.scene.remove(this.endHandle.mesh);
    this.startHandle.dispose();
    this.endHandle.dispose();
    this.snapIndicator.dispose();
  }
}
```

### ElementHandles interface

```ts
interface ElementHandles {
  contract: AnyContract;
  activeTarget: string | null;
  snapExcludeIds?: ContractId[];

  checkHit(event, toolMgr, camera): boolean;   // return true if a handle was hit
  onDrag(groundPoint, event): void;             // called each frame during drag
  onDragEnd(): void;                            // cleanup after drag
  updateFromContract(contract): void;           // external update (undo, shared corner)
  dispose(): void;                              // remove handles from scene
}
```

**`HandleMesh`** constructor: `new HandleMesh(geometry, color, position)` — creates a visible sphere/shape at the given position. Use `setPosition()` to move it.

---

## Step 4: Wire It Up in main.ts

Add 4 lines (2 imports + 2 registrations):

```ts
// Imports
import { beamElement } from "./elements/beam";
import { BeamTool } from "./tools/beam-tool";

// In the setup function, after other registrations:
registry.register(beamElement);

// After other tools are created:
const beamTool = new BeamTool(doc, scene, toolMgr);

// In the toolbar setup:
{ tool: beamTool, label: "Beam" },
```

That's it. The beam now supports:
- Selection (click to select, shows handles)
- Drag editing (drag start/end handles)
- Undo/redo (full history, including fast undo/redo)
- Save/load (persisted in `.bim` files)
- Snap (other tools snap to beam endpoints and midpoint)
- Spatial indexing (broadphase queries find the beam)
- Delete (select + Delete key)
- Multi-select (Shift+click)

---

## Available Geometry Primitives

### Profile extrusion (`generators/profiles.ts`)

The easiest way to create geometry. Pick a profile, extrude it.

```ts
import { extrudeProfile, rectangleProfile, circleProfile, hProfile } from "../generators/profiles";

// Rectangular column
extrudeProfile(engine, {
  profile: rectangleProfile(0.3, 0.3),
  position: [5, 0, 3],
  direction: [0, 1, 0],
  length: 3.0,
});

// Circular pipe
extrudeProfile(engine, {
  profile: circleProfile(0.15),
  position: [0, 3, 0],
  direction: [1, 0, 0],  // horizontal
  length: 5.0,
});

// H-beam
extrudeProfile(engine, {
  profile: hProfile(0.3, 0.5, 0.02, 0.015),
  position: [0, 3, 0],
  direction: [1, 0, 0],
  length: 6.0,
});

// Custom shape
import { customProfile } from "../generators/profiles";
extrudeProfile(engine, {
  profile: customProfile([[0, 0], [1, 0], [0.5, 1]]),  // triangle
  position: [0, 0, 0],
  direction: [0, 1, 0],
  length: 2.0,
});
```

**Profile generators**: `rectangleProfile(w, d)`, `circleProfile(r, segments?)`, `hProfile(fw, d, ft, wt)`, `tProfile(fw, d, ft, wt)`, `cProfile(w, d, ft, wt)`, `lProfile(w, h, t)`, `customProfile([[x,z], ...])`.

### Engine primitives (lower level)

```ts
// Wall (special case — rectangular profile with elevation)
engine.getWall(geometry, { start, end, height, thickness, offset, elevation, direction });

// Boolean operations
engine.getBooleanOperation(geometry, { type: "DIFFERENCE", target: mesh, operands: [cutMesh] });
engine.getBooleanOperation(geometry, { type: "UNION", target: meshA, operands: [meshB] });

// Raw extrusion (what extrudeProfile wraps)
engine.getExtrusion(geometry, { profilePoints, direction, length, cap, profileHoles });

// Structural profiles (H/C/Z/T/L with fillets)
engine.getProfile(geometry, { type: ProfileType.H, width, depth, thickness, flangeThickness });

// Sweep along curve
engine.getSweep(geometry, { profilePoints, curvePoints, startNormal });

// Revolution
engine.getRevolve(geometry, { profile, transform, startAngle, endAngle });
```

### Plain Three.js (simplest, no WASM)

For previews or simple elements, Three.js geometry works fine:

```ts
new THREE.BoxGeometry(width, height, depth);
new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);
new THREE.SphereGeometry(radius, widthSegments, heightSegments);
```

---

## Type/Instance Pattern

If your element should support shared parameters (like width/depth for all beams of the same design), add a **type contract**. See `src/elements/column-type.ts` for the reference implementation, or the [Door walkthrough](./CREATE_YOUR_OWN_ELEMENT.md) for a full worked example.

Key concepts:
- **Type contract** (`beamType`): shared parameters — width, depth. `dataOnly: true`, no geometry.
- **Instance contract** (`beam`): placement + `typeId` pointing to its type.
- **`resolveBeamParams()`**: guaranteed-present parameters with fallbacks if the type is missing.
- **`materialSlots`**: declare named material slots on the type (e.g., `["body"]`). Users assign materials per slot in the Types panel.
- **`typeParams`**: parameter descriptors that drive the Types panel UI. Categories: `"type-only"` (read-only on instance), `"defaultable"` (type provides default, instance can override), `"instance-only"` (only on instance, not shown on type).

---

## Relationships

If your element depends on other elements, declare relationships:

```ts
getRelationships(contract, doc) {
  const beam = contract as BeamContract;
  const rels: ElementRelationship[] = [];

  // Type relationship (required for type/instance pattern)
  if (beam.typeId) {
    rels.push({ type: "instanceOf", targetId: beam.typeId });
  }

  // Level relationship
  if (beam.levelId) {
    rels.push({ type: "belongsToLevel", targetId: beam.levelId as string });
  }

  // If the beam connects to columns at each end
  if (beam.startColumnId) {
    rels.push({ type: "connectedTo", targetId: beam.startColumnId });
  }

  return rels;
}
```

**Built-in relationship types:**

| Type | Extract | Restore | Delete | Change | Use case |
|------|---------|---------|--------|--------|----------|
| `hosts` | recurse | recurse | cascade | refresh | Parent owns child (wall → window) |
| `hostedBy` | recurse | recurse | skip | refresh | Child lives on parent (window → wall) |
| `connectedTo` | include | include | skip | refresh | Peer link (wall ↔ wall, floor → wall) |
| `instanceOf` | skip | skip | skip | refresh | Instance → type (type change regenerates geometry) |
| `belongsToLevel` | skip | skip | skip | skip | Element → level (for filtering, not cascade) |
| `usesMaterial` | skip | skip | skip | refresh | Type → material (material change regenerates geometry) |

**Custom relationship types:**

```ts
// In main.ts or your element setup:
registry.registerRelationshipType("supports", {
  onExtract: "include",   // select column → extract beam (but don't recurse)
  onRestore: "include",   // deselect → restore beam
  onDelete: "cascade",    // delete column → delete beam
  onChange: "refresh",     // column moves → beam geometry updates
});
```

---

## Quick Reference: Copy the Column

The simplest starting point — copy these 3 files and modify:

1. `src/elements/column.ts` → `src/elements/your-element.ts`
2. `src/tools/column-tool.ts` → `src/tools/your-element-tool.ts`
3. `src/handles/column-handles.ts` → `src/handles/your-element-handles.ts`

Then add 4 lines to `main.ts`. Done.
