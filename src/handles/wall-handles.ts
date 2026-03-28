import * as THREE from "three";
import type { GeometryEngine } from "@thatopen/fragments";
import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";
import type { WallContract } from "../elements/wall";
import { resolveWallParams } from "../elements/wall";
import type { ToolManager } from "../tools/tool-manager";
import { HandleMesh } from "./base";
import { snapPoint, SnapIndicator, recordStickySnap } from "../utils/snap";

export type DragTarget = "start" | "end" | "height" | null;

export class WallHandles {
  private scene: THREE.Scene;
  private doc: BimDocument;
  private engine: GeometryEngine;
  contract: WallContract;

  private startHandle: HandleMesh;
  private endHandle: HandleMesh;
  private heightHandle: HandleMesh;
  private _activeTarget: DragTarget = null;
  private snapIndicator: SnapIndicator;

  /** Additional IDs to exclude from snapping (e.g. other selected walls). */
  snapExcludeIds: ContractId[] = [];

  /** Endpoint coordinate captured when drag starts (before any movement). */
  private preDragEndpoint: [number, number, number] | null = null;
  /** Full contract snapshot at drag start — used as contractOverride so snap
   *  sees the wall's original position (frozen) instead of excluding it. */
  private preDragContract: WallContract | null = null;

  get activeTarget(): DragTarget {
    return this._activeTarget;
  }

  /** The endpoint position before drag started (null if not dragging start/end). */
  getPreDragEndpoint(): [number, number, number] | null {
    return this.preDragEndpoint;
  }

  constructor(scene: THREE.Scene, doc: BimDocument, engine: GeometryEngine, contract: AnyContract) {
    this.scene = scene;
    this.doc = doc;
    this.engine = engine;
    this.contract = contract as WallContract;

    const sphereGeo = new THREE.SphereGeometry(0.12, 12, 12);
    const coneGeo = new THREE.ConeGeometry(0.1, 0.25, 12);

    const s = new THREE.Vector3(...this.contract.start);
    const e = new THREE.Vector3(...this.contract.end);
    const mid = s.clone().add(e).multiplyScalar(0.5);
    mid.y = this.contract.start[1] + resolveWallParams(this.contract, this.doc).height;

    this.startHandle = new HandleMesh(sphereGeo, 0x00cc44, s);
    this.endHandle = new HandleMesh(sphereGeo.clone(), 0x00cc44, e);
    this.heightHandle = new HandleMesh(coneGeo, 0xcc4400, mid);
    this.snapIndicator = new SnapIndicator(scene);

    scene.add(this.startHandle.mesh);
    scene.add(this.endHandle.mesh);
    scene.add(this.heightHandle.mesh);
  }

  checkHit(
    event: PointerEvent,
    toolMgr: ToolManager,
    _camera: THREE.PerspectiveCamera
  ): boolean {
    const handleObjects = [
      this.startHandle.mesh,
      this.endHandle.mesh,
      this.heightHandle.mesh,
    ];
    const hits = toolMgr.raycastObjects(event, handleObjects);
    if (hits.length === 0) return false;

    const hitObj = hits[0].object;
    if (hitObj === this.startHandle.mesh) {
      this._activeTarget = "start";
      this.preDragEndpoint = [...this.contract.start];
      this.preDragContract = { ...this.contract };
    } else if (hitObj === this.endHandle.mesh) {
      this._activeTarget = "end";
      this.preDragEndpoint = [...this.contract.end];
      this.preDragContract = { ...this.contract };
    } else if (hitObj === this.heightHandle.mesh) {
      this._activeTarget = "height";
      this.preDragEndpoint = null;
      this.preDragContract = null;
    } else {
      return false;
    }

    // Hide the active handle during drag so snap indicator is visible
    const activeHandle =
      this._activeTarget === "start" ? this.startHandle :
      this._activeTarget === "end" ? this.endHandle :
      this._activeTarget === "height" ? this.heightHandle : null;
    if (activeHandle) activeHandle.mesh.visible = false;

    return true;
  }

  onDrag(groundPoint: THREE.Vector3) {
    if (!this._activeTarget) return;

    if (this._activeTarget === "start" || this._activeTarget === "end") {
      // Anchor = the opposite endpoint (for perpendicular/extension snaps)
      const anchor = this._activeTarget === "start"
        ? new THREE.Vector3(...this.contract.end)
        : new THREE.Vector3(...this.contract.start);
      // Override the wall's contract with its pre-drag snapshot so snap sees
      // the original position (frozen), rather than excluding the wall entirely.
      const contractOverrides = this.preDragContract
        ? new Map<ContractId, AnyContract>([[this.contract.id, this.preDragContract]])
        : undefined;
      const result = snapPoint(groundPoint, this.doc, {
        excludeIds: this.snapExcludeIds,
        contractOverrides,
        anchor,
      });
      recordStickySnap(result);
      this.snapIndicator.update(result);
      const snapped = result.position;

      const tJunction =
        result.type === "edgeBody" && result.targetId
          ? result.targetId
          : undefined;

      if (this._activeTarget === "start") {
        this.startHandle.setPosition(snapped);
        this.contract = {
          ...this.contract,
          start: [snapped.x, snapped.y, snapped.z],
          startTJunction: tJunction,
        };
      } else {
        this.endHandle.setPosition(snapped);
        this.contract = {
          ...this.contract,
          end: [snapped.x, snapped.y, snapped.z],
          endTJunction: tJunction,
        };
      }
    } else if (this._activeTarget === "height") {
      const step = 0.1;
      const baseY = this.contract.start[1];
      const newHeight = Math.max(0.5, Math.round((groundPoint.y - baseY) / step) * step);
      const s = new THREE.Vector3(...this.contract.start);
      const e = new THREE.Vector3(...this.contract.end);
      const mid = s.clone().add(e).multiplyScalar(0.5);
      mid.y = baseY + newHeight;
      this.heightHandle.setPosition(mid);
      this.contract = { ...this.contract, height: newHeight };
    }

    // Update document → triggers overlay update (instant, no fragment edit)
    this.doc.update(this.contract.id, this.contract);
  }

  onDragEnd() {
    if (!this._activeTarget) return;
    // Show the handle again
    const activeHandle =
      this._activeTarget === "start" ? this.startHandle :
      this._activeTarget === "end" ? this.endHandle :
      this._activeTarget === "height" ? this.heightHandle : null;
    if (activeHandle) activeHandle.mesh.visible = true;
    // Contract already updated during drag via doc.update()
    this._activeTarget = null;
    this.preDragEndpoint = null;
    this.snapIndicator.hide();
  }

  /** Update handle positions after external contract change */
  updateFromContract(contract: WallContract) {
    this.contract = contract;
    const s = new THREE.Vector3(...contract.start);
    const e = new THREE.Vector3(...contract.end);
    const mid = s.clone().add(e).multiplyScalar(0.5);
    mid.y = contract.start[1] + resolveWallParams(contract, this.doc).height;

    this.startHandle.setPosition(s);
    this.endHandle.setPosition(e);
    this.heightHandle.setPosition(mid);
  }

  dispose() {
    this.scene.remove(this.startHandle.mesh);
    this.scene.remove(this.endHandle.mesh);
    this.scene.remove(this.heightHandle.mesh);
    this.startHandle.dispose();
    this.endHandle.dispose();
    this.heightHandle.dispose();
    this.snapIndicator.dispose();
  }
}
