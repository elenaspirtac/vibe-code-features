import * as THREE from "three";
import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";
import type { ToolManager } from "../tools/tool-manager";
import { HandleMesh } from "./base";
import { snapPoint, SnapIndicator, recordStickySnap } from "../utils/snap";
import type { ColumnContract } from "../elements/column";
import type { ElementHandles } from "../core/registry";

export class ColumnHandles implements ElementHandles {
  contract: ColumnContract;
  activeTarget: string | null = null;
  snapExcludeIds: ContractId[] = [];

  private baseHandle: HandleMesh;
  private snapIndicator: SnapIndicator;
  private doc: BimDocument;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene, doc: BimDocument, contract: ColumnContract) {
    this.scene = scene;
    this.doc = doc;
    this.contract = contract;

    const base = new THREE.Vector3(...contract.base);
    const sphereGeo = new THREE.SphereGeometry(0.15, 12, 12);
    this.baseHandle = new HandleMesh(sphereGeo, 0x44ff44, base);
    this.snapIndicator = new SnapIndicator(scene);

    scene.add(this.baseHandle.mesh);
  }

  checkHit(
    event: PointerEvent,
    toolMgr: ToolManager,
    _camera: THREE.PerspectiveCamera
  ): boolean {
    const hits = toolMgr.raycastObjects(event, [this.baseHandle.mesh]);
    if (hits.length === 0) return false;
    this.activeTarget = "base";
    this.baseHandle.mesh.visible = false;
    return true;
  }

  onDrag(groundPoint: THREE.Vector3) {
    if (!this.activeTarget) return;

    const result = snapPoint(groundPoint, this.doc, {
      excludeIds: [this.contract.id, ...this.snapExcludeIds],
    });
    recordStickySnap(result);
    this.snapIndicator.update(result);
    const snapped = result.position;

    this.contract = {
      ...this.contract,
      base: [snapped.x, snapped.y, snapped.z],
    };
    this.doc.update(this.contract.id, this.contract);
    this.baseHandle.setPosition(snapped);
  }

  onDragEnd() {
    if (!this.activeTarget) return;
    this.baseHandle.mesh.visible = true;
    this.activeTarget = null;
    this.snapIndicator.hide();
  }

  updateFromContract(contract: AnyContract) {
    this.contract = contract as ColumnContract;
    const base = new THREE.Vector3(...this.contract.base);
    this.baseHandle.setPosition(base);
  }

  dispose() {
    this.scene.remove(this.baseHandle.mesh);
    this.baseHandle.dispose();
    this.snapIndicator.dispose();
  }
}
