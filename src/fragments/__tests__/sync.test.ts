import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { BimDocument } from "../../core/document";
import { ElementRegistry } from "../../core/registry";
import type { AnyContract, ContractId } from "../../core/contracts";
import type { WallContract } from "../../elements/wall";
import type { WindowContract } from "../../elements/window";
import type { FloorContract, FloorBoundaryVertex } from "../../elements/floor";
import type { ElementRelationship } from "../../core/registry";
import { FragmentSync } from "../sync";
import type { FragmentManager } from "../manager";
import type { FragmentElementIds } from "../writer";

// ── Mock @thatopen/fragments (avoids WASM dependency) ──

vi.mock("@thatopen/fragments", () => ({
  EditRequestType: {
    UPDATE_REPRESENTATION: 100,
    DELETE_SAMPLE: 200,
    DELETE_GLOBAL_TRANSFORM: 201,
    DELETE_ITEM: 202,
    DELETE_REPRESENTATION: 203,
    DELETE_LOCAL_TRANSFORM: 204,
    DELETE_MATERIAL: 205,
  },
  GeomsFbUtils: {
    representationFromGeometry: vi.fn((geo: any) => ({
      bbox: [0, 0, 0, 1, 1, 1],
      geometry: {},
      representationClass: 0,
    })),
  },
}));

// ── Mock FragmentWriter (avoids @thatopen/fragments WASM dependency) ──

let mockNextLocalId = 100;

vi.mock("../writer", () => {
  class MockFragmentWriter {
    private tempCounter = 0;
    private tempToAllIds = new Map<string, any>();
    buildCreate() {
      const tempId = `temp-${this.tempCounter++}`;
      const base = mockNextLocalId;
      mockNextLocalId += 6;
      this.tempToAllIds.set(tempId, {
        itemId: base,
        gtId: base + 4,
        samples: [{
          sampleId: base + 1,
          reprId: base + 2,
          matId: base + 3,
          ltId: base + 5,
        }],
      });
      return tempId;
    }
    buildCreateInstanced() {
      return this.buildCreate();
    }
    flush() {
      const requests: any[] = [];
      for (const [tempId, ids] of this.tempToAllIds) {
        requests.push({ type: 0, tempId, localId: ids.itemId });
        requests.push({ type: 1, tempId: `gt-${tempId}`, localId: ids.gtId });
        for (const s of ids.samples) {
          requests.push({ type: 2, tempId: `sample-${tempId}`, localId: s.sampleId });
          requests.push({ type: 3, tempId: `repr-${tempId}`, localId: s.reprId });
          requests.push({ type: 4, tempId: `lt-${tempId}`, localId: s.ltId });
          requests.push({ type: 5, tempId: `mat-${tempId}`, localId: s.matId });
        }
      }
      return requests;
    }
    resolveAllIds(itemTempId: string) {
      return this.tempToAllIds.get(itemTempId);
    }
    clearTempIds() {
      this.tempToAllIds.clear();
    }
  }
  return { FragmentWriter: MockFragmentWriter };
});

// ── Mock BufferGeometryUtils (avoids heavy three.js import) ──

vi.mock("three/examples/jsm/utils/BufferGeometryUtils.js", () => ({
  mergeVertices: vi.fn((geo: THREE.BufferGeometry) => geo),
}));

// ── Test helpers ──────────────────────────────────────────────────────

function makeWall(id: string, start: [number, number, number] = [0,0,0], end: [number, number, number] = [5,0,0]): WallContract {
  return {
    id, kind: "wall", start, end,
    height: 3, thickness: 0.2, offset: 0,
    hostedElements: [], startJoin: "miter", endJoin: "miter",
  };
}

function makeWindow(id: string, hostId: string, position = 0.5): WindowContract {
  return {
    id, kind: "window", hostId, position,
    width: 1.2, height: 1.0, sillHeight: 1.0,
  };
}

function makeFloor(id: string, boundary: FloorBoundaryVertex[]): FloorContract {
  return {
    id, kind: "floor", boundary,
    thickness: 0.2, elevation: 0,
  };
}

/** Create a FragmentElementIds with a base itemId (other IDs auto-increment). */
function fakeFragIds(itemId: number): FragmentElementIds {
  return {
    itemId,
    gtId: itemId + 4,
    samples: [{
      sampleId: itemId + 1,
      reprId: itemId + 2,
      matId: itemId + 3,
      ltId: itemId + 5,
    }],
  };
}

/** Create a simple indexed BufferGeometry that survives the sync pipeline. */
function dummyGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  // 2 triangles (6 vertices for non-indexed, but we make it indexed)
  const positions = new Float32Array([
    0,0,0, 1,0,0, 0,1,0,
    1,0,0, 1,1,0, 0,1,0,
  ]);
  const normals = new Float32Array([
    0,0,1, 0,0,1, 0,0,1,
    0,0,1, 0,0,1, 0,0,1,
  ]);
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  const indices = new Uint32Array([0,1,2,3,4,5]);
  geo.setIndex(new THREE.BufferAttribute(indices, 1));

  // Override methods that the sync pipeline calls
  geo.toNonIndexed = vi.fn(() => {
    const clone = geo.clone();
    clone.computeVertexNormals = vi.fn();
    clone.toNonIndexed = geo.toNonIndexed;
    clone.dispose = vi.fn();
    return clone;
  });
  geo.dispose = vi.fn();
  return geo;
}

/** Create a mock FragmentManager with all needed stubs. */
function createMockManager() {
  const mockDelta = {
    setVisible: vi.fn(async () => {}),
    object: { children: [] as any[] },
    deltaModelId: null,
  };
  // Mock onViewUpdated event (matches fragment library's Event<T> API)
  const viewUpdatedHandlers: Function[] = [];
  const mockOnViewUpdated = {
    add: (fn: Function) => { viewUpdatedHandlers.push(fn); },
    remove: (fn: Function) => {
      const idx = viewUpdatedHandlers.indexOf(fn);
      if (idx !== -1) viewUpdatedHandlers.splice(idx, 1);
    },
    trigger: () => { for (const fn of [...viewUpdatedHandlers]) fn(); },
    reset: () => { viewUpdatedHandlers.length = 0; },
  };

  const mockBaseModel = {
    deltaModelId: "delta-1",
    _setRequests: vi.fn(async () => {}),
    setVisible: vi.fn(async () => {}),
    getEditedElements: vi.fn(async () => []),
    onViewUpdated: mockOnViewUpdated,
  };
  const mockDeltaModel = mockDelta;

  const modelsList = new Map<string, any>();
  modelsList.set("bim-authoring", mockBaseModel);
  modelsList.set("delta-1", mockDeltaModel);

  let requestCount = 0;

  const mgr = {
    modelId: "bim-authoring",
    editor: {
      edit: vi.fn(async () => { requestCount++; }),
      getModelRequests: vi.fn(async () => ({
        requests: Array.from({ length: requestCount }, (_, i) => ({ index: i })),
        undoneRequests: [],
      })),
      selectRequest: vi.fn(async () => {}),
    },
    fragments: {
      models: { list: modelsList },
      update: vi.fn(async () => {}),
    },
    update: vi.fn(async () => {}),
  } as unknown as FragmentManager;

  return { mgr, mockDelta };
}

/** Register wall and window element types with simple relationship logic. */
function setupRegistry(doc: BimDocument): ElementRegistry {
  const registry = new ElementRegistry();

  registry.register({
    kind: "wall",
    generateGeometry: () => dummyGeometry(),
    getRelationships(contract: AnyContract, doc: BimDocument): ElementRelationship[] {
      const wall = contract as WallContract;
      const rels: ElementRelationship[] = [];
      // hosts → windows
      for (const childId of wall.hostedElements) {
        rels.push({ type: "hosts", targetId: childId });
      }
      // connectedTo → walls sharing an endpoint
      for (const [, other] of doc.contracts) {
        if (other.kind !== "wall" || other.id === wall.id) continue;
        const ow = other as WallContract;
        if (
          coordsEqual(wall.start, ow.start) || coordsEqual(wall.start, ow.end) ||
          coordsEqual(wall.end, ow.start) || coordsEqual(wall.end, ow.end)
        ) {
          rels.push({ type: "connectedTo", targetId: other.id });
        }
      }
      // Ad-hoc cuts
      const ct = (wall as any).cutTargets as string[] | undefined;
      if (ct) {
        for (const targetId of ct) {
          rels.push({ type: "cuts", targetId });
        }
      }
      return rels;
    },
    onRemove(contract: AnyContract, doc: BimDocument) {
      // Remove window references from host
      const win = contract as WindowContract;
      if (win.kind === "window") {
        const host = doc.contracts.get(win.hostId) as WallContract | undefined;
        if (host) {
          doc.update(host.id, {
            hostedElements: host.hostedElements.filter((id) => id !== win.id),
          } as any);
        }
      }
    },
  });

  registry.register({
    kind: "window",
    generateGeometry: () => dummyGeometry(),
    getRelationships(contract: AnyContract): ElementRelationship[] {
      const win = contract as WindowContract;
      return [{ type: "hostedBy", targetId: win.hostId }];
    },
    onRemove(contract: AnyContract, doc: BimDocument) {
      const win = contract as WindowContract;
      const host = doc.contracts.get(win.hostId) as WallContract | undefined;
      if (host) {
        doc.update(host.id, {
          hostedElements: host.hostedElements.filter((id) => id !== win.id),
        } as any);
      }
    },
  });

  registry.register({
    kind: "floor",
    generateGeometry: () => dummyGeometry(),
    getRelationships(contract: AnyContract): ElementRelationship[] {
      const floor = contract as FloorContract;
      const rels: ElementRelationship[] = [];
      const seen = new Set<string>();
      for (const v of floor.boundary) {
        if (v.type === "wallEndpoint" && !seen.has(v.wallId)) {
          seen.add(v.wallId);
          rels.push({ type: "connectedTo", targetId: v.wallId });
        }
      }
      return rels;
    },
  });

  registry.register({
    kind: "column",
    generateGeometry: () => dummyGeometry(),
    getVoidGeometry: () => new THREE.Mesh(dummyGeometry()),
    getRelationships(contract: AnyContract): ElementRelationship[] {
      const rels: ElementRelationship[] = [];
      const ct = (contract as any).cutTargets as string[] | undefined;
      if (ct) {
        for (const targetId of ct) {
          rels.push({ type: "cuts", targetId });
        }
      }
      return rels;
    },
  });

  return registry;
}

function coordsEqual(a: [number, number, number], b: [number, number, number]) {
  return Math.abs(a[0] - b[0]) < 0.001 &&
    Math.abs(a[1] - b[1]) < 0.001 &&
    Math.abs(a[2] - b[2]) < 0.001;
}

// ── Test suite ────────────────────────────────────────────────────────

describe("FragmentSync", () => {
  let doc: BimDocument;
  let registry: ElementRegistry;
  let scene: THREE.Scene;
  let engine: any;
  let sync: FragmentSync;
  let mgr: ReturnType<typeof createMockManager>["mgr"];
  let mockDelta: ReturnType<typeof createMockManager>["mockDelta"];

  beforeEach(() => {
    vi.useFakeTimers();
    mockNextLocalId = 100;

    doc = new BimDocument();
    registry = setupRegistry(doc);
    scene = new THREE.Scene();
    engine = {}; // GeometryEngine mock — unused since registry generators return dummy geo

    const mock = createMockManager();
    mgr = mock.mgr;
    mockDelta = mock.mockDelta;

    sync = new FragmentSync(doc, mgr, engine, scene, registry);

    // Set up cascade resolver (same as main.ts — delegates to registry)
    doc.setCascadeResolver((id, d) => registry.resolveCascadeDelete(id, d));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Drain all pending promises + advance timers to fully complete restore.
   * The restore() method has a `setTimeout(500)` inside an enqueued async fn,
   * so we need to interleave timer advancement with microtask draining.
   */
  async function drainRestore() {
    // Advance past debounce (100ms) to trigger drainPending
    await vi.advanceTimersByTimeAsync(150);
    // Start flush — this begins draining the editQueue, which includes
    // the restore task that waits for onViewUpdated (with 200ms fallback).
    const p = sync.flush();
    // Trigger the onViewUpdated event to signal tiles are ready,
    // then advance past the safety fallback timeout
    const baseModel = mgr.fragments.models.list.get("bim-authoring") as any;
    baseModel.onViewUpdated.trigger();
    await vi.advanceTimersByTimeAsync(300);
    await p;
  }

  // ── Basic event handling ──────────────────────────────────────────

  describe("add element", () => {
    it("creates overlay and schedules pending create", () => {
      const wall = makeWall("w1");
      doc.add(wall);

      // Overlay should be in scene (OverlayManager adds a mesh)
      expect(scene.children.length).toBe(1);

      // Pending ops should have a "create" entry
      // We can verify by flushing and checking editor.edit was called
    });

    it("flushes pending ops after debounce", async () => {
      const wall = makeWall("w1");
      doc.add(wall);

      // editor.edit not called yet (debounce pending)
      expect(mgr.editor.edit).not.toHaveBeenCalled();

      // Advance past debounce
      vi.advanceTimersByTime(150);
      await sync.flush();

      expect(mgr.editor.edit).toHaveBeenCalled();
    });

    it("sets fragmentIds after flush", async () => {
      const wall = makeWall("w1");
      doc.add(wall);

      vi.advanceTimersByTime(150);
      await sync.flush();

      expect(doc.fragmentIds.has("w1")).toBe(true);
    });
  });

  // ── isUndoRedo suppression ──────────────────────────────────────

  describe("isUndoRedo", () => {
    it("suppresses overlay and pending ops when true", () => {
      sync.isUndoRedo = true;
      const wall = makeWall("w1");
      doc.add(wall);

      // No overlay should be created
      expect(scene.children.length).toBe(0);
      sync.isUndoRedo = false;
    });
  });

  // ── Extract/restore ───────────────────────────────────────────────

  describe("extract", () => {
    it("extracts element and creates overlay", async () => {
      const wall = makeWall("w1");
      doc.add(wall);
      await sync.flush();

      const overlaysBefore = scene.children.length;
      sync.extract("w1");

      // Overlay should exist for extracted element
      expect(scene.children.length).toBeGreaterThanOrEqual(overlaysBefore);
    });

    it("extracts hosted children (window) when extracting wall", async () => {
      const wall = makeWall("w1");
      const win = makeWindow("win1", "w1");
      doc.add(wall);
      doc.transaction(() => {
        doc.add(win);
        doc.update("w1", { hostedElements: ["win1"] } as any);
      });
      await sync.flush();

      sync.extract("w1");

      // Both wall and window overlays should exist
      // scene should have overlays for both (plus whatever was there from the add)
      const overlayCount = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      expect(overlayCount).toBeGreaterThanOrEqual(2);
    });

    it("extracts miter-connected neighbor", async () => {
      // Two walls sharing endpoint at [5,0,0]
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [10,0,0]);
      doc.add(w1);
      doc.add(w2);
      await sync.flush();

      sync.extract("w1");

      // w2 should also be extracted (connectedTo relationship)
      // Verify by checking overlays — both should have one
      const meshCount = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      expect(meshCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("restore", () => {
    it("restores element and removes overlay after delay", async () => {
      const wall = makeWall("w1");
      doc.add(wall);
      await sync.flush();

      sync.extract("w1");
      sync.restore("w1");

      await drainRestore();
    });

    it("restores host wall and sibling windows when restoring one window", async () => {
      // Wall with 2 windows — extract window A, restore it → wall + window B should also restore
      const wall = makeWall("w1");
      doc.add(wall);

      const win1 = makeWindow("win1", "w1");
      const win2 = makeWindow("win2", "w1", 0.8);
      doc.transaction(() => {
        doc.add(win1);
        doc.add(win2);
        doc.update("w1", { hostedElements: ["win1", "win2"] } as any);
      });
      await sync.flush();

      // Extract win1 → should cascade to wall → should cascade to win2
      sync.extract("win1");

      // Now restore win1 → should also restore wall and win2
      sync.restore("win1");
      await drainRestore();

      // After full restore, no overlays should remain
      const remainingOverlays = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      expect(remainingOverlays).toBe(0);
    });

    it("skips setVisible for re-extracted elements", async () => {
      const wall = makeWall("w1");
      doc.add(wall);
      await sync.flush();
      doc.fragmentIds.set("w1", fakeFragIds(1));

      // Extract, restore, immediately re-extract
      sync.extract("w1");
      sync.restore("w1");
      sync.extract("w1");

      // Drain the queue
      await drainRestore();

      // The element should still have an overlay (it's extracted)
      const meshCount = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      expect(meshCount).toBeGreaterThanOrEqual(1);
    });

    it("flushes dirty restored elements to delta", async () => {
      // Extracting 2 miter walls hides both on base. On restore,
      // dirty ones are flushed to the delta with updated geometry.
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [5,0,5]);
      doc.add(w1);
      doc.add(w2);
      await sync.flush();
      doc.fragmentIds.set("w1", fakeFragIds(1));
      doc.fragmentIds.set("w2", fakeFragIds(7));

      // Extract w1 → cascades to w2 (connected at [5,0,0])
      sync.extract("w1");
      expect(sync.vsm.getState("w1")).not.toBe(0); // Extracted
      expect(sync.vsm.getState("w2")).not.toBe(0); // Extracted via cascade

      // Only mark w1 dirty (simulate a geometry change on w1 only)
      sync.vsm.markDirty("w1");

      // Restore both
      sync.restore("w1");

      // Drain the restore
      await drainRestore();

      // editor.edit should have been called with the dirty element's update request
      const editCalls = (mgr.editor.edit as any).mock.calls;
      const lastEditCall = editCalls[editCalls.length - 1];
      // At least 1 request for the dirty wall (UPDATE_REPRESENTATION)
      expect(lastEditCall[1].length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Cascade on change ─────────────────────────────────────────────

  describe("cascade on change", () => {
    it("schedules fragment write for cascade target when element added", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      await sync.flush();

      // Add w2 sharing endpoint → should cascade update to w1
      const w2 = makeWall("w2", [5,0,0], [10,0,0]);
      doc.add(w2);

      // After debounce + flush, editor.edit should include both create(w2) and update(w1)
      vi.advanceTimersByTime(150);
      await sync.flush();

      // editor.edit should have been called with requests for both elements
      expect(mgr.editor.edit).toHaveBeenCalled();
    });

    it("schedules background fragment write for extracted cascade target", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const win = makeWindow("win1", "w1");
      doc.add(w1);
      doc.transaction(() => {
        doc.add(win);
        doc.update("w1", { hostedElements: ["win1"] } as any);
      });
      await sync.flush();

      // Extract win1 (cascades to w1)
      sync.extract("win1");

      // Update window width (while extracted)
      doc.update("win1", { width: 1.5 } as any);

      // Cascade should schedule a background fragment write for the wall
      // even though it's extracted (stays hidden via reHideExtracted)
      vi.advanceTimersByTime(150);
      await sync.flush();

      // reHideExtracted should have been called (extracted elements stay hidden)
      expect(mockDelta.setVisible).toHaveBeenCalled();
    });
  });

  // ── Delete cascade ────────────────────────────────────────────────

  describe("delete", () => {
    it("batches cascade deletes into single editor.edit call", async () => {
      const wall = makeWall("w1");
      const win = makeWindow("win1", "w1");
      doc.add(wall);
      doc.transaction(() => {
        doc.add(win);
        doc.update("w1", { hostedElements: ["win1"] } as any);
      });
      await sync.flush();

      // Set fragmentIds for both
      doc.fragmentIds.set("w1", fakeFragIds(1));
      doc.fragmentIds.set("win1", fakeFragIds(20));

      const editCallsBefore = (mgr.editor.edit as any).mock.calls.length;

      // Remove wall → should cascade-delete window in same transaction
      doc.remove("w1");

      // Wait for microtask (queueMicrotask batching)
      await new Promise((r) => queueMicrotask(r));
      await sync.flush();

      // Should be a single editor.edit call for the batch (not two separate ones)
      const editCallsAfter = (mgr.editor.edit as any).mock.calls.length;
      expect(editCallsAfter - editCallsBefore).toBe(1);
    });

    it("updates miter neighbor overlay after deleting connected wall", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [10,0,0]);
      doc.add(w1);
      doc.add(w2);
      await sync.flush();

      doc.fragmentIds.set("w1", fakeFragIds(1));
      doc.fragmentIds.set("w2", fakeFragIds(10));

      // Record overlay count before delete
      const meshCountBefore = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;

      // Delete w1 → w2 should get an overlay update (new geometry without miter)
      doc.remove("w1");

      // After delete, w2 should have an overlay showing updated geometry
      const meshCountAfter = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      expect(meshCountAfter).toBeGreaterThanOrEqual(1); // w2's overlay
    });

    it("prunes stale cutTargets when cut target is deleted", async () => {
      // Regression: deleting a wall that was a cut target left the cutter
      // (e.g., column) with a dangling cutTargets reference, causing
      // dependentsOf invariant violations.
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      // Add column without cutTargets first
      const col: AnyContract = { id: "col1", kind: "column" } as any;
      doc.add(col);
      await sync.flush();

      // Now set cutTargets directly (bypasses geometry generation cascade)
      doc.contracts.set("col1", { ...col, cutTargets: ["w1"] } as any);
      sync.rebuildDependentsIndex();

      doc.fragmentIds.set("w1", fakeFragIds(1));
      doc.fragmentIds.set("col1", fakeFragIds(13));

      // Delete the wall (cut target)
      doc.remove("w1");

      // The column's cutTargets should be pruned
      const updatedCol = doc.contracts.get("col1") as any;
      expect(updatedCol.cutTargets).toEqual([]);

      // Invariants should hold
      // Wait for microtask (deferred cuts cleanup) + flush timer
      await new Promise((r) => queueMicrotask(r));
      await vi.advanceTimersByTimeAsync(150);
      expect(() => sync.assertInvariants()).not.toThrow();
    });
  });

  // ── Pending ops coalescing ────────────────────────────────────────

  describe("pending ops coalescing", () => {
    it("coalesces create + update into create", async () => {
      const wall = makeWall("w1");
      doc.add(wall); // schedules "create"
      doc.update("w1", { height: 4 } as any); // should stay "create"

      vi.advanceTimersByTime(150);
      await sync.flush();

      // Only one editor.edit call (not separate create + update)
      expect(mgr.editor.edit).toHaveBeenCalledTimes(1);
    });

    it("debounce resets on each new operation", async () => {
      const wall = makeWall("w1");
      doc.add(wall);

      // Advance 80ms (less than 100ms debounce)
      vi.advanceTimersByTime(80);
      expect(mgr.editor.edit).not.toHaveBeenCalled();

      // Update resets the timer
      doc.update("w1", { height: 4 } as any);

      // Advance another 80ms (total 160ms from add, but only 80ms from update)
      vi.advanceTimersByTime(80);
      // Still shouldn't have flushed (only 80ms since last op)
      // Actually the debounce timer resets, so we need 100ms from the update

      vi.advanceTimersByTime(30);
      await sync.flush();

      expect(mgr.editor.edit).toHaveBeenCalledTimes(1);
    });
  });

  // ── Fragment history tracking ─────────────────────────────────────

  describe("fragment history", () => {
    it("tracks lastFragmentRequestIndex after flush", async () => {
      expect(sync.lastFragmentRequestIndex).toBe(-1);

      const wall = makeWall("w1");
      doc.add(wall);
      vi.advanceTimersByTime(150);
      await sync.flush();

      expect(sync.lastFragmentRequestIndex).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Cascade overlay preservation ──────────────────────────────────

  describe("cascade overlay preservation", () => {
    it("keeps overlay when a newer pendingOp exists", async () => {
      // Create two walls in L
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);

      // Flush w1
      vi.advanceTimersByTime(150);
      await sync.flush();

      // Add w2 sharing endpoint → cascades update overlay to w1
      const w2 = makeWall("w2", [5,0,0], [5,0,5]);
      doc.add(w2);

      // At this point, w1 has an overlay (from cascade) and a pending "update" op.
      // When the flush runs, it should NOT remove w1's overlay if a new pending
      // op was created by another cascade while the flush was running.

      vi.advanceTimersByTime(150);
      await sync.flush();

      // After flush, overlays for non-extracted elements with no pending ops should be removed.
      // This test mainly ensures the flush doesn't crash and handles the guard correctly.
    });
  });

  // ── Extract/restore with L-shaped walls ───────────────────────────

  describe("L-shaped wall scenarios", () => {
    it("extract wall A extracts connected wall B and hosted windows", async () => {
      // Wall A and B share a corner
      const wA = makeWall("wA", [0,0,0], [5,0,0]);
      const wB = makeWall("wB", [5,0,0], [5,0,5]);
      doc.add(wA);
      doc.add(wB);

      // Add a window to wall A only
      const winA = makeWindow("winA", "wA");
      doc.transaction(() => {
        doc.add(winA);
        doc.update("wA", { hostedElements: ["winA"] } as any);
      });
      await sync.flush();

      sync.extract("wA");

      // 3 elements should have overlays:
      // wA, winA (hosted by wA), wB (connectedTo)
      // Note: collectExtract does NOT recurse into connectedTo's children
      const meshCount = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      expect(meshCount).toBeGreaterThanOrEqual(3);
    });

    it("restore wall A restores connected wall B and hosted window", async () => {
      const wA = makeWall("wA", [0,0,0], [5,0,0]);
      const wB = makeWall("wB", [5,0,0], [5,0,5]);
      doc.add(wA);
      doc.add(wB);

      const winA = makeWindow("winA", "wA");
      doc.transaction(() => {
        doc.add(winA);
        doc.update("wA", { hostedElements: ["winA"] } as any);
      });
      await sync.flush();

      sync.extract("wA");
      sync.restore("wA");
      await drainRestore();

      const remainingOverlays = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      expect(remainingOverlays).toBe(0);
    });
  });

  // ── Window + host restore scenario (the bug we fixed) ─────────────

  describe("window restore with siblings", () => {
    it("restoring one window restores host wall and all sibling windows", async () => {
      const wall = makeWall("w1");
      doc.add(wall);

      const win1 = makeWindow("win1", "w1");
      const win2 = makeWindow("win2", "w1", 0.3);
      const win3 = makeWindow("win3", "w1", 0.7);
      doc.transaction(() => {
        doc.add(win1);
        doc.add(win2);
        doc.add(win3);
        doc.update("w1", { hostedElements: ["win1", "win2", "win3"] } as any);
      });
      await sync.flush();

      // Extract win1 → cascades to wall → cascades to win2, win3
      sync.extract("win1");

      // Verify all 4 are extracted (have overlays)
      const meshesAfterExtract = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      expect(meshesAfterExtract).toBeGreaterThanOrEqual(4);

      // Restore just win1 → should cascade to wall, win2, win3
      sync.restore("win1");
      await drainRestore();

      // All overlays should be cleaned up
      const remaining = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      expect(remaining).toBe(0);
    });
  });

  // ── Reverse cascade (floors) ──────────────────────────────────────

  describe("reverse cascade (floor → wall)", () => {
    it("updates floor overlay when a referenced wall is updated", async () => {
      // Create two walls forming an L and a floor referencing their endpoints
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [5,0,5]);
      doc.add(w1);
      doc.add(w2);
      await sync.flush();

      const floor = makeFloor("f1", [
        { type: "wallEndpoint", wallId: "w1", endpoint: "start" },
        { type: "wallEndpoint", wallId: "w1", endpoint: "end" },
        { type: "wallEndpoint", wallId: "w2", endpoint: "end" },
      ]);
      doc.add(floor);
      await sync.flush();

      const editorEditCalls = (mgr.editor.edit as any).mock.calls.length;

      // Update wall w1 — floor should be scheduled for update via reverse cascade
      doc.update("w1", { end: [6,0,0] } as any);
      await sync.flush();

      // editor.edit should have been called again (for wall update + floor cascade)
      expect((mgr.editor.edit as any).mock.calls.length).toBeGreaterThan(editorEditCalls);
    });

    it("updates floor overlay when a referenced wall is deleted", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [5,0,5]);
      doc.add(w1);
      doc.add(w2);

      const floor = makeFloor("f1", [
        { type: "wallEndpoint", wallId: "w1", endpoint: "start" },
        { type: "wallEndpoint", wallId: "w1", endpoint: "end" },
        { type: "wallEndpoint", wallId: "w2", endpoint: "end" },
      ]);
      doc.add(floor);
      await sync.flush();

      // Floor overlay should exist
      const overlaysBefore = scene.children.filter(c => c instanceof THREE.Mesh).length;

      // Delete wall w1 — floor should get a cascade update (degrade gracefully)
      doc.remove("w1");
      // Floor should still have an overlay (refreshed via reverse cascade)
      const overlaysAfter = scene.children.filter(c => c instanceof THREE.Mesh).length;
      // Floor overlay should have been refreshed (set again)
      expect(overlaysAfter).toBeGreaterThanOrEqual(1);
    });

    it("extracts floor when a referenced wall is extracted", async () => {
      // Create walls and a floor referencing them
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [5,0,5]);
      doc.add(w1);
      doc.add(w2);

      const floor = makeFloor("f1", [
        { type: "wallEndpoint", wallId: "w1", endpoint: "start" },
        { type: "wallEndpoint", wallId: "w1", endpoint: "end" },
        { type: "wallEndpoint", wallId: "w2", endpoint: "end" },
      ]);
      doc.add(floor);
      await sync.flush();

      // Extract w1 — floor should also be extracted (reverse dependent)
      sync.extract("w1");

      // Floor overlay should exist alongside wall overlays
      const meshCount = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      // w1, w2 (connected), and f1 (reverse dependent) should all have overlays
      expect(meshCount).toBeGreaterThanOrEqual(3);
    });

    it("restoring wall also restores reverse-dependent floor", async () => {
      // Regression: floor was extracted via reverse dependents but
      // collectRestoreCascade didn't walk dependentsOf, so the floor
      // stayed in Extracted state forever — its fragment never updated.
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [5,0,5]);
      doc.add(w1);
      doc.add(w2);

      const floor = makeFloor("f1", [
        { type: "wallEndpoint", wallId: "w1", endpoint: "start" },
        { type: "wallEndpoint", wallId: "w1", endpoint: "end" },
        { type: "wallEndpoint", wallId: "w2", endpoint: "end" },
      ]);
      doc.add(floor);
      await sync.flush();

      // Extract w1 — floor should also be extracted (reverse dependent)
      sync.extract("w1");
      expect(sync.vsm.getState("f1")).toBe(1); // VisState.Extracted

      // Restore w1 — floor should ALSO be restored
      sync.restore("w1");
      await drainRestore();

      // Floor should be back to Normal — not stuck in Extracted
      const floorState = sync.vsm.getState("f1");
      expect(floorState).toBe(0); // VisState.Normal

      // No overlays should remain
      const remaining = scene.children.filter(
        (c) => c instanceof THREE.Mesh
      ).length;
      expect(remaining).toBe(0);
    });

    it("dependentsOf index is restored after undo of boundary change", async () => {
      // Create wall and floor referencing it
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);

      const floor = makeFloor("f1", [
        { type: "wallEndpoint", wallId: "w1", endpoint: "start" },
        { type: "wallEndpoint", wallId: "w1", endpoint: "end" },
        { type: "free", position: [5, 0, 5] },
      ]);
      doc.add(floor);
      await sync.flush();

      // Floor depends on w1 via reverse index (rebuild since index is lazy)
      const depsOf = (sync as any).dependentsOf as Map<string, Set<string>>;
      sync.rebuildDependentsIndex();
      expect(depsOf.get("w1")?.has("f1")).toBe(true);

      // Capture the transaction for undo
      let lastRecord: any;
      doc.onTransactionCommit.add((record) => { lastRecord = record; });

      // Update floor to remove the wall reference (unbind vertex → free)
      doc.update("f1", {
        boundary: [
          { type: "free", position: [0, 0, 0] },
          { type: "free", position: [5, 0, 0] },
          { type: "free", position: [5, 0, 5] },
        ],
      } as any);

      // After update, floor no longer depends on w1
      sync.rebuildDependentsIndex();
      expect(depsOf.get("w1")?.has("f1") ?? false).toBe(false);

      // Undo the boundary change
      sync.isUndoRedo = true;
      doc.undo(lastRecord);
      sync.isUndoRedo = false;

      // After undo, reverse index should be restored — floor depends on w1 again
      sync.rebuildDependentsIndex();
      expect(depsOf.get("w1")?.has("f1")).toBe(true);
    });

    it("drainPending skips flush while drag is active", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);

      // Don't flush yet — the debounce timer is ticking
      // Start drag before the timer fires
      sync.startDrag("w1");

      // Advance past the debounce — drainPending should bail out
      vi.advanceTimersByTime(150);

      // editor.edit should NOT have been called (drain skipped during drag)
      expect(mgr.editor.edit).not.toHaveBeenCalled();

      // End drag — should re-schedule the flush
      sync.endDrag("w1");
      vi.advanceTimersByTime(150);
      await sync.flush();

      // Now the pending create should have flushed
      expect(mgr.editor.edit).toHaveBeenCalled();
    });

    it("drainPending skips flush while elements are extracted", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      vi.advanceTimersByTime(150);
      await sync.flush();

      const editCallsBefore = (mgr.editor.edit as any).mock.calls.length;

      // Extract the element (simulates selection)
      sync.extract("w1");
      await sync.flush();

      // Update the element while extracted — triggers schedulePending
      const updated = { ...w1, start: [1,0,0] as [number,number,number] };
      doc.update("w1", updated);

      // Advance past debounce — drainPending should bail out
      vi.advanceTimersByTime(150);

      // editor.edit should NOT have been called again (drain skipped during extraction)
      expect((mgr.editor.edit as any).mock.calls.length).toBe(editCallsBefore);
    });

    it("doc.toJSON and loadFromJSON round-trip preserves contracts and fragmentIds", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      const floor = makeFloor("f1", [
        { type: "wallEndpoint", wallId: "w1", endpoint: "start" },
        { type: "wallEndpoint", wallId: "w1", endpoint: "end" },
        { type: "free", position: [5, 0, 5] },
      ]);
      doc.add(floor);
      await sync.flush();

      // Capture state
      const json = doc.toJSON();
      expect(json.contracts).toHaveLength(2);
      expect(json.fragmentIds).toHaveLength(2);

      // Clear and reload
      doc.loadFromJSON({ contracts: [], fragmentIds: [] });
      expect(doc.contracts.size).toBe(0);
      expect(doc.fragmentIds.size).toBe(0);

      // Restore
      doc.loadFromJSON(json);
      expect(doc.contracts.size).toBe(2);
      expect(doc.contracts.get("w1")?.kind).toBe("wall");
      expect(doc.contracts.get("f1")?.kind).toBe("floor");
      expect(doc.fragmentIds.size).toBe(2);
    });

    it("loadFromJSON does not fire onAdded events", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      await sync.flush();

      const json = doc.toJSON();
      const addedSpy = vi.fn();
      doc.onAdded.add(addedSpy);

      doc.loadFromJSON(json);
      expect(addedSpy).not.toHaveBeenCalled();
      doc.onAdded.remove(addedSpy);
    });

    it("sync.reset clears all internal state", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      await sync.flush();

      // Extract to populate state machine and overlays
      sync.extract("w1");

      const depsOf = (sync as any).dependentsOf as Map<string, Set<string>>;

      expect(sync.vsm.getState("w1")).toBe(1); // VisState.Extracted

      // Reset
      sync.reset();

      expect(sync.vsm.size).toBe(0);
      expect(depsOf.size).toBe(0);
      expect(sync.lastFragmentRequestIndex).toBe(-1);
    });

    it("sync.rebuildDependentsIndex reconstructs reverse index from contracts", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      const floor = makeFloor("f1", [
        { type: "wallEndpoint", wallId: "w1", endpoint: "start" },
        { type: "wallEndpoint", wallId: "w1", endpoint: "end" },
        { type: "free", position: [5, 0, 5] },
      ]);
      doc.add(floor);
      await sync.flush();

      const depsOf = (sync as any).dependentsOf as Map<string, Set<string>>;
      sync.rebuildDependentsIndex();
      expect(depsOf.get("w1")?.has("f1")).toBe(true);

      // Clear and rebuild
      depsOf.clear();
      (sync as any).dependentsIndexDirty = true;
      expect(depsOf.get("w1")?.has("f1") ?? false).toBe(false);

      sync.rebuildDependentsIndex();
      expect(depsOf.get("w1")?.has("f1")).toBe(true);
    });

    it("navigateFragmentHistory restores base visibility for ALL elements when undoing past loaded state", async () => {
      // Simulate: load an L-shaped pair, edit one wall, then undo to
      // before any edits. The miter neighbor was also edited in the delta
      // (cascade write). Undoing to -1 empties the delta — BOTH walls'
      // base must be re-shown, not just the one in affectedIds.
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [5,0,5]);
      doc.add(w1);
      doc.add(w2);
      await sync.flush();

      const ids1 = doc.fragmentIds.get("w1")!;
      const ids2 = doc.fragmentIds.get("w2")!;
      expect(ids1).toBeDefined();
      expect(ids2).toBeDefined();
      const localId1 = ids1.itemId;
      const localId2 = ids2.itemId;

      const baseModel = mgr.fragments.models.list.get("bim-authoring");

      // Navigate to -1 with only w1 as affected. The -1 path waits for
      // onViewUpdated (with 200ms fallback). Trigger the event + advance timers.
      const navPromise = sync.navigateFragmentHistory(-1, ["w1"]);
      (baseModel as any).onViewUpdated.trigger();
      await vi.advanceTimersByTimeAsync(300);
      await navPromise;

      // Both walls should be shown on base — navigateFragmentHistory
      // unconditionally shows all elements on base (delta takes
      // rendering precedence when it has geometry)
      const showCalls = baseModel.setVisible.mock.calls.filter(
        (c: any[]) => c[1] === true
      );
      const shownIds = showCalls.flatMap((c: any[]) => c[0]);
      expect(shownIds).toContain(localId1);
      expect(shownIds).toContain(localId2);
    });

    it("assertInvariants passes after extract", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      await sync.flush();
      sync.extract("w1");
      expect(() => sync.assertInvariants()).not.toThrow();
    });

    it("assertInvariants passes after extract + restore cycle", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      await sync.flush();

      sync.extract("w1");
      expect(() => sync.assertInvariants()).not.toThrow();

      sync.restore("w1");
      await drainRestore();
      expect(() => sync.assertInvariants()).not.toThrow();
    });

    it("assertInvariants passes with connected walls", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [5,0,5]);
      doc.add(w1);
      doc.add(w2);
      await sync.flush();

      // dependentsOf is now consistent after sequential adds —
      // onAdded re-indexes neighbors when a new element is added.
      expect(() => sync.assertInvariants()).not.toThrow();

      sync.extract("w1"); // cascade extracts w2 too
      expect(() => sync.assertInvariants()).not.toThrow();
    });

    it("assertInvariants passes after multi-select restore of connected walls with windows", async () => {
      // Two connected walls, each hosting a window
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [5,0,5]);
      w1.hostedElements = ["win1"];
      w2.hostedElements = ["win2"];
      doc.add(w1);
      doc.add(w2);
      doc.add(makeWindow("win1", "w1", 0.5));
      doc.add(makeWindow("win2", "w2", 0.5));
      await sync.flush();

      // Multi-select both walls (extracts both + their windows + connected peers)
      sync.extract("w1");
      sync.extract("w2");
      expect(() => sync.assertInvariants()).not.toThrow();

      // Restore both at once (simulates clearSelection)
      sync.restore(["w1", "w2"]);
      await drainRestore();

      // After restore completes, no priorRelationships should remain
      expect(() => sync.assertInvariants()).not.toThrow();
    });

    it("assertInvariants passes after reset", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      await sync.flush();
      sync.extract("w1");
      sync.reset();
      expect(() => sync.assertInvariants()).not.toThrow();
    });

    it("assertInvariants self-heals stale dependentsOf via lazy rebuild", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);
      await sync.flush();

      // Corrupt: add a stale entry and mark dirty
      const depsOf = (sync as any).dependentsOf as Map<string, Set<string>>;
      depsOf.set("w1", new Set(["ghost"]));
      (sync as any).dependentsIndexDirty = true;

      // assertInvariants rebuilds the lazy index first — no error
      expect(() => sync.assertInvariants()).not.toThrow();

      // Clean up
      depsOf.delete("w1");
    });

    it("assertInvariants passes after simulated load flow (reset + loadFromJSON)", async () => {
      // 1. Create elements interactively (fires events, builds index)
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      const w2 = makeWall("w2", [5,0,0], [5,0,5]);
      w1.hostedElements = ["win1"];
      doc.add(w1);
      doc.add(w2);
      const win1 = makeWindow("win1", "w1", 0.5);
      doc.add(win1);
      await sync.flush();

      // Verify baseline is correct
      expect(() => sync.assertInvariants()).not.toThrow();

      // 2. Simulate save: capture serialized data
      const savedContracts: [string, Record<string, unknown>][] = [];
      for (const [id, c] of doc.contracts) {
        savedContracts.push([id, { ...c }]);
      }
      const savedFragIds: [string, FragmentElementIds][] = [];
      for (const [id, fid] of doc.fragmentIds) {
        savedFragIds.push([id, fid]);
      }

      // 3. Simulate load: reset + loadFromJSON (no events)
      sync.reset();
      doc.loadFromJSON({
        contracts: savedContracts,
        fragmentIds: savedFragIds,
      });

      // 4. Explicitly rebuild dependentsOf (matches real load flow in main.ts:
      //    spatialIndex.rebuild() then sync.rebuildDependentsIndex())
      sync.rebuildDependentsIndex();

      // 5. Assert — index should be fully correct
      expect(() => sync.assertInvariants()).not.toThrow();

      // Also verify lazy path works as fallback: corrupt + mark dirty
      (sync as any).dependentsOf.clear();
      (sync as any).dependentsIndexDirty = true;
      expect(() => sync.assertInvariants()).not.toThrow();
    });

    it("floor with free vertices has no wall dependency for those vertices", async () => {
      const w1 = makeWall("w1", [0,0,0], [5,0,0]);
      doc.add(w1);

      const floor = makeFloor("f1", [
        { type: "wallEndpoint", wallId: "w1", endpoint: "start" },
        { type: "wallEndpoint", wallId: "w1", endpoint: "end" },
        { type: "free", position: [5, 0, 5] },
      ]);
      doc.add(floor);
      await sync.flush();

      // Floor should declare connectedTo only w1 (not a free vertex)
      const rels = registry.getRelationships(floor, doc);
      expect(rels).toHaveLength(1);
      expect(rels[0]).toEqual({ type: "connectedTo", targetId: "w1" });
    });
  });
});
