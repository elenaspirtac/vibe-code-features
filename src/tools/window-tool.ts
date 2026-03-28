import * as THREE from "three";
import type { GeometryEngine } from "@thatopen/fragments";
import type { Tool, ToolManager } from "./tool-manager";
import type { BimDocument } from "../core/document";
import type { FragmentManager } from "../fragments/manager";
import type { ContractId } from "../core/contracts";
import { isWall, resolveWallParams } from "../elements/wall";
import type { WallContract, ResolvedWall } from "../elements/wall";
import { createWindow } from "../elements/window";
import type { ResolvedWindow } from "../elements/window";
import type { WindowTypeContract } from "../elements/window-type";
import { generateWindowGeometry } from "../generators/window";
import { PREVIEW_MATERIAL } from "../utils/material-resolve";

export class WindowTool implements Tool {
  name = "window";
  typeKind = "windowType";

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

  /** Active window type ID — must be set before placing windows. */
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

    const wall = this.hoveredWall;
    const pos = this.hoveredPosition;

    // Create window contract
    const win = createWindow(wall.id, pos, this.typeId);

    // Add window — the wall's hosted elements are derived from
    // querying contracts by hostId, no manual bookkeeping needed.
    this.doc.add(win);

    this.clearPreview();
  }

  async onPointerMove(event: PointerEvent, _intersection: THREE.Vector3 | null) {
    this.toolMgr.hideCursor();
    // Raycast fragments to find walls
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
    const canvas = this.canvas;
    const camera = this.camera;
    const mouse = new THREE.Vector2(event.clientX, event.clientY);
    const data = { camera, mouse, dom: canvas };

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

    // Compute position parameter: project hit point onto wall centerline
    const wall = contract;
    const s = new THREE.Vector3(...wall.start);
    const e = new THREE.Vector3(...wall.end);
    const wallDir = new THREE.Vector3().subVectors(e, s);
    const wallLen = wallDir.length();
    wallDir.normalize();

    const hitToStart = new THREE.Vector3().subVectors(best.point, s);
    const t = hitToStart.dot(wallDir) / wallLen;
    const position = Math.max(0.05, Math.min(0.95, t)); // clamp away from edges

    return { wall, position, point: best.point };
  }

  private updatePreview(wall: WallContract, position: number) {
    // Read params from active type
    const typeContract = this.typeId ? this.doc.contracts.get(this.typeId) as WindowTypeContract | undefined : undefined;
    const width = typeContract?.width ?? 1.2;
    const height = typeContract?.height ?? 1.0;
    const sillHeight = typeContract?.sillHeight ?? 1.0;

    // Create a temporary resolved window for preview geometry
    const tempWin = createWindow(wall.id, position, this.typeId ?? "preview", {
      width, height, sillHeight,
    }) as ResolvedWindow;

    // Resolve host wall params for the generator
    const wallParams = resolveWallParams(wall, this.doc);
    const resolvedWall: ResolvedWall = { ...wall, height: wallParams.height, thickness: wallParams.thickness };

    const geo = generateWindowGeometry(tempWin, resolvedWall);

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
