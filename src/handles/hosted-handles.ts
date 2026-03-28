import * as THREE from "three";
import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";
import type { ToolManager } from "../tools/tool-manager";
import type { ElementHandles } from "../core/registry";
import type { WallContract } from "../elements/wall";
import { resolveWallParams } from "../elements/wall";
import { HandleMesh } from "./base";

/** Contract shape shared by windows and doors (both have hostId + position). */
interface HostedContract extends AnyContract {
  hostId: ContractId;
  position: number;
}

/**
 * Drag handle for hosted elements (windows, doors).
 * Shows a single handle at the element center; dragging slides it along the host wall.
 */
export class HostedElementHandles implements ElementHandles {
  contract: HostedContract;
  activeTarget: string | null = null;
  snapExcludeIds: ContractId[] = [];

  private handle: HandleMesh;
  private doc: BimDocument;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private container: HTMLElement;

  /** Cached Y offset from wall base to element center (set on construction + update). */
  private yOffset: number;

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  constructor(
    scene: THREE.Scene,
    doc: BimDocument,
    contract: AnyContract,
    yOffset: number,
    camera: THREE.PerspectiveCamera,
    container: HTMLElement
  ) {
    this.scene = scene;
    this.doc = doc;
    this.contract = contract as HostedContract;
    this.yOffset = yOffset;
    this.camera = camera;
    this.container = container;

    const sphereGeo = new THREE.SphereGeometry(0.12, 12, 12);
    const pos = this.computeHandlePosition();
    this.handle = new HandleMesh(sphereGeo, 0x44aaff, pos);
    scene.add(this.handle.mesh);
  }

  checkHit(
    event: PointerEvent,
    toolMgr: ToolManager,
    _camera: THREE.PerspectiveCamera
  ): boolean {
    const hits = toolMgr.raycastObjects(event, [this.handle.mesh]);
    if (hits.length === 0) return false;
    this.activeTarget = "position";
    this.handle.mesh.visible = false;
    return true;
  }

  onDrag(_groundPoint: THREE.Vector3, event: PointerEvent) {
    if (!this.activeTarget) return;

    const host = this.doc.contracts.get(this.contract.hostId) as WallContract | undefined;
    if (!host) return;

    // Build camera ray from the pointer event
    const rect = this.container.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Intersect the camera ray with the wall's near face — the same surface
    // the placement tool raycasts. This avoids parallax from wall thickness.
    const s = new THREE.Vector3(...host.start);
    const e = new THREE.Vector3(...host.end);
    const wallDir = new THREE.Vector3().subVectors(e, s);
    const wallLen = wallDir.length();
    wallDir.normalize();

    // Wall normal: perpendicular to wall direction in XZ
    const wallNormal = new THREE.Vector3(-wallDir.z, 0, wallDir.x);

    // Pick the face that faces the camera
    const ray = this.raycaster.ray;
    const camToWall = new THREE.Vector3().subVectors(s, ray.origin);
    if (camToWall.dot(wallNormal) > 0) wallNormal.negate();

    // Offset centerline by half thickness to get the near face
    const { thickness } = resolveWallParams(host, this.doc);
    const halfThick = thickness / 2;
    const facePoint = s.clone().addScaledVector(wallNormal, -halfThick);
    const wallPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(wallNormal, facePoint);

    const hitPoint = new THREE.Vector3();
    const hit = ray.intersectPlane(wallPlane, hitPoint);

    let t: number;
    if (!hit) {
      // Ray parallel to wall plane — fall back to ground point
      const hitToStart = new THREE.Vector3().subVectors(_groundPoint, s);
      t = hitToStart.dot(wallDir) / wallLen;
    } else {
      const hitToStart = new THREE.Vector3().subVectors(hitPoint, s);
      t = hitToStart.dot(wallDir) / wallLen;
    }

    const position = Math.max(0.05, Math.min(0.95, t));

    this.contract = { ...this.contract, position };
    this.doc.update(this.contract.id, this.contract);
    this.handle.setPosition(this.computeHandlePosition());
  }

  onDragEnd() {
    if (!this.activeTarget) return;
    this.handle.mesh.visible = true;
    this.activeTarget = null;
  }

  updateFromContract(contract: AnyContract) {
    this.contract = contract as HostedContract;
    this.handle.setPosition(this.computeHandlePosition());
  }

  dispose() {
    this.scene.remove(this.handle.mesh);
    this.handle.dispose();
  }

  /** Compute handle world position from host wall + position param. */
  private computeHandlePosition(): THREE.Vector3 {
    const host = this.doc.contracts.get(this.contract.hostId) as WallContract | undefined;
    if (!host) return new THREE.Vector3();
    const s = new THREE.Vector3(...host.start);
    const e = new THREE.Vector3(...host.end);
    const pos = new THREE.Vector3().lerpVectors(s, e, this.contract.position);
    pos.y = host.start[1] + this.yOffset;
    return pos;
  }
}
