# Create Your Own Element: Door Walkthrough

This guide walks you through building a **Door** element from scratch. It's a worked example that goes further than `GETTING_STARTED.md` — it adds a type contract, covers hosted elements, material slots, representation instancing, and wall-hosted placement.

**Read [`GETTING_STARTED.md`](./GETTING_STARTED.md) first.** It explains the core interfaces (`ElementTypeDefinition`, `ElementHandles`, `Tool`) with a Beam example. This guide builds on that — it won't re-explain the basics.

---

## What You'll Build

A door element that:
- Has a **type contract** (`DoorType`) with shared parameters — width, height
- Has an **instance contract** (`Door`) hosted on a wall with a `position` (0–1 along the wall)
- Generates multi-part geometry (frame + panel) with **representation instancing** — all doors of the same type share geometry
- Supports **material slots** — users assign materials to "frame" and "panel" independently
- Cuts a void in the host wall via boolean DIFFERENCE
- Has a drag handle to slide it along the wall after placement

Files you'll create:

| File | What it does |
|------|--------------|
| `src/elements/door-type.ts` | Type contract + type definition |
| `src/elements/door.ts` | Instance contract + element definition |
| `src/tools/door-tool.ts` | Wall-picking placement tool |
| `src/generators/door.ts` | Geometry generation (world-space + local parts) |

4 lines of wiring in `main.ts`. Zero changes anywhere else.

---

## The Type/Instance Pattern

The split:
- **Type contract** (`doorType`): shared parameters across all doors of this design — width, height. Change once, all instances update.
- **Instance contract** (`door`): placement — which wall it's on and where. Has a `typeId` pointing to its type.

The `resolveDoorParams()` pattern gives you guaranteed-present parameters, with sensible fallbacks if the type is stale:

```ts
export function resolveDoorParams(door: DoorContract, doc): ResolvedDoorParams {
  const type = doc.contracts.get(door.typeId) as DoorTypeContract | undefined;
  return {
    width:  door.width  ?? type?.width  ?? 0.9,   // instance override → type default → fallback
    height: door.height ?? type?.height ?? 2.1,
  };
}
```

Never crash on missing data. Always provide fallbacks.

---

## Step 1: Door Type Contract

**`src/elements/door-type.ts`**

```ts
import type { ElementTypeDefinition, ElementRelationship } from "../core/registry";
import type { BaseContract, ContractId } from "../core/contracts";

export interface DoorTypeContract extends BaseContract {
  kind: "doorType";
  name: string;
  width: number;   // defaultable — instances can override
  height: number;  // defaultable — instances can override
  materials?: Record<string, ContractId>;  // slot name → material contract ID
}

export function isDoorType(c: { kind: string }): c is DoorTypeContract {
  return c.kind === "doorType";
}

export function createDoorType(
  options?: Partial<Pick<DoorTypeContract, "name" | "width" | "height">>
): DoorTypeContract {
  return {
    id: crypto.randomUUID(),
    kind: "doorType",
    name: options?.name ?? "Door Type",
    width: options?.width ?? 0.9,
    height: options?.height ?? 2.1,
  };
}

export const doorTypeElement: ElementTypeDefinition = {
  kind: "doorType",
  dataOnly: true,             // no geometry — sync skips fragment operations
  metadataKeys: ["name"],     // renaming doesn't trigger geometry regeneration
  instanceKind: "door",
  typeGroupLabel: "Door Types",
  materialSlots: ["frame", "panel"],  // users assign materials per slot in Types panel
  createDefault: () => createDoorType(),
  typeParams: [
    { key: "width",  label: "Width",  category: "defaultable", inputType: "number", step: 0.1, min: 0.5, max: 3, fallback: 0.9, summaryPrefix: "W" },
    { key: "height", label: "Height", category: "defaultable", inputType: "number", step: 0.1, min: 1.5, max: 5, fallback: 2.1, summaryPrefix: "H" },
  ],

  generateGeometry() {
    throw new Error("doorType has no geometry — it is a data-only type contract");
  },

  getRelationships(contract) {
    const dt = contract as DoorTypeContract;
    const rels: ElementRelationship[] = [];
    // Track material references so material edits cascade to all instances
    if (dt.materials) {
      for (const matId of Object.values(dt.materials)) {
        if (matId) rels.push({ type: "usesMaterial", targetId: matId });
      }
    }
    return rels;
  },
};
```

**What each field does:**

- `dataOnly: true` — sync skips fragment operations for this contract. No 3D representation.
- `metadataKeys: ["name"]` — renaming a door type does NOT cascade geometry regeneration. Only structural parameter changes do.
- `materialSlots: ["frame", "panel"]` — declares named material slots. The Types panel renders dropdowns for each slot, letting users assign materials from the Materials tab.
- `materials?: Record<string, ContractId>` — stores the assigned material contract ID per slot. Populated by the Types panel UI.
- `typeParams` — drives the Types panel UI. `category: "defaultable"` means the type provides a default, but instances can override.
- `summaryPrefix` — builds the inline label shown per type (e.g., "W: 0.90 H: 2.10").
- `instanceKind: "door"` — links this type to its instances so the panel knows which elements to list.
- `createDefault` — called on startup to seed the document with a usable default type.
- `usesMaterial` relationship — ensures material edits cascade to regenerate all instances.

### Parameter categories

| Category | Shown on type? | Shown on instance? | Use case |
|----------|---------------|-------------------|----------|
| `"type-only"` | Editable | Read-only | Height, width for columns (all instances identical) |
| `"defaultable"` | Editable (default) | Editable (override) | Width, height for doors (instance can differ from type) |
| `"instance-only"` | Hidden | Editable | Sill height for windows (varies per placement) |

---

## Step 2: Door Instance Contract

**`src/elements/door.ts`** — start with the contract and factory.

```ts
import * as THREE from "three";
import type { ElementTypeDefinition, ElementRelationship } from "../core/registry";
import type { BaseContract, ContractId, AnyContract } from "../core/contracts";
import type { DoorTypeContract } from "./door-type";
import type { BimDocument } from "../core/document";
import { resolveWallParams } from "./wall";
import type { WallContract, ResolvedWall } from "./wall";
import { generateDoorGeometry, generateDoorPartsLocal, generateDoorVoid } from "../generators/door";
import { resolveMaterial } from "../utils/material-resolve";
import { HostedElementHandles } from "../handles/hosted-handles";

// ── Contract ──────────────────────────────────────────────────────

export interface DoorContract extends BaseContract {
  kind: "door";
  typeId: ContractId;
  hostId: ContractId;     // which wall this door lives on
  position: number;       // 0–1 parameter along the wall centerline
  width?: number;         // instance override (undefined = use type default)
  height?: number;        // instance override (undefined = use type default)
}

export function isDoor(c: { kind: string }): c is DoorContract {
  return c.kind === "door";
}

export function createDoor(
  hostId: ContractId,
  position: number,
  typeId: ContractId,
  options?: Partial<Pick<DoorContract, "width" | "height">>
): DoorContract {
  return {
    id: crypto.randomUUID(),
    kind: "door",
    hostId,
    position: Math.max(0, Math.min(1, position)),
    typeId,
    width: options?.width,
    height: options?.height,
  };
}

// ── Parameter resolution ──────────────────────────────────────────

export interface ResolvedDoorParams {
  width: number;
  height: number;
}

export type ResolvedDoor = DoorContract & ResolvedDoorParams;

export function resolveDoorParams(
  door: DoorContract,
  doc: { contracts: ReadonlyMap<ContractId, AnyContract> }
): ResolvedDoorParams {
  const type = doc.contracts.get(door.typeId) as DoorTypeContract | undefined;
  return {
    width:  door.width  ?? type?.width  ?? 0.9,
    height: door.height ?? type?.height ?? 2.1,
  };
}
```

Key differences from a point-placed element (column):
- `hostId` references the wall this door lives on.
- `position` is a 0–1 parameter along the wall centerline — not a world-space coordinate.
- `width`/`height` are optional instance overrides — `undefined` means "use the type default." This is the `"defaultable"` pattern.

---

## Step 3: Element Definition

Still in `src/elements/door.ts`, below the contract:

```ts
// ── Helpers ───────────────────────────────────────────────────────

function resolveHost(door: DoorContract, doc: BimDocument): ResolvedWall | null {
  const host = doc.contracts.get(door.hostId) as WallContract | undefined;
  if (!host) return null;
  const params = resolveWallParams(host, doc);
  return { ...host, height: params.height, thickness: params.thickness };
}

function resolveDoor(door: DoorContract, doc: BimDocument): ResolvedDoor {
  const params = resolveDoorParams(door, doc);
  return { ...door, width: params.width, height: params.height };
}

// ── Element definition ────────────────────────────────────────────

const DEFAULT_FRAME_MAT = new THREE.MeshLambertMaterial({ color: 0xd6d6d1, side: THREE.DoubleSide });
const DEFAULT_PANEL_MAT = new THREE.MeshLambertMaterial({ color: 0xc8a882, side: THREE.DoubleSide });

export const doorElement: ElementTypeDefinition = {
  kind: "door",
  typeKind: "doorType",

  // World-space geometry (used for overlays and unique-path fallback)
  generateGeometry(_engine, contract, doc) {
    const door = resolveDoor(contract as DoorContract, doc);
    const host = resolveHost(door, doc);
    if (!host) throw new Error(`Door host wall not found: ${door.hostId}`);
    return generateDoorGeometry(door, host);
  },

  // Local-space geometry for representation instancing.
  // All doors of the same type share one geometry in the fragment model.
  generateLocalGeometry(_engine, contract, doc) {
    const door = resolveDoor(contract as DoorContract, doc);
    const host = resolveHost(door, doc);
    if (!host) return null;
    const type = doc.contracts.get(door.typeId) as DoorTypeContract | undefined;
    const { frame, panel, worldTransform, frameDepth } = generateDoorPartsLocal(door, host);
    const frameMatId = type?.materials?.frame;
    const panelMatId = type?.materials?.panel;
    return {
      worldTransform,
      parts: [
        {
          geometry: frame,
          geoHash: `door-frame:${door.width}:${door.height}:${frameDepth}|${frameMatId ?? ""}`,
          material: resolveMaterial(frameMatId, doc, DEFAULT_FRAME_MAT),
        },
        {
          geometry: panel,
          geoHash: `door-panel:${door.width}:${door.height}|${panelMatId ?? ""}`,
          material: resolveMaterial(panelMatId, doc, DEFAULT_PANEL_MAT),
        },
      ],
    };
  },

  // Boolean void — shape subtracted from the host wall
  getVoidGeometry(_engine, contract, doc) {
    const door = resolveDoor(contract as DoorContract, doc);
    const host = resolveHost(door, doc);
    if (!host) return null;
    return generateDoorVoid(door, host);
  },

  getRelationships(contract, _doc) {
    const door = contract as DoorContract;
    const rels: ElementRelationship[] = [
      { type: "hostedBy", targetId: door.hostId },
    ];
    if (door.typeId) {
      rels.push({ type: "instanceOf", targetId: door.typeId });
    }
    return rels;
  },

  createHandles(scene, doc, _engine, contract, camera, container) {
    const door = contract as DoorContract;
    const params = resolveDoorParams(door, doc);
    const yOffset = params.height / 2;
    return new HostedElementHandles(scene, doc, contract, yOffset, camera, container);
  },

  getSpatialBounds(contract, doc) {
    const door = contract as DoorContract;
    const resolved = resolveDoorParams(door, doc);
    const host = doc.contracts.get(door.hostId) as WallContract | undefined;
    if (!host) return null;
    const sx = host.start[0], sz = host.start[2];
    const ex = host.end[0], ez = host.end[2];
    const cx = sx + (ex - sx) * door.position;
    const cz = sz + (ez - sz) * door.position;
    const hw = resolved.width / 2;
    return {
      min: [cx - hw, host.start[1], cz - hw] as [number, number, number],
      max: [cx + hw, host.start[1] + resolved.height, cz + hw] as [number, number, number],
    };
  },
};
```

### Key patterns

**Two geometry methods:**
- `generateGeometry()` — world-space geometry used for overlays and the "unique path" fallback.
- `generateLocalGeometry()` — local-space geometry at origin + a `worldTransform`. Enables **representation instancing**: all doors of the same type share one geometry in the fragment model. Returns multiple `parts`, each with a `geoHash` for deduplication and a `material`.

**Material resolution:**
```ts
resolveMaterial(type?.materials?.frame, doc, DEFAULT_FRAME_MAT)
```
Looks up the material contract ID from the type's `materials` map, resolves it to a Three.js material, or falls back to the default.

**geoHash:** A string key for representation deduplication. Include all parameters that affect the geometry shape + the material ID. Doors on walls of different thickness get different frame `geoHash` values (different `frameDepth`), so their frame reprs aren't shared — but the panel repr IS shared.

**`hostedBy` relationship:** This means:
- When the host wall is deleted → the door is cascade-deleted.
- When the wall moves → the door geometry regenerates.
- When the door is extracted (selected) → the host wall is included.

**`HostedElementHandles`:** A shared handle class for any wall-hosted element (windows, doors). Shows a handle at the element center; dragging slides it along the host wall using fragment raycasting for accurate positioning.

---

## Step 4: The Tool

**`src/tools/door-tool.ts`**

Wall-picking placement — the tool raycasts the fragment model to find walls, then places the door at the cursor position along the wall.

```ts
import * as THREE from "three";
import type { GeometryEngine } from "@thatopen/fragments";
import type { Tool, ToolManager } from "./tool-manager";
import type { BimDocument } from "../core/document";
import type { FragmentManager } from "../fragments/manager";
import type { ContractId } from "../core/contracts";
import { isWall, resolveWallParams } from "../elements/wall";
import type { WallContract, ResolvedWall } from "../elements/wall";
import { createDoor, resolveDoorParams } from "../elements/door";
import type { ResolvedDoor } from "../elements/door";
import type { DoorTypeContract } from "../elements/door-type";
import { generateDoorGeometry } from "../generators/door";
import { PREVIEW_MATERIAL } from "../utils/material-resolve";

export class DoorTool implements Tool {
  name = "door";
  typeKind = "doorType";

  private scene: THREE.Scene;
  private doc: BimDocument;
  private engine: GeometryEngine;
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private mgr: FragmentManager;
  private toolMgr: ToolManager;

  private previewMesh: THREE.Mesh | null = null;
  private hoveredWall: WallContract | null = null;
  private hoveredPosition = 0;

  typeId: ContractId | null = null;

  constructor(
    scene: THREE.Scene,
    doc: BimDocument,
    engine: GeometryEngine,
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    mgr: FragmentManager,
    toolMgr: ToolManager
  ) {
    this.scene = scene;
    this.doc = doc;
    this.engine = engine;
    this.camera = camera;
    this.canvas = canvas;
    this.mgr = mgr;
    this.toolMgr = toolMgr;
  }

  activate() { document.body.style.cursor = "crosshair"; }

  deactivate() {
    document.body.style.cursor = "default";
    this.clearPreview();
    this.hoveredWall = null;
  }

  async onPointerDown(event: PointerEvent, _intersection: THREE.Vector3 | null) {
    if (event.button !== 0 || !this.hoveredWall || !this.typeId) return;
    const door = createDoor(this.hoveredWall.id, this.hoveredPosition, this.typeId);
    this.doc.add(door);
    this.clearPreview();
  }

  async onPointerMove(event: PointerEvent, _intersection: THREE.Vector3 | null) {
    this.toolMgr.hideCursor();  // no ground cursor for wall-hosted tools
    const hit = await this.pickWall(event);
    if (!hit) {
      this.hoveredWall = null;
      this.clearPreview();
      return;
    }
    this.hoveredWall = hit.wall;
    this.hoveredPosition = hit.position;
    this.updatePreview(hit.wall, hit.position);
  }

  onPointerUp(_event: PointerEvent) {}

  onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      this.clearPreview();
      this.hoveredWall = null;
    }
  }

  /** Raycast fragment model to find a wall under the cursor. */
  private async pickWall(
    event: PointerEvent
  ): Promise<{ wall: WallContract; position: number; point: THREE.Vector3 } | null> {
    const mouse = new THREE.Vector2(event.clientX, event.clientY);
    const data = { camera: this.camera, mouse, dom: this.canvas };

    let best: { localId: number; distance: number; point: THREE.Vector3 } | null = null;
    for (const [, model] of this.mgr.fragments.models.list) {
      const result = await model.raycast(data);
      if (result && (!best || result.distance < best.distance)) {
        best = { localId: result.localId, distance: result.distance, point: result.point };
      }
    }

    if (!best) return null;
    const contract = this.doc.getContractByFragmentId(best.localId);
    if (!contract || !isWall(contract)) return null;

    const wall = contract;
    const s = new THREE.Vector3(...wall.start);
    const e = new THREE.Vector3(...wall.end);
    const wallDir = new THREE.Vector3().subVectors(e, s);
    const wallLen = wallDir.length();
    wallDir.normalize();

    const hitToStart = new THREE.Vector3().subVectors(best.point, s);
    const t = hitToStart.dot(wallDir) / wallLen;
    const position = Math.max(0.05, Math.min(0.95, t));

    return { wall, position, point: best.point };
  }

  private updatePreview(wall: WallContract, position: number) {
    const typeContract = this.typeId
      ? (this.doc.contracts.get(this.typeId) as DoorTypeContract | undefined)
      : undefined;
    const width = typeContract?.width ?? 0.9;
    const height = typeContract?.height ?? 2.1;

    const tempDoor = createDoor(wall.id, position, this.typeId ?? "preview", {
      width, height,
    }) as ResolvedDoor;

    const wallParams = resolveWallParams(wall, this.doc);
    const resolvedWall: ResolvedWall = { ...wall, height: wallParams.height, thickness: wallParams.thickness };

    const geo = generateDoorGeometry(tempDoor, resolvedWall);
    if (!this.previewMesh) {
      this.previewMesh = new THREE.Mesh(geo, PREVIEW_MATERIAL);
      this.previewMesh.renderOrder = 2;
      this.scene.add(this.previewMesh);
    } else {
      this.previewMesh.geometry.dispose();
      this.previewMesh.geometry = geo;
    }
  }

  private clearPreview() {
    if (this.previewMesh) {
      this.scene.remove(this.previewMesh);
      this.previewMesh.geometry.dispose();
      this.previewMesh = null;
    }
  }
}
```

### Wall-hosted tool differences from point-placed tools

| Aspect | Point-placed (column) | Wall-hosted (door) |
|--------|----------------------|-------------------|
| Input | Ground plane intersection | Fragment model raycast (`pickWall`) |
| Position | World-space `[x, y, z]` | Normalized `position` (0–1) along wall |
| Dependencies | `doc`, `scene`, `toolMgr` | Also needs `engine`, `camera`, `canvas`, `FragmentManager` |
| Snap | Uses `snapPoint()` + snap indicator | No snap — position derived from wall hit point |
| Cursor dot | `toolMgr.setCursorPosition()` | `toolMgr.hideCursor()` — the preview mesh IS the indicator |

---

## Step 5: Wire It Up

In `src/main.ts`:

```ts
// Imports
import { doorElement } from "./elements/door";
import { doorTypeElement, createDoorType } from "./elements/door-type";
import { DoorTool } from "./tools/door-tool";

// Register types — after other registrations:
registry.register(doorTypeElement);
registry.register(doorElement);

// Seed a default type:
const defaultDoorType = createDoorType({ name: "Standard Door" });
doc.add(defaultDoorType);

// Create the tool (wall-hosted tools need more dependencies):
const doorTool = new DoorTool(scene, doc, engine, camera, renderer.domElement, fragMgr, toolMgr);
doorTool.typeId = defaultDoorType.id;

// In the toolbar setup:
{ tool: doorTool, label: "Door" },
```

---

## What You Get For Free

| Feature | How it's wired |
|---------|----------------|
| **Selection** | `select-tool.ts` dispatches to the registry generically |
| **Drag handle** | `HostedElementHandles` slides the door along the wall via fragment raycasting |
| **Undo / Redo** | Every `doc.add()` / `doc.update()` is a mutation record |
| **Save / Load** | Contracts serialized in `.bim` files, geometry regenerated on load |
| **Boolean void** | `getVoidGeometry()` cuts the host wall automatically via the boolean pipeline |
| **Representation instancing** | `generateLocalGeometry()` shares geometry across all doors of the same type |
| **Materials** | `materialSlots` on the type + `resolveMaterial()` in local geometry |
| **Type cascade** | Edit type width → all instances regenerate |
| **Material cascade** | Change a material → all types using it → all their instances regenerate |
| **Spatial indexing** | `getSpatialBounds()` returns an AABB for broadphase queries |
| **Delete + cascade** | Delete door → void removed from wall. Delete wall → door cascade-deleted. |
| **Multi-select** | Shift+click — handled generically |
| **Cross-level snapping** | Snap groups project candidates to the current work plane |

---

## Going Further

### Make the geometry more realistic

**Swing direction:** Add `swingDirection: "left" | "right"` as an `"instance-only"` parameter. Generate the panel rotation based on it.

**Custom cross-section:** Use `customProfile([[x, z], ...])` to define any 2D shape — an arched doorway, a paneled door with a raised center.

```ts
import { customProfile, extrudeProfile } from "../generators/profiles";

extrudeProfile(engine, {
  profile: customProfile([[0,0],[0.9,0],[0.9,2.1],[0.45,2.4],[0,2.1]]), // arched top
  position: [0, 0, 0],
  direction: [0, 0, 1],
  length: thickness,
});
```

### Schema migrations

If you add a field to `DoorContract` later, use the migration system so old `.bim` files still load:

```ts
export const doorElement: ElementTypeDefinition = {
  kind: "door",
  version: 2,
  migrations: {
    2: (old) => ({ ...old, swingDirection: "left" }),  // v1 → v2
  },
  // ...
};
```

Contracts saved at v1 (without `swingDirection`) are upgraded on load. No manual data migration needed.

---

## Quick Reference

The column (`src/elements/column.ts`) is the simplest reference for a point-placed element with a type. The window (`src/elements/window.ts`) is the reference for a wall-hosted element with material slots and representation instancing. Door follows the same wall-hosted pattern as window.

```
Point-placed:    column.ts, column-type.ts, column-tool.ts, column-handles.ts
Wall-hosted:     door.ts, door-type.ts, door-tool.ts, hosted-handles.ts
                 window.ts, window-type.ts, window-tool.ts, hosted-handles.ts
```
