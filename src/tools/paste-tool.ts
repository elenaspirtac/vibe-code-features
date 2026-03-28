import * as THREE from "three";
import type { Tool, ToolManager } from "./tool-manager";
import type { SelectTool } from "./select-tool";
import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";
import type { ElementRegistry } from "../core/registry";
import type { FragmentSync } from "../fragments/sync";
import type { ModelClipboard } from "../utils/clipboard";
import { snapPoint, SnapIndicator, recordStickySnap } from "../utils/snap";

/**
 * Paste placement tool (1.18): two-click workflow to place cloned elements.
 *
 * Workflow:
 * 1. Ctrl+V activates this tool with a preview at the cursor
 * 2. Click to pick a base point on the preview (snapped)
 * 3. Move cursor — preview translates relative to base point
 * 4. Click to commit — adds all clones in one transaction
 * 5. Escape to cancel (at any stage)
 */
export class PasteTool implements Tool {
  name = "paste";
  typeId: ContractId | null = null;
  levelId: ContractId | null = null;

  private scene: THREE.Scene;
  private doc: BimDocument;
  private toolMgr: ToolManager;
  private sync: FragmentSync;
  private registry: ElementRegistry;
  private selectTool: SelectTool;
  private clipboard: ModelClipboard;

  private snapIndicator: SnapIndicator;

  /** Translucent preview meshes shown during placement. */
  private previewMeshes: THREE.Mesh[] = [];
  private previewMaterial = new THREE.MeshLambertMaterial({
    color: 0x4488ff,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  /** Current translation delta from clipboard basePoint to cursor. */
  private currentDelta = new THREE.Vector3();

  /** Two-click state: "preview" = waiting for base point, "placing" = waiting for destination. */
  private state: "preview" | "placing" = "preview";
  /** User-picked base point (first click). */
  private basePoint: THREE.Vector3 | null = null;

  // RAF throttle
  private pendingIntersection: THREE.Vector3 | null = null;
  private pendingShiftKey = false;
  private rafId: number | null = null;

  constructor(
    scene: THREE.Scene,
    doc: BimDocument,
    toolMgr: ToolManager,
    sync: FragmentSync,
    registry: ElementRegistry,
    selectTool: SelectTool,
    clipboard: ModelClipboard
  ) {
    this.scene = scene;
    this.doc = doc;
    this.toolMgr = toolMgr;
    this.sync = sync;
    this.registry = registry;
    this.selectTool = selectTool;
    this.clipboard = clipboard;
    this.snapIndicator = new SnapIndicator(scene);
  }

  activate(): void {
    if (!this.clipboard.hasContent) {
      this.toolMgr.setTool(this.selectTool);
      return;
    }
    // Clear selection so we start fresh
    this.selectTool.clearSelection();

    // Cross-level paste: same XZ position, just shift elevation + stamp levelId.
    // No two-click workflow needed — commit immediately.
    const entry = this.clipboard.current!;
    if (this.levelId && entry.sourceLevelId && this.levelId !== entry.sourceLevelId) {
      const zeroDelta = new THREE.Vector3(0, 0, 0);
      const clones = this.clipboard.createPasteSet(zeroDelta, this.registry, {
        targetLevelId: this.levelId,
        doc: this.doc,
      });
      if (clones && clones.length > 0) {
        this.doc.transaction(() => {
          for (const clone of clones) this.doc.add(clone);
        });
      }
      this.toolMgr.setTool(this.selectTool);
      return;
    }

    // Same-level paste: two-click workflow (pick base point → pick destination)
    this.state = "preview";
    this.basePoint = null;
    this.buildPreview();
  }

  deactivate(): void {
    this.clearPreview();
    this.cancelRaf();
    this.snapIndicator.hide();
    this.state = "preview";
    this.basePoint = null;
  }

  onPointerDown(event: PointerEvent, intersection: THREE.Vector3 | null): void {
    if (event.button !== 0 || !intersection) return;

    const result = snapPoint(intersection, this.doc, {
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });

    if (this.state === "preview") {
      // First click: pick a base point on the preview
      this.basePoint = result.position.clone();
      this.state = "placing";
      // Reset delta tracking so the preview doesn't jump when the
      // anchor switches from centroid to the user-picked base point.
      this.currentDelta.set(0, 0, 0);
      return;
    }

    // Second click: commit the paste at the destination
    const delta = new THREE.Vector3().subVectors(result.position, this.basePoint!);

    // Create clones and add to document in one transaction.
    // Pass active level so cross-level paste shifts elevation + stamps levelId.
    const clones = this.clipboard.createPasteSet(delta, this.registry, {
      targetLevelId: this.levelId,
      doc: this.doc,
    });
    if (!clones || clones.length === 0) return;

    this.doc.transaction(() => {
      for (const clone of clones) {
        this.doc.add(clone);
      }
    });

    // Don't auto-select: the pasted elements go through the normal
    // create flow (overlay → fragment flush → visible). Selecting
    // would extract them before fragments exist, causing them to
    // vanish on deselect.
    this.clearPreview();
    this.toolMgr.setTool(this.selectTool);
  }

  onPointerMove(_event: PointerEvent, intersection: THREE.Vector3 | null): void {
    if (!intersection) {
      this.snapIndicator.hide();
      return;
    }

    // RAF throttle: store raw inputs, process once per frame
    this.pendingIntersection = intersection.clone();
    this.pendingShiftKey = _event.shiftKey;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.processFrame();
      });
    }
  }

  onPointerUp(_event: PointerEvent): void {}

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.clearPreview();
      this.toolMgr.setTool(this.selectTool);
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  private processFrame(): void {
    if (!this.pendingIntersection) return;
    const intersection = this.pendingIntersection;
    this.pendingIntersection = null;

    const result = snapPoint(intersection, this.doc, {
      shiftKey: this.pendingShiftKey,
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    recordStickySnap(result);
    this.snapIndicator.update(result);
    this.toolMgr.setCursorPosition(result.position);

    // In "preview" state: preview stays on top of the originals so the
    // user can snap to a meaningful point (endpoint, midpoint, etc.).
    // In "placing" state: preview moves relative to the user-picked base point.
    if (this.state === "placing" && this.basePoint) {
      const newDelta = new THREE.Vector3().subVectors(result.position, this.basePoint);
      const moveDelta = new THREE.Vector3().subVectors(newDelta, this.currentDelta);
      this.currentDelta.copy(newDelta);

      for (const mesh of this.previewMeshes) {
        mesh.position.add(moveDelta);
      }
    }
  }

  /**
   * Build translucent preview meshes from clipboard contracts.
   * Uses registry.generateGeometry with skipBooleans for speed.
   */
  private buildPreview(): void {
    const entry = this.clipboard.current;
    if (!entry) return;

    // Use a dummy GeometryEngine — we'll grab it from the sync's geoCache
    for (const contract of entry.contracts) {
      const def = this.registry.get(contract.kind);
      if (!def || def.dataOnly) continue;

      try {
        const geo = def.generateGeometry(
          this.sync.engine,
          contract,
          this.doc,
          { skipBooleans: true }
        );
        const mesh = new THREE.Mesh(geo, this.previewMaterial);
        mesh.renderOrder = 3;
        this.scene.add(mesh);
        this.previewMeshes.push(mesh);
      } catch {
        // Skip elements that fail geometry generation (e.g. orphaned windows)
      }
    }
  }

  private clearPreview(): void {
    for (const mesh of this.previewMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.previewMeshes.length = 0;
    this.currentDelta.set(0, 0, 0);
  }

  private cancelRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingIntersection = null;
  }
}
