import * as THREE from "three";
import type { Tool, ToolManager } from "./tool-manager";
import type { BimDocument } from "../core/document";
import type { GeometryEngine } from "@thatopen/fragments";
import type { FragmentSync } from "../fragments/sync";
import { createFloor, type FloorBoundaryVertex } from "../elements/floor";
import { snapPoint, SnapIndicator, recordStickySnap, clearStickySnaps } from "../utils/snap";

export class FloorTool implements Tool {
  name = "floor";
  levelId: string | null = null;

  private scene: THREE.Scene;
  private doc: BimDocument;
  private engine: GeometryEngine;
  private toolMgr: ToolManager;
  private sync: FragmentSync;

  private vertices: FloorBoundaryVertex[] = [];
  private positions: THREE.Vector3[] = [];
  private previewLine: THREE.Line | null = null;
  private vertexMarkers: THREE.Mesh[] = [];
  private snapIndicator: SnapIndicator;

  constructor(
    scene: THREE.Scene,
    doc: BimDocument,
    engine: GeometryEngine,
    toolMgr: ToolManager,
    sync: FragmentSync
  ) {
    this.scene = scene;
    this.doc = doc;
    this.engine = engine;
    this.toolMgr = toolMgr;
    this.sync = sync;
    this.snapIndicator = new SnapIndicator(scene);
  }

  activate() {
    document.body.style.cursor = "crosshair";
  }

  deactivate() {
    document.body.style.cursor = "default";
    this.clearPreview();
    this.snapIndicator.hide();
    this.reset();
    clearStickySnaps();
  }

  onPointerDown(event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (event.button !== 0 || !intersection) return;

    const result = snapPoint(intersection, this.doc, {
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    const snapped = result.position;

    // Check if closing the polygon (click near first point, ≥3 points)
    if (this.positions.length >= 3) {
      const first = this.positions[0];
      if (snapped.distanceTo(first) < 0.3) {
        this.commitFloor();
        return;
      }
    }

    // Build boundary vertex from snap result
    let vertex: FloorBoundaryVertex;
    if (result.type === "endpoint" && result.targetId) {
      // Use registry to find which endpoint was snapped to
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

    this.vertices.push(vertex);
    this.positions.push(snapped.clone());
    this.addVertexMarker(snapped);
    this.updatePreviewLine(snapped);
  }

  onPointerMove(_event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (!intersection) {
      this.snapIndicator.hide();
      this.toolMgr.hideCursor();
      return;
    }
    const result = snapPoint(intersection, this.doc, {
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    recordStickySnap(result);
    this.snapIndicator.update(result);
    this.toolMgr.setCursorPosition(result.position);

    if (this.positions.length > 0) {
      this.updatePreviewLine(result.position);
    }
  }

  onPointerUp(_event: PointerEvent) {}

  onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      this.clearPreview();
      this.reset();
    } else if (event.key === "Enter") {
      if (this.vertices.length >= 3) {
        this.commitFloor();
      }
    }
  }

  private commitFloor() {
    const elevation = this.toolMgr.workPlane.origin.y;
    const floor = createFloor([...this.vertices], { elevation });
    if (this.levelId) floor.levelId = this.levelId;
    this.clearPreview();
    this.doc.add(floor);
    this.reset();
  }

  private reset() {
    this.vertices = [];
    this.positions = [];
  }

  private addVertexMarker(position: THREE.Vector3) {
    const geo = new THREE.SphereGeometry(0.08, 12, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x44cc88,
      depthTest: false,
    });
    const marker = new THREE.Mesh(geo, mat);
    marker.position.copy(position);
    marker.renderOrder = 10;
    this.scene.add(marker);
    this.vertexMarkers.push(marker);
  }

  private updatePreviewLine(cursorPos: THREE.Vector3) {
    // Remove old line
    if (this.previewLine) {
      this.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      (this.previewLine.material as THREE.Material).dispose();
      this.previewLine = null;
    }

    if (this.positions.length === 0) return;

    // Build polyline: all clicked positions + cursor + close to first
    const linePoints = [
      ...this.positions.map((p) => p.clone()),
      cursorPos.clone(),
    ];
    // Add closing line back to first point for visual feedback
    if (this.positions.length >= 2) {
      linePoints.push(this.positions[0].clone());
    }

    // Lift slightly above ground to avoid z-fighting
    for (const p of linePoints) p.y += 0.01;

    const geo = new THREE.BufferGeometry().setFromPoints(linePoints);
    const mat = new THREE.LineBasicMaterial({
      color: 0x44cc88,
      depthTest: false,
    });
    this.previewLine = new THREE.Line(geo, mat);
    this.previewLine.renderOrder = 10;
    this.scene.add(this.previewLine);
  }

  private clearPreview() {
    if (this.previewLine) {
      this.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      (this.previewLine.material as THREE.Material).dispose();
      this.previewLine = null;
    }
    for (const marker of this.vertexMarkers) {
      this.scene.remove(marker);
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
    }
    this.vertexMarkers = [];
  }
}
