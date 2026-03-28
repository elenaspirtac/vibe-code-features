import * as THREE from "three";
import type { Tool, ToolManager } from "./tool-manager";
import type { BimDocument } from "../core/document";
import type { ContractId } from "../core/contracts";
import type { ColumnTypeContract } from "../elements/column-type";
import { createColumn } from "../elements/column";
import { snapPoint, SnapIndicator, recordStickySnap } from "../utils/snap";
import { PREVIEW_MATERIAL } from "../utils/material-resolve";

export class ColumnTool implements Tool {
  name = "column";
  typeKind = "columnType";
  private doc: BimDocument;
  private scene: THREE.Scene;
  private toolMgr: ToolManager;
  private snapIndicator: SnapIndicator;
  private preview: THREE.Mesh | null = null;

  /** Active column type ID — must be set before placing columns. */
  typeId: ContractId | null = null;
  levelId: ContractId | null = null;

  constructor(doc: BimDocument, scene: THREE.Scene, toolMgr: ToolManager) {
    this.doc = doc;
    this.scene = scene;
    this.toolMgr = toolMgr;
    this.snapIndicator = new SnapIndicator(scene);
  }

  activate() {
    document.body.style.cursor = "crosshair";
  }

  deactivate() {
    document.body.style.cursor = "default";
    this.snapIndicator.hide();
    this.clearPreview();
  }

  onPointerDown(event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (event.button !== 0 || !intersection || !this.typeId) return;

    const result = snapPoint(intersection, this.doc, {
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    const pos = result.position;

    const column = createColumn([pos.x, pos.y, pos.z], this.typeId);
    if (this.levelId) column.levelId = this.levelId;

    this.clearPreview();
    this.doc.add(column);
  }

  onPointerMove(_event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (!intersection) {
      this.snapIndicator.hide();
      this.toolMgr.hideCursor();
      this.clearPreview();
      return;
    }

    const result = snapPoint(intersection, this.doc, {
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    recordStickySnap(result);
    this.snapIndicator.update(result);
    this.toolMgr.setCursorPosition(result.position);
    this.updatePreview(result.position);
  }

  onPointerUp() {}
  onKeyDown() {}

  private updatePreview(pos: THREE.Vector3) {
    const typeContract = this.typeId ? this.doc.contracts.get(this.typeId) as ColumnTypeContract | undefined : undefined;
    const height = typeContract?.height ?? 3.0;
    const width = typeContract?.width ?? 0.3;

    if (!this.preview) {
      const geo = new THREE.BoxGeometry(width, height, width);
      this.preview = new THREE.Mesh(geo, PREVIEW_MATERIAL);
      this.preview.renderOrder = 5;
      this.scene.add(this.preview);
    } else {
      // Recreate geometry if type params changed
      this.preview.geometry.dispose();
      this.preview.geometry = new THREE.BoxGeometry(width, height, width);
    }
    this.preview.position.set(pos.x, pos.y + height / 2, pos.z);
  }

  private clearPreview() {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview.geometry.dispose();
      this.preview = null;
    }
  }
}
