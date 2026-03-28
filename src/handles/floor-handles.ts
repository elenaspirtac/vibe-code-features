import * as THREE from "three";
import type { GeometryEngine } from "@thatopen/fragments";
import type { BimDocument } from "../core/document";
import type { AnyContract } from "../core/contracts";
import type { FloorContract, FloorBoundaryVertex } from "../elements/floor";
import type { ToolManager } from "../tools/tool-manager";
import { HandleMesh } from "./base";
import { snapPoint, SnapIndicator, recordStickySnap } from "../utils/snap";
import { resolveBoundary } from "../generators/floor";

export class FloorHandles {
  private scene: THREE.Scene;
  private doc: BimDocument;
  private engine: GeometryEngine;
  contract: FloorContract;

  private vertexHandles: HandleMesh[] = [];
  private profileLine: THREE.Line | null = null;
  private _activeTarget: string | null = null;
  private snapIndicator: SnapIndicator;

  get activeTarget(): string | null {
    return this._activeTarget;
  }

  constructor(
    scene: THREE.Scene,
    doc: BimDocument,
    engine: GeometryEngine,
    contract: FloorContract
  ) {
    this.scene = scene;
    this.doc = doc;
    this.engine = engine;
    this.contract = contract;
    this.snapIndicator = new SnapIndicator(scene);

    this.buildHandles();
    this.buildProfileLine();
  }

  checkHit(
    event: PointerEvent,
    toolMgr: ToolManager,
    _camera: THREE.PerspectiveCamera
  ): boolean {
    const meshes = this.vertexHandles.map((h) => h.mesh);
    const hits = toolMgr.raycastObjects(event, meshes);
    if (hits.length === 0) return false;

    const hitObj = hits[0].object;
    const idx = meshes.indexOf(hitObj as THREE.Mesh);
    if (idx < 0) return false;

    this._activeTarget = `v${idx}`;
    return true;
  }

  onDrag(groundPoint: THREE.Vector3) {
    if (!this._activeTarget) return;

    const idx = parseInt(this._activeTarget.slice(1), 10);
    if (isNaN(idx) || idx < 0 || idx >= this.contract.boundary.length) return;

    const result = snapPoint(groundPoint, this.doc);
    recordStickySnap(result);
    this.snapIndicator.update(result);
    const snapped = result.position;

    // Build new boundary vertex based on snap result
    let vertex: FloorBoundaryVertex;
    if (result.type === "endpoint" && result.targetId) {
      const ref = this.doc.contracts.get(result.targetId);
      const reg = this.doc.registry;
      const def = ref && reg ? reg.get(ref.kind) : undefined;
      const edges = def?.getLinearEdges?.(ref!, this.doc);
      let matchedEndpoint: string | null = null;
      if (edges) {
        let bestDist = Infinity;
        for (const edge of edges) {
          const ds = snapped.distanceTo(new THREE.Vector3(...edge.start));
          if (ds < bestDist) { bestDist = ds; matchedEndpoint = edge.startId; }
          const de = snapped.distanceTo(new THREE.Vector3(...edge.end));
          if (de < bestDist) { bestDist = de; matchedEndpoint = edge.endId; }
        }
      }
      if (matchedEndpoint) {
        vertex = { type: "wallEndpoint", wallId: result.targetId, endpoint: matchedEndpoint as "start" | "end" };
      } else {
        vertex = { type: "free", position: [snapped.x, snapped.y, snapped.z] };
      }
    } else {
      vertex = { type: "free", position: [snapped.x, snapped.y, snapped.z] };
    }

    // Update boundary
    const newBoundary = [...this.contract.boundary];
    newBoundary[idx] = vertex;
    this.contract = { ...this.contract, boundary: newBoundary };

    // Update handle position
    this.vertexHandles[idx].setPosition(snapped);
    this.updateProfileLine();

    // Sync to document
    this.doc.update(this.contract.id, this.contract);
  }

  onDragEnd() {
    if (!this._activeTarget) return;
    this._activeTarget = null;
    this.snapIndicator.hide();
  }

  updateFromContract(contract: AnyContract) {
    this.contract = contract as FloorContract;

    const points = resolveBoundary(this.contract, this.doc);
    if (!points) return;

    // If vertex count changed, rebuild handles entirely
    if (points.length !== this.vertexHandles.length) {
      this.disposeHandles();
      this.buildHandles();
      this.updateProfileLine();
      return;
    }

    // Update positions
    for (let i = 0; i < points.length; i++) {
      this.vertexHandles[i].setPosition(new THREE.Vector3(...points[i]));
    }
    this.updateProfileLine();
  }

  dispose() {
    this.disposeHandles();
    this.disposeProfileLine();
    this.snapIndicator.dispose();
  }

  // ── Private ──────────────────────────────────────────────────────

  private buildHandles() {
    const points = resolveBoundary(this.contract, this.doc);
    if (!points) return;

    const sphereGeo = new THREE.SphereGeometry(0.12, 12, 12);

    for (let i = 0; i < points.length; i++) {
      const pos = new THREE.Vector3(...points[i]);
      const handle = new HandleMesh(
        i === 0 ? sphereGeo : sphereGeo.clone(),
        0x44cc88,
        pos
      );
      this.scene.add(handle.mesh);
      this.vertexHandles.push(handle);
    }
  }

  private disposeHandles() {
    for (const handle of this.vertexHandles) {
      this.scene.remove(handle.mesh);
      handle.dispose();
    }
    this.vertexHandles = [];
  }

  private buildProfileLine() {
    this.disposeProfileLine();

    const points = resolveBoundary(this.contract, this.doc);
    if (!points || points.length < 2) return;

    // Closed loop
    const linePoints = points.map(
      ([x, y, z]) => new THREE.Vector3(x, y + 0.01, z)
    );
    linePoints.push(linePoints[0].clone());

    const geo = new THREE.BufferGeometry().setFromPoints(linePoints);
    const mat = new THREE.LineBasicMaterial({
      color: 0x44cc88,
      depthTest: false,
    });
    this.profileLine = new THREE.Line(geo, mat);
    this.profileLine.renderOrder = 10;
    this.scene.add(this.profileLine);
  }

  private updateProfileLine() {
    const points = resolveBoundary(this.contract, this.doc);
    if (!points || points.length < 2) return;

    if (this.profileLine) {
      const linePoints = points.map(
        ([x, y, z]) => new THREE.Vector3(x, y + 0.01, z)
      );
      linePoints.push(linePoints[0].clone());

      this.profileLine.geometry.dispose();
      this.profileLine.geometry =
        new THREE.BufferGeometry().setFromPoints(linePoints);
    } else {
      this.buildProfileLine();
    }
  }

  private disposeProfileLine() {
    if (this.profileLine) {
      this.scene.remove(this.profileLine);
      this.profileLine.geometry.dispose();
      (this.profileLine.material as THREE.Material).dispose();
      this.profileLine = null;
    }
  }
}
