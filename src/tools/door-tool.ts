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

  /** Active door type ID — must be set before placing doors. */
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

  activate() {
    document.body.style.cursor = "crosshair";
  }

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
    this.toolMgr.hideCursor();
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
      width,
      height,
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
