import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GeometryEngine } from "@thatopen/fragments";
import type { Tool, ToolManager } from "./tool-manager";
import type { BimDocument } from "../core/document";
import type { FragmentManager } from "../fragments/manager";
import type { FragmentSync } from "../fragments/sync";
import type { ElementRegistry, ElementHandles } from "../core/registry";
import type { AnyContract, ContractId } from "../core/contracts";

import { findAllJoints } from "../utils/joints";
import { JointMenu } from "../ui/joint-menu";

export class SelectTool implements Tool {
  name = "select";

  private doc: BimDocument;
  private mgr: FragmentManager;
  private scene: THREE.Scene;
  private toolMgr: ToolManager;
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private controls: OrbitControls;
  private engine: GeometryEngine;
  private sync: FragmentSync;
  private registry: ElementRegistry;

  /** All currently selected contracts. */
  private selectedContracts = new Map<ContractId, AnyContract>();
  /** Handles per selected element. */
  private handlesMap = new Map<ContractId, ElementHandles>();
  /** The handle set currently being dragged (null when not dragging). */
  private activeHandles: ElementHandles | null = null;
  private isDragging = false;
  private jointMenu: JointMenu;
  /** Elements sharing the dragged corner: contractId → endpoint ID. */
  private sharedCornerPeers = new Map<ContractId, string>();
  /** RAF throttle for drag: coalesce pointer events to one update per frame. */
  private pendingDragEvent: { intersection: THREE.Vector3; event: PointerEvent } | null = null;
  private dragRafId: number | null = null;

  onSelectionChanged: ((contract: AnyContract | null) => void) | null = null;
  onDragStateChanged: ((dragging: boolean) => void) | null = null;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    doc: BimDocument,
    mgr: FragmentManager,
    toolMgr: ToolManager,
    controls: OrbitControls,
    engine: GeometryEngine,
    sync: FragmentSync,
    registry: ElementRegistry
  ) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.doc = doc;
    this.mgr = mgr;
    this.toolMgr = toolMgr;
    this.controls = controls;
    this.engine = engine;
    this.sync = sync;
    this.registry = registry;
    this.jointMenu = new JointMenu(doc);
  }

  activate() {
    document.body.style.cursor = "default";
    // Re-create handles for any preserved selection (e.g. returning from Move tool)
    for (const [id, contract] of this.selectedContracts) {
      if (this.handlesMap.has(id)) continue;
      const typeDef = this.registry.get(contract.kind);
      const handles = typeDef?.createHandles?.(
        this.scene,
        this.doc,
        this.engine,
        contract,
        this.camera,
        this.canvas
      );
      if (handles) this.handlesMap.set(id, handles);
    }
    if (this.selectedContracts.size > 0) this.fireSelectionChanged();
  }

  deactivate() {
    // Hide handles but preserve selection — elements stay extracted.
    // Explicit clearing (Escape, click-away, undo, save) still calls clearSelection().
    for (const [, handles] of this.handlesMap) handles.dispose();
    this.handlesMap.clear();
  }

  async onPointerDown(event: PointerEvent, groundHit: THREE.Vector3 | null) {
    if (event.button !== 0) return;
    // Block selection during fast undo/redo (model is translucent,
    // fragment history not yet finalized).
    if (this.sync.modelTranslucent) return;

    // Check if we're clicking on any selected wall's handle
    for (const [, handles] of this.handlesMap) {
      const handleHit = handles.checkHit(event, this.toolMgr, this.camera);
      if (handleHit) {
        this.activeHandles = handles;
        this.isDragging = true;
        this.controls.enabled = false;
        // Group all drag updates into one undo step
        this.doc.transactionGroupId = "drag-" + Date.now();
        // Detect shared corners before drag starts
        this.detectSharedCorners();
        // Tell active handles to exclude all selected walls from snapping
        const otherIds = [...this.selectedContracts.keys()].filter(
          (id) => id !== handles.contract.id
        );
        if (handles.snapExcludeIds !== undefined) {
          handles.snapExcludeIds = otherIds;
        }
        // Skip boolean cuts during drag for all selected contracts
        for (const [id] of this.selectedContracts) {
          this.sync.startDrag(id);
        }
        this.onDragStateChanged?.(true);
        return;
      }
    }

    // Use fragments' built-in raycast (handles tile-based GPU buffers)
    const contract = await this.pickContract(event);

    if (contract) {
      this.jointMenu.hide();
      if (event.shiftKey) {
        // Shift+click: toggle in/out of selection
        if (this.selectedContracts.has(contract.id)) {
          this.deselectContract(contract.id);
        } else {
          this.addToSelection(contract);
        }
      } else {
        // Plain click: replace selection
        this.selectContract(contract);
      }
    } else {
      // Check if clicking near a wall joint
      const joint = this.pickJoint(event);
      if (joint) {
        this.clearSelection();
        this.jointMenu.show(joint, event.clientX, event.clientY);
      } else if (!this.jointMenu.visible) {
        this.clearSelection();
      }
    }
  }

  onPointerMove(event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (this.isDragging && this.activeHandles && intersection) {
      // Coalesce rapid pointer events: only the latest is processed,
      // once per animation frame. Prevents event-queue backlog that
      // causes progressive lag during fast endpoint dragging.
      this.pendingDragEvent = { intersection: intersection.clone(), event };
      if (this.dragRafId === null) {
        this.dragRafId = requestAnimationFrame(() => {
          this.dragRafId = null;
          if (this.pendingDragEvent && this.activeHandles) {
            this.activeHandles.onDrag(
              this.pendingDragEvent.intersection,
              this.pendingDragEvent.event
            );
            this.updateSharedCorners();
            this.pendingDragEvent = null;
          }
        });
      }
    }
  }

  onPointerUp(_event: PointerEvent) {
    if (this.isDragging && this.activeHandles) {
      // Flush any pending RAF frame so the final position is applied
      if (this.dragRafId !== null) {
        cancelAnimationFrame(this.dragRafId);
        this.dragRafId = null;
      }
      if (this.pendingDragEvent) {
        this.activeHandles.onDrag(
          this.pendingDragEvent.intersection,
          this.pendingDragEvent.event
        );
        this.updateSharedCorners();
        this.pendingDragEvent = null;
      }
      this.activeHandles.onDragEnd();
      this.isDragging = false;
      this.activeHandles = null;
      this.sharedCornerPeers.clear();
      this.controls.enabled = true;
      // Stop grouping drag transactions
      this.doc.transactionGroupId = null;
      // Restore full boolean cuts for all selected contracts
      for (const [id] of this.selectedContracts) {
        this.sync.endDrag(id);
      }
      this.onDragStateChanged?.(false);
    }
  }

  onKeyDown(event: KeyboardEvent) {
    if (this.sync.modelTranslucent) return;
    if (event.key === "Escape") {
      this.clearSelection();
    }
    if (event.key === "Delete" && this.selectedContracts.size > 0) {
      const ids = [...this.selectedContracts.keys()];
      // Clean up handles
      for (const [, handles] of this.handlesMap) {
        handles.dispose();
      }
      this.handlesMap.clear();
      this.selectedContracts.clear();
      this.onSelectionChanged?.(null);
      // Delete all selected (+ cascaded dependents) in one transaction
      this.doc.transaction(() => {
        for (const id of ids) {
          this.doc.remove(id);
        }
      });
    }
  }

  /** Replace selection without restoring old elements or finalizing undo.
   *  Old elements stay extracted (overlays persist with correct geometry).
   *  Only clearSelection (true click-away) restores everything. */
  private selectContract(contract: AnyContract) {
    this.selectedContracts.clear();
    for (const [, handles] of this.handlesMap) handles.dispose();
    this.handlesMap.clear();

    this.addToSelection(contract);
  }

  /** Add a contract to the current selection. */
  private async addToSelection(contract: AnyContract) {
    if (this.selectedContracts.has(contract.id)) return;

    this.selectedContracts.set(contract.id, contract);

    // Extract from fragments into overlay for fast editing
    this.sync.extract(contract.id);

    const typeDef = this.registry.get(contract.kind);
    const handles = typeDef?.createHandles?.(this.scene, this.doc, this.engine, contract, this.camera, this.canvas);
    if (handles) {
      this.handlesMap.set(contract.id, handles);
    }

    this.fireSelectionChanged();
  }

  /** Remove a single contract from the selection. */
  private deselectContract(contractId: ContractId) {
    this.selectedContracts.delete(contractId);

    const handles = this.handlesMap.get(contractId);
    if (handles) {
      handles.dispose();
      this.handlesMap.delete(contractId);
    }

    // Fire selection change BEFORE restore so the properties panel
    // flushes any pending updates while elements are still extracted.
    this.fireSelectionChanged();
    this.sync.restore([contractId]);
  }

  clearSelection() {
    const ids = [...this.selectedContracts.keys()];
    this.selectedContracts.clear();

    for (const [, handles] of this.handlesMap) {
      handles.dispose();
    }
    this.handlesMap.clear();

    // Fire selection change BEFORE restore so the properties panel
    // flushes any pending updates while elements are still extracted.
    this.onSelectionChanged?.(null);
    this.sync.restore(ids);
  }

  /**
   * At drag start, find other selected walls that share the dragged endpoint.
   * Store them so updateSharedCorners can move them each frame without re-matching.
   */
  private detectSharedCorners() {
    this.sharedCornerPeers.clear();
    if (!this.activeHandles) return;
    const target = this.activeHandles.activeTarget;
    if (!target) return;

    const preDrag = this.activeHandles.getPreDragEndpoint?.();
    if (!preDrag) return;

    const draggedId = this.activeHandles.contract.id;
    const reg = this.registry;

    for (const [id, handles] of this.handlesMap) {
      if (id === draggedId) continue;
      const def = reg.get(handles.contract.kind);
      const edges = def?.getLinearEdges?.(handles.contract, this.doc);
      if (!edges) continue;
      for (const edge of edges) {
        if (coordsMatch(edge.start, preDrag)) {
          this.sharedCornerPeers.set(id, edge.startId);
          break;
        } else if (coordsMatch(edge.end, preDrag)) {
          this.sharedCornerPeers.set(id, edge.endId);
          break;
        }
      }
    }
  }

  /**
   * Move shared corner peers to match the actively dragged endpoint.
   */
  private updateSharedCorners() {
    if (!this.activeHandles || this.sharedCornerPeers.size === 0) return;
    const target = this.activeHandles.activeTarget;
    if (!target) return;

    const reg = this.registry;
    const draggedContract = this.activeHandles.contract;
    const newPos = reg.get(draggedContract.kind)?.getEndpointPosition?.(draggedContract, target, this.doc);
    if (!newPos) return;

    for (const [id, endpointId] of this.sharedCornerPeers) {
      const handles = this.handlesMap.get(id);
      if (!handles) continue;

      const updated = {
        ...handles.contract,
        [endpointId]: [...newPos],
      };
      this.doc.update(id, updated);
      handles.updateFromContract(updated);
    }
  }

  /**
   * Use fragments' built-in raycast to pick elements.
   * Falls back to overlay raycast for extracted/hidden elements.
   */
  private async pickContract(event: PointerEvent): Promise<AnyContract | null> {
    const mouse = new THREE.Vector2(event.clientX, event.clientY);
    const data = { camera: this.camera, mouse, dom: this.canvas };

    // Raycast all models (delta models hold edited geometry)
    let best: { localId: number; distance: number } | null = null;
    for (const [, model] of this.mgr.fragments.models.list) {
      const result = await model.raycast(data);
      if (result && (!best || result.distance < best.distance)) {
        best = { localId: result.localId, distance: result.distance };
      }
    }

    // Also raycast overlay meshes (for extracted/hidden elements)
    const raycaster = new THREE.Raycaster();
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, this.camera);
    const overlayHit = this.sync.raycastOverlays(raycaster);

    // Pick the closest between fragment hit and overlay hit
    const fragDist = best?.distance ?? Infinity;
    const overlayDist = overlayHit?.distance ?? Infinity;

    if (overlayDist < fragDist && overlayHit) {
      return this.doc.contracts.get(overlayHit.id) ?? null;
    }
    if (best) {
      return this.doc.getContractByFragmentId(best.localId) ?? null;
    }

    return null;
  }

  /**
   * Check if a click is near a wall joint (shared endpoint).
   * Projects all joint 3D points to screen space and checks pixel distance.
   */
  private pickJoint(event: PointerEvent) {
    const joints = findAllJoints(this.doc);
    if (joints.length === 0) return null;

    const threshold = 20; // pixels
    let best: { joint: (typeof joints)[0]; dist: number } | null = null;

    for (const joint of joints) {
      const worldPt = new THREE.Vector3(...joint.point);
      const screenPt = worldPt.project(this.camera);

      // Convert NDC to pixel coords
      const px = ((screenPt.x + 1) / 2) * this.canvas.clientWidth;
      const py = ((-screenPt.y + 1) / 2) * this.canvas.clientHeight;

      const dx = px - event.clientX;
      const dy = py - event.clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < threshold && (!best || dist < best.dist)) {
        best = { joint, dist };
      }
    }

    return best?.joint ?? null;
  }

  getSelectedContract(): AnyContract | null {
    if (this.selectedContracts.size === 0) return null;
    return this.selectedContracts.values().next().value ?? null;
  }

  /** Return all currently selected contracts in insertion order. */
  getSelectedContractsAll(): AnyContract[] {
    return [...this.selectedContracts.values()];
  }

  /** Return IDs of all currently selected contracts. */
  getSelectedIds(): ContractId[] {
    return [...this.selectedContracts.keys()];
  }

  /** Programmatically select elements by ID (e.g. after paste). */
  selectIds(ids: ContractId[]): void {
    this.clearSelection();
    for (const id of ids) {
      const contract = this.doc.contracts.get(id);
      if (contract) this.addToSelection(contract);
    }
  }

  private fireSelectionChanged() {
    // Fire with the first selected contract for properties panel compatibility
    const first = this.selectedContracts.values().next().value ?? null;
    this.onSelectionChanged?.(first);
  }
}

/** Check if two coordinate tuples match (within tolerance). */
function coordsMatch(
  a: [number, number, number],
  b: [number, number, number],
  eps = 0.01
): boolean {
  return (
    Math.abs(a[0] - b[0]) < eps &&
    Math.abs(a[1] - b[1]) < eps &&
    Math.abs(a[2] - b[2]) < eps
  );
}
