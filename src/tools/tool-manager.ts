import * as THREE from "three";
import type { SnapGroupManager } from "../utils/snap-groups";

// ── Work plane (S.10 / 1.17) ──────────────────────────────────────

/**
 * A work plane defines the drawing surface for tools.
 * All cursor-to-world raycasting, snapping, and placement
 * operations use the active work plane.
 *
 * Default: XZ ground plane (horizontal, Y=0, up=Y).
 */
export interface WorkPlane {
  /** Human-readable name (e.g., "Ground", "Level 1", "Wall face"). */
  name: string;
  /** A point on the plane. */
  origin: THREE.Vector3;
  /** Plane normal — the "up" direction for this surface. */
  normal: THREE.Vector3;
  /**
   * Local X axis on the plane surface (perpendicular to normal).
   * Used for grid snapping and coordinate display.
   */
  xAxis: THREE.Vector3;
  /**
   * Local Y axis on the plane surface (perpendicular to normal and xAxis).
   * Together with xAxis, forms an orthonormal basis on the plane.
   */
  yAxis: THREE.Vector3;
}

/** Create the default XZ ground work plane at a given elevation. */
export function createGroundPlane(elevation = 0): WorkPlane {
  return {
    name: "Ground",
    origin: new THREE.Vector3(0, elevation, 0),
    normal: new THREE.Vector3(0, 1, 0),
    xAxis: new THREE.Vector3(1, 0, 0),
    yAxis: new THREE.Vector3(0, 0, 1),
  };
}

// ── Tool interface ─────────────────────────────────────────────────

export interface Tool {
  name: string;
  /** Type kind this tool creates instances for (e.g. "wallType"). */
  typeKind?: string;
  /** Active type ID — set by the type selection system. */
  typeId?: string | null;
  /** Active level ID — set when the user switches levels. */
  levelId?: string | null;
  activate(): void;
  deactivate(): void;
  onPointerDown(event: PointerEvent, intersection: THREE.Vector3 | null): void;
  onPointerMove(event: PointerEvent, intersection: THREE.Vector3 | null): void;
  onPointerUp(event: PointerEvent): void;
  onKeyDown(event: KeyboardEvent): void;
}

// ── Tool manager ───────────────────────────────────────────────────

export class ToolManager {
  private activeTool: Tool | null = null;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private _workPlane: WorkPlane;
  private threePlane = new THREE.Plane();
  private container: HTMLElement;
  private camera: THREE.PerspectiveCamera;

  /** Small dot that shows where the cursor lands on the work plane. */
  private cursorDot: THREE.Mesh;

  /** Snap group manager for cross-group snapping. Set by main.ts. */
  snapGroupManager: SnapGroupManager | null = null;

  /** Callback to update toolbar button states */
  onToolChanged: ((toolName: string | null) => void) | null = null;

  constructor(container: HTMLElement, camera: THREE.PerspectiveCamera, scene: THREE.Scene) {
    this.container = container;
    this.camera = camera;
    this._workPlane = createGroundPlane();
    this.syncThreePlane();

    const dotGeo = new THREE.SphereGeometry(0.06, 10, 10);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x00aaff, depthTest: false });
    this.cursorDot = new THREE.Mesh(dotGeo, dotMat);
    this.cursorDot.renderOrder = 100;
    this.cursorDot.visible = false;
    scene.add(this.cursorDot);

    container.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
    container.addEventListener("pointermove", (e) => this.handlePointerMove(e));
    container.addEventListener("pointerup", (e) => this.handlePointerUp(e));
    window.addEventListener("keydown", (e) => this.handleKeyDown(e));
  }

  /** The active work plane. Tools and generators should read this. */
  get workPlane(): WorkPlane {
    return this._workPlane;
  }

  /** Change the active work plane. Updates raycast plane automatically. */
  setWorkPlane(plane: WorkPlane) {
    this._workPlane = plane;
    this.syncThreePlane();
  }

  /** Active level ID. Set by the levels UI. */
  activeLevelId: string | null = null;

  /** Callback when active level changes (e.g., to move the grid). */
  onLevelChanged: ((levelId: string | null, elevation: number) => void) | null = null;

  /** Switch the active level and update the work plane. */
  setActiveLevel(levelId: string | null, elevation: number) {
    this.activeLevelId = levelId;
    this.setWorkPlane(createGroundPlane(elevation));
    this.onLevelChanged?.(levelId, elevation);
  }

  setTool(tool: Tool | null) {
    if (this.activeTool) {
      this.activeTool.deactivate();
    }
    this.activeTool = tool;
    if (tool) {
      tool.activate();
    } else {
      this.cursorDot.visible = false;
    }
    this.onToolChanged?.(tool?.name ?? null);
  }

  /** Update the cursor dot position. Called by tools with the snapped point. */
  setCursorPosition(position: THREE.Vector3) {
    this.cursorDot.position.copy(position);
    this.cursorDot.visible = true;
  }

  /** Hide the cursor dot (e.g. when pointer leaves or tool doesn't need it). */
  hideCursor() {
    this.cursorDot.visible = false;
  }

  getActiveTool(): Tool | null {
    return this.activeTool;
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /**
   * Raycast onto the active work plane.
   * The optional `elevation` parameter offsets the plane along its normal
   * (e.g., elevation=3 on a horizontal plane raycasts at Y=3).
   */
  raycastGround(event: PointerEvent, elevation = 0): THREE.Vector3 | null {
    const rect = this.container.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Offset the plane along its normal by elevation
    const baseConstant = -this._workPlane.origin.dot(this._workPlane.normal);
    this.threePlane.constant = baseConstant - elevation;

    const target = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this.threePlane, target);
    return hit;
  }

  /** Raycast against scene objects */
  raycastObjects(event: PointerEvent, objects: THREE.Object3D[]): THREE.Intersection[] {
    const rect = this.container.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    return this.raycaster.intersectObjects(objects, true);
  }

  private handlePointerDown(event: PointerEvent) {
    if (!this.activeTool) return;
    const hit = this.raycastGround(event);
    this.activeTool.onPointerDown(event, hit);
  }

  private handlePointerMove(event: PointerEvent) {
    if (!this.activeTool) return;
    const hit = this.raycastGround(event);
    this.activeTool.onPointerMove(event, hit);
  }

  private handlePointerUp(event: PointerEvent) {
    if (!this.activeTool) return;
    this.activeTool.onPointerUp(event);
  }

  private handleKeyDown(event: KeyboardEvent) {
    // Escape always cancels the active tool
    if (event.key === "Escape") {
      if (this.activeTool) {
        this.setTool(null);
        event.preventDefault();
      }
      return;
    }
    if (!this.activeTool) return;
    this.activeTool.onKeyDown(event);
  }

  /** Sync the THREE.Plane used for raycasting from the work plane definition. */
  private syncThreePlane() {
    this.threePlane.setFromNormalAndCoplanarPoint(
      this._workPlane.normal,
      this._workPlane.origin
    );
  }
}
