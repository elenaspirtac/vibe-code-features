import * as THREE from "three";
import type { Tool, ToolManager } from "./tool-manager";
import type { SelectTool } from "./select-tool";
import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";
import type { ElementRegistry } from "../core/registry";
import type { FragmentSync } from "../fragments/sync";
import { VisState } from "../fragments/visibility-state";
import { snapPoint, SnapIndicator, recordStickySnap } from "../utils/snap";
import { findNeighborsAtEndpoint } from "../utils/joints";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type MoveState = "idle" | "pickBase" | "moving";

interface StretchTarget {
  endpointId: string;
  originalContract: AnyContract;
}

export class MoveTool implements Tool {
  name = "move";

  // Tool interface fields (unused by move but required)
  typeId: ContractId | null = null;
  levelId: ContractId | null = null;

  private scene: THREE.Scene;
  private doc: BimDocument;
  private toolMgr: ToolManager;
  private sync: FragmentSync;
  private registry: ElementRegistry;
  private selectTool: SelectTool;
  private controls: OrbitControls;

  private state: MoveState = "idle";
  private selectedIds: ContractId[] = [];

  /** Called when drag begins (true) or ends (false). Used by main.ts to
   *  hide temp dimensions during drag and restore them after. */
  onDragStateChanged: ((dragging: boolean) => void) | null = null;
  private originalContracts = new Map<ContractId, AnyContract>();
  private basePoint: THREE.Vector3 | null = null;
  private snapIndicator: SnapIndicator;

  /** Non-selected neighbors sharing endpoints — stretched during move. */
  private stretchTargets = new Map<ContractId, StretchTarget>();
  /** Hosted elements on stretch targets — extracted so overlays update live. */
  private extraExtractedIds: ContractId[] = [];

  // Visual feedback: dashed line from base to cursor
  private guideLine: THREE.Line;
  private guideLineGeo: THREE.BufferGeometry;

  // RAF throttle: store raw inputs, process snap + applyDelta once per frame
  private pendingIntersection: THREE.Vector3 | null = null;
  private pendingShiftKey = false;
  private rafId: number | null = null;


  constructor(
    scene: THREE.Scene,
    doc: BimDocument,
    toolMgr: ToolManager,
    sync: FragmentSync,
    registry: ElementRegistry,
    selectTool: SelectTool,
    controls: OrbitControls
  ) {
    this.scene = scene;
    this.doc = doc;
    this.toolMgr = toolMgr;
    this.sync = sync;
    this.registry = registry;
    this.selectTool = selectTool;
    this.controls = controls;
    this.snapIndicator = new SnapIndicator(scene);

    // Guide line (dashed, hidden by default)
    this.guideLineGeo = new THREE.BufferGeometry();
    this.guideLineGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3)
    );
    const mat = new THREE.LineDashedMaterial({
      color: 0x4488ff,
      dashSize: 0.1,
      gapSize: 0.05,
      depthTest: false,
    });
    this.guideLine = new THREE.Line(this.guideLineGeo, mat);
    this.guideLine.renderOrder = 999;
    this.guideLine.visible = false;
    this.scene.add(this.guideLine);
  }

  activate() {
    const selected = this.selectTool.getSelectedContractsAll();
    if (selected.length === 0) {
      // Nothing selected — switch back to select tool
      this.toolMgr.setTool(this.selectTool);
      return;
    }

    document.body.style.cursor = "crosshair";
    this.state = "pickBase";
    this.selectedIds = selected.map((c) => c.id);

    // Snapshot all original contracts for delta-from-original and cancel/revert
    this.originalContracts.clear();
    for (const c of selected) {
      this.originalContracts.set(c.id, { ...c });
    }

    // Identify stretch targets (non-selected neighbors at shared endpoints)
    this.identifyStretchTargets();

    // Also snapshot stretch targets for snap overrides (pre-move positions)
    for (const [id, target] of this.stretchTargets) {
      this.originalContracts.set(id, { ...target.originalContract });
    }

    // Start rigid drag mode: enables aggressive fast path (skip cascade,
    // index updates, cache) since rigid translation preserves relationships.
    this.doc.transactionGroupId = "move-" + Date.now();
    for (const id of this.selectedIds) {
      this.sync.startDrag(id, true);
    }
    for (const [id] of this.stretchTargets) {
      this.sync.startDrag(id, true);
    }

    // Extract hosted elements on stretch targets (e.g. windows on a
    // connected wall) so their overlays update live during the drag.
    this.extraExtractedIds = [];
    const alreadyHandled = new Set([...this.selectedIds, ...this.stretchTargets.keys()]);
    for (const [id] of this.stretchTargets) {
      const cascade = this.sync.getExtractCascade(id);
      for (const depId of cascade) {
        if (alreadyHandled.has(depId)) continue;
        if (this.sync.isExtracted(depId)) continue;
        alreadyHandled.add(depId);
        this.extraExtractedIds.push(depId);
        this.sync.extract(depId);
        this.sync.startDrag(depId, true);
      }
    }

    this.guideLine.visible = false;
    this.onDragStateChanged?.(true);
  }

  deactivate() {
    document.body.style.cursor = "default";
    this.snapIndicator.hide();
    this.guideLine.visible = false;

    if (this.state === "moving" || this.state === "pickBase") {
      this.cancelInternal(/* switchTool */ false);
    }
    this.state = "idle";
  }

  onPointerDown(event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (event.button !== 0 || !intersection) return;

    const snapOpts = this.getSnapOverrides();
    const result = snapPoint(intersection, this.doc, {
      ...snapOpts,
      anchor: this.basePoint ?? undefined,
      shiftKey: event.shiftKey,
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    recordStickySnap(result);
    const snapped = result.position;

    if (this.state === "pickBase") {
      this.basePoint = snapped.clone();
      this.state = "moving";
    } else if (this.state === "moving") {
      this.commit();
    }
  }

  onPointerMove(_event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (!intersection) {
      this.snapIndicator.hide();
      this.toolMgr.hideCursor();
      return;
    }

    // Store raw inputs — ALL heavy work (snap + applyDelta) is deferred
    // to one RAF callback per frame, preventing event queue backlog.
    this.pendingIntersection = intersection.clone();
    this.pendingShiftKey = _event.shiftKey;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.processFrame();
      });
    }
  }

  /** Run snap + applyDelta once per animation frame. */
  private processFrame() {
    if (!this.pendingIntersection) return;
    const intersection = this.pendingIntersection;
    const shiftKey = this.pendingShiftKey;
    this.pendingIntersection = null;

    const snapOpts = this.getSnapOverrides();
    const result = snapPoint(intersection, this.doc, {
      ...snapOpts,
      anchor: this.basePoint ?? undefined,
      shiftKey,
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    recordStickySnap(result);
    this.snapIndicator.update(result);
    this.toolMgr.setCursorPosition(result.position);

    if (this.state === "moving" && this.basePoint) {
      const snapped = result.position;
      const delta: [number, number, number] = [
        snapped.x - this.basePoint.x,
        snapped.y - this.basePoint.y,
        snapped.z - this.basePoint.z,
      ];
      this.applyDelta(delta);
      this.updateGuideLine(this.basePoint, snapped);
    }
  }

  onPointerUp(_event: PointerEvent) {
    // Two-click workflow — nothing to do on pointer up
  }

  onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      this.cancelInternal(/* switchTool */ true);
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  /** Build snap options: use original contracts for moved/stretched walls
   *  (so snap sees their pre-move positions), exclude hosted dependents. */
  private getSnapOverrides(): { excludeIds: ContractId[]; contractOverrides: ReadonlyMap<ContractId, AnyContract> } {
    return {
      // Only exclude hosted elements — their world position is derived
      excludeIds: this.extraExtractedIds,
      contractOverrides: this.originalContracts,
    };
  }

  /**
   * Identify non-selected neighbors that share endpoints with selected
   * elements. These will be "stretched" (one endpoint moved) during the move.
   */
  private identifyStretchTargets() {
    this.stretchTargets.clear();
    const selectedSet = new Set(this.selectedIds);

    for (const id of this.selectedIds) {
      const contract = this.doc.contracts.get(id);
      if (!contract) continue;
      const def = this.registry.get(contract.kind);
      const edges = def?.getLinearEdges?.(contract, this.doc);
      if (!edges) continue;

      for (const edge of edges) {
        // Check each endpoint of the selected element
        for (const epId of [edge.startId, edge.endId]) {
          const neighbors = findNeighborsAtEndpoint(this.doc, id, epId);
          for (const neighbor of neighbors) {
            if (selectedSet.has(neighbor.id)) continue; // fully moved
            if (this.stretchTargets.has(neighbor.id)) continue; // already tracked

            const nDef = this.registry.get(neighbor.kind);
            const nEdges = nDef?.getLinearEdges?.(neighbor, this.doc);
            if (!nEdges) continue;

            // Find which of the neighbor's endpoints matches this endpoint
            const pos = def?.getEndpointPosition?.(contract, epId, this.doc);
            if (!pos) continue;

            for (const nEdge of nEdges) {
              if (coordsMatch(nEdge.start, pos)) {
                this.stretchTargets.set(neighbor.id, {
                  endpointId: nEdge.startId,
                  originalContract: { ...neighbor },
                });
                break;
              }
              if (coordsMatch(nEdge.end, pos)) {
                this.stretchTargets.set(neighbor.id, {
                  endpointId: nEdge.endId,
                  originalContract: { ...neighbor },
                });
                break;
              }
            }
          }
        }
      }
    }

    // Extract any stretch targets that aren't already extracted
    for (const [id] of this.stretchTargets) {
      if (this.sync.vsm.getState(id) !== VisState.Extracted) {
        this.sync.extract(id);
      }
    }
  }

  /**
   * Apply translation delta (from original positions) to all selected
   * elements and stretch neighbors.
   */
  private applyDelta(delta: [number, number, number]) {
    // Batch all updates into one transaction to avoid N+M individual
    // transactions (and their per-transaction overhead) per pointer move.
    const groupId = this.doc.transactionGroupId ?? undefined;
    this.doc.transaction(() => {
      // Move selected elements
      for (const id of this.selectedIds) {
        const original = this.originalContracts.get(id);
        if (!original) continue;
        const def = this.registry.get(original.kind);
        const translated = def?.applyTranslation?.(original, delta);
        if (translated) {
          this.doc.update(id, translated);
        }
      }

      // Stretch non-selected neighbors at shared endpoints
      for (const [id, target] of this.stretchTargets) {
        const original = target.originalContract;
        const def = this.registry.get(original.kind);
        const originalPos = def?.getEndpointPosition?.(
          original,
          target.endpointId,
          this.doc
        );
        if (!originalPos) continue;

        const newPos: [number, number, number] = [
          originalPos[0] + delta[0],
          originalPos[1] + delta[1],
          originalPos[2] + delta[2],
        ];
        this.doc.update(id, { ...this.doc.contracts.get(id)!, [target.endpointId]: newPos });
      }
    }, groupId ? { groupId } : undefined);
  }

  /** Commit the move: end drag mode and return to select tool. */
  private commit() {
    // Flush any pending RAF update so the final position is applied
    this.flushPendingRAF();

    this.doc.transactionGroupId = null;

    // Batch endDrag: single cascade pass avoids redundant overlay rebuilds
    // when multiple moved elements share neighbors.
    const allIds = [
      ...this.selectedIds,
      ...[...this.stretchTargets.keys()],
      ...this.extraExtractedIds,
    ];
    this.sync.endDragAll(allIds);

    this.onDragStateChanged?.(false);
    this.cleanup();
    this.toolMgr.setTool(this.selectTool);
  }

  /** Cancel the move: revert all contracts and return to select tool. */
  private cancelInternal(switchTool: boolean) {
    this.cancelPendingRAF();

    // Revert all selected elements to original state
    for (const [id, original] of this.originalContracts) {
      this.doc.update(id, original);
    }
    // Revert stretch targets
    for (const [id, target] of this.stretchTargets) {
      this.doc.update(id, target.originalContract);
    }

    this.doc.transactionGroupId = null;

    const allIds = [
      ...this.selectedIds,
      ...[...this.stretchTargets.keys()],
      ...this.extraExtractedIds,
    ];
    this.sync.endDragAll(allIds);

    this.onDragStateChanged?.(false);
    this.cleanup();
    if (switchTool) {
      this.toolMgr.setTool(this.selectTool);
    }
  }

  /** Process any queued RAF frame synchronously, then cancel the timer. */
  private flushPendingRAF() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.processFrame();
  }

  /** Cancel queued RAF without applying. */
  private cancelPendingRAF() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingIntersection = null;
  }

  private cleanup() {
    this.cancelPendingRAF();
    this.guideLine.visible = false;
    this.snapIndicator.hide();
    this.state = "idle";
    this.basePoint = null;
    this.stretchTargets.clear();
    this.originalContracts.clear();
    this.selectedIds = [];
    this.extraExtractedIds = [];
  }

  private updateGuideLine(from: THREE.Vector3, to: THREE.Vector3) {
    const positions = this.guideLineGeo.getAttribute(
      "position"
    ) as THREE.BufferAttribute;
    positions.setXYZ(0, from.x, from.y + 0.01, from.z);
    positions.setXYZ(1, to.x, to.y + 0.01, to.z);
    positions.needsUpdate = true;
    this.guideLineGeo.computeBoundingSphere();
    this.guideLine.computeLineDistances();
    this.guideLine.visible = true;
  }
}

/** Check if two coordinate tuples match (within tolerance). */
function coordsMatch(
  a: [number, number, number],
  b: [number, number, number],
  eps = 0.001
): boolean {
  return (
    Math.abs(a[0] - b[0]) < eps &&
    Math.abs(a[1] - b[1]) < eps &&
    Math.abs(a[2] - b[2]) < eps
  );
}
