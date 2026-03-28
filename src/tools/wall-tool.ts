import * as THREE from "three";
import type { Tool, ToolManager } from "./tool-manager";
import type { BimDocument } from "../core/document";
import type { ContractId } from "../core/contracts";
import { createWall } from "../elements/wall";
import type { WallTypeContract } from "../elements/wall-type";
import { isLevel } from "../elements/level";
import type { LevelContract } from "../elements/level";
import type { GeometryEngine } from "@thatopen/fragments";
import type { FragmentSync } from "../fragments/sync";
import { snapPoint, SnapIndicator, recordStickySnap, clearStickySnaps } from "../utils/snap";
import type { TempDimensionRenderer } from "../ui/temp-dimensions";
import { PREVIEW_MATERIAL } from "../utils/material-resolve";

export class WallTool implements Tool {
  name = "wall";
  typeKind = "wallType";

  private scene: THREE.Scene;
  private doc: BimDocument;
  private engine: GeometryEngine;
  private toolMgr: ToolManager;
  private sync: FragmentSync;
  private tempDims: TempDimensionRenderer | null = null;

  private startPoint: THREE.Vector3 | null = null;
  private startSnapTargetId: string | undefined = undefined;
  private startSnapType: string | undefined = undefined;
  private previewMesh: THREE.Mesh | null = null;
  private startMarker: THREE.Mesh | null = null;
  private snapIndicator: SnapIndicator;

  /** Active wall type ID — must be set before placing walls. */
  typeId: ContractId | null = null;
  levelId: ContractId | null = null;

  constructor(
    scene: THREE.Scene,
    doc: BimDocument,
    engine: GeometryEngine,
    toolMgr: ToolManager,
    sync: FragmentSync,
    tempDims?: TempDimensionRenderer
  ) {
    this.scene = scene;
    this.doc = doc;
    this.engine = engine;
    this.toolMgr = toolMgr;
    this.sync = sync;
    this.tempDims = tempDims ?? null;
    this.snapIndicator = new SnapIndicator(scene);
  }

  activate() {
    document.body.style.cursor = "crosshair";
  }

  deactivate() {
    document.body.style.cursor = "default";
    this.clearPreview();
    this.snapIndicator.hide();
    this.tempDims?.showCreationDimension(null);
    this.startPoint = null;
    clearStickySnaps();
  }

  onPointerDown(event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (event.button !== 0 || !intersection) return;

    const result = snapPoint(intersection, this.doc, {
      anchor: this.startPoint ?? undefined,
      shiftKey: event.shiftKey,
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    const snapped = result.position;

    if (!this.startPoint) {
      // First click — set start
      this.startPoint = snapped.clone();
      this.startSnapTargetId = result.type === "edgeBody" ? result.targetId : undefined;
      this.startSnapType = result.type;
      this.showStartMarker(snapped);
    } else {
      // Second click — commit wall
      const start: [number, number, number] = [
        this.startPoint.x,
        this.startPoint.y,
        this.startPoint.z,
      ];
      const end: [number, number, number] = [snapped.x, snapped.y, snapped.z];

      // Don't create zero-length walls
      if (this.startPoint.distanceTo(snapped) < 0.1) return;

      if (!this.typeId) return; // no type selected
      const wall = createWall(start, end, this.typeId);
      if (this.levelId) {
        wall.levelId = this.levelId;
        // Constrain to next level above — height spans between levels
        const topLevel = this.findNextLevelAbove(this.levelId);
        if (topLevel) {
          wall.topLevelId = topLevel.id;
          const baseLevel = this.doc.contracts.get(this.levelId) as LevelContract | undefined;
          if (baseLevel && isLevel(baseLevel)) {
            wall.height = topLevel.elevation - baseLevel.elevation;
          }
        }
      }

      // Record T-junction relationships from snap
      if (this.startSnapType === "edgeBody" && this.startSnapTargetId) {
        wall.startTJunction = this.startSnapTargetId;
      }
      if (result.type === "edgeBody" && result.targetId) {
        wall.endTJunction = result.targetId;
      }

      this.clearPreview();
      this.doc.add(wall);

      // Reset for next wall (chain from end point)
      this.startPoint = snapped.clone();
      this.startSnapTargetId = result.type === "edgeBody" ? result.targetId : undefined;
      this.startSnapType = result.type;
      this.showStartMarker(snapped);
    }
  }

  onPointerMove(event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (!intersection) {
      this.snapIndicator.hide();
      this.toolMgr.hideCursor();
      return;
    }
    const result = snapPoint(intersection, this.doc, {
      anchor: this.startPoint ?? undefined,
      shiftKey: event.shiftKey,
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    recordStickySnap(result);
    this.snapIndicator.update(result);
    this.toolMgr.setCursorPosition(result.position);
    if (!this.startPoint) {
      this.tempDims?.showCreationDimension(null);
      return;
    }
    this.updatePreview(this.startPoint, result.position);
    this.tempDims?.showCreationDimension(this.startPoint, result.position);
  }

  onPointerUp(_event: PointerEvent) {}

  onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      this.clearPreview();
      this.startPoint = null;
    }
  }

  private updatePreview(start: THREE.Vector3, end: THREE.Vector3) {
    if (start.distanceTo(end) < 0.05) return;

    if (!this.previewMesh) {
      const geo = new THREE.BufferGeometry();
      this.previewMesh = new THREE.Mesh(geo, PREVIEW_MATERIAL);
      this.scene.add(this.previewMesh);
    }

    // Read params from active type, with level constraint override
    const typeContract = this.typeId ? this.doc.contracts.get(this.typeId) as WallTypeContract | undefined : undefined;
    let height = typeContract?.height ?? 3.0;
    const thickness = typeContract?.thickness ?? 0.2;
    if (this.levelId) {
      const topLevel = this.findNextLevelAbove(this.levelId);
      const baseLevel = this.doc.contracts.get(this.levelId) as LevelContract | undefined;
      if (topLevel && baseLevel && isLevel(baseLevel)) {
        height = topLevel.elevation - baseLevel.elevation;
      }
    }

    // Use the geometry engine to generate the preview wall
    const geo = this.previewMesh.geometry;
    this.engine.getWall(geo, {
      start: [start.x, start.y, start.z],
      end: [end.x, end.y, end.z],
      height,
      thickness,
      offset: 0,
      elevation: start.y,
      direction: [0, 1, 0],
    });
  }

  private showStartMarker(position: THREE.Vector3) {
    if (!this.startMarker) {
      const geo = new THREE.SphereGeometry(0.08, 12, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00aaff });
      this.startMarker = new THREE.Mesh(geo, mat);
      this.scene.add(this.startMarker);
    }
    this.startMarker.position.copy(position);
    this.startMarker.visible = true;
  }

  /** Find the next level above the given level (by elevation). */
  private findNextLevelAbove(levelId: ContractId): LevelContract | null {
    const baseLevel = this.doc.contracts.get(levelId) as LevelContract | undefined;
    if (!baseLevel || !isLevel(baseLevel)) return null;

    let closest: LevelContract | null = null;
    for (const [, c] of this.doc.contracts) {
      if (!isLevel(c) || c.id === levelId) continue;
      if (c.elevation > baseLevel.elevation) {
        if (!closest || c.elevation < closest.elevation) {
          closest = c;
        }
      }
    }
    return closest;
  }

  private clearPreview() {
    if (this.previewMesh) {
      this.scene.remove(this.previewMesh);
      this.previewMesh.geometry.dispose();
      this.previewMesh = null;
    }
    if (this.startMarker) {
      this.startMarker.visible = false;
    }
  }
}
