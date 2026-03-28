import * as THREE from "three";
import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";
import type { ElementRegistry, LinearEdge } from "../core/registry";
import type { SnapGroupManager } from "./snap-groups";

export interface SnapResult {
  position: THREE.Vector3;
  type:
    | "endpoint"
    | "midpoint"
    | "edgeBody"
    | "extension"
    | "extensionIntersection"
    | "perpendicular"
    | "angular"
    | "grid";
  /** Which element was snapped to (geometry snaps only). */
  targetId?: ContractId;
  /** Reference point for drawing guide lines. */
  referencePoint?: THREE.Vector3;
  /** Second reference point for extension intersections. */
  referencePoint2?: THREE.Vector3;
  /** Original Y elevation of the snapped element (set for cross-level snaps). */
  sourceElevation?: number;
}

export interface SnapOptions {
  /** Contracts to skip (e.g. the element being created/dragged). */
  excludeIds?: ContractId[];
  gridStep?: number;
  endpointThreshold?: number;
  /** Anchor point for angular/extension constraints. */
  anchor?: THREE.Vector3;
  /** Whether Shift is held — enables angular constraint. */
  shiftKey?: boolean;
  /** Registry for element type lookups. */
  registry?: ElementRegistry;
  /** Work plane elevation — snap results are projected to this Y.
   *  Enables cross-level snapping (align walls across floors). */
  elevation?: number;
  /** Snap group manager — enables cross-group snapping with Y projection. */
  snapGroupManager?: SnapGroupManager;
  /** Override contracts for specific IDs — snap uses these instead of
   *  doc.contracts. Useful for snapping to pre-move positions of elements
   *  being dragged (frozen at their original locations). */
  contractOverrides?: ReadonlyMap<ContractId, AnyContract>;
}

const DEFAULT_GRID_STEP = 0.1;
const DEFAULT_ENDPOINT_THRESHOLD = 0.3;

const ANGLE_INCREMENTS = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180,
  195, 210, 225, 240, 255, 270, 285, 300, 315, 330, 345].map(
  (d) => (d * Math.PI) / 180
);

export const snapSettings = {
  gridEnabled: true,
  gridStep: DEFAULT_GRID_STEP,
  endpointEnabled: true,
  endpointThreshold: DEFAULT_ENDPOINT_THRESHOLD,
  midpointEnabled: true,
  extensionEnabled: true,
  perpendicularEnabled: true,
};

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

const stickySnaps = new Map<ContractId, number>();
const STICKY_TIMEOUT_MS = 3000;

/** Candidate: a linear edge from any element type. */
interface EdgeCandidate {
  id: ContractId;
  edge: LinearEdge;
  /** Absolute Y delta from source to work plane (0 = same level). */
  absYDelta: number;
}

/** Small penalty per meter of Y distance to prefer same-level snaps. */
const CROSS_LEVEL_PENALTY_PER_M = 0.01;

/**
 * Snap a world-space point.
 * Priority: angular > endpoint > midpoint > perpendicular > edge body > extension intersection > extension > grid.
 *
 * Fully generic: uses registry getLinearEdges + getSnapPoints for any element type.
 */
export function snapPoint(
  point: THREE.Vector3,
  doc: BimDocument,
  options: SnapOptions = {}
): SnapResult {
  const result = snapPointCore(point, doc, options);
  // For cross-level snaps, record the source elevation before projecting
  if (options.snapGroupManager && result.targetId && options.elevation != null) {
    const delta = options.snapGroupManager.getProjectionDelta(result.targetId, options.elevation);
    if (delta != null && delta !== 0) {
      // The source element's elevation = work plane - delta
      result.sourceElevation = options.elevation - delta;
    }
  }
  // Project snap result onto current work plane elevation for cross-level alignment
  if (options.elevation != null) {
    result.position.y = options.elevation;
  }
  return result;
}

function snapPointCore(
  point: THREE.Vector3,
  doc: BimDocument,
  options: SnapOptions = {}
): SnapResult {
  const excludeSet = new Set(options.excludeIds ?? []);
  const threshold = options.endpointThreshold ?? snapSettings.endpointThreshold;
  const reg = options.registry ?? doc.registry;
  const overrides = options.contractOverrides;

  /** Resolve a contract — overrides take priority over doc.contracts. */
  const getContract = (id: ContractId) => overrides?.get(id) ?? doc.contracts.get(id);

  // Evict stale sticky snaps
  const now = performance.now();
  for (const [id, ts] of stickySnaps) {
    if (now - ts > STICKY_TIMEOUT_MS) stickySnaps.delete(id);
  }

  // Angular constraint (Shift)
  let constrainedPoint = point;
  if (options.shiftKey && options.anchor) {
    constrainedPoint = applyAngularConstraint(point, options.anchor);
  }

  const si = doc.spatialIndex;

  const sgm = options.snapGroupManager;
  const workPlaneY = options.elevation ?? 0;

  /** Project an edge's Y coordinates by a delta (cross-group snapping). */
  const projectEdge = (edge: LinearEdge, yDelta: number): LinearEdge => {
    if (yDelta === 0) return edge;
    return {
      ...edge,
      start: [edge.start[0], edge.start[1] + yDelta, edge.start[2]],
      end: [edge.end[0], edge.end[1] + yDelta, edge.end[2]],
    };
  };

  /** Get the Y projection delta for an element, or null if its group is disabled. */
  const getYDelta = (id: ContractId): number | null => {
    if (!sgm) return 0;
    return sgm.getProjectionDelta(id, workPlaneY);
  };

  // --- Helper: collect linear edge candidates near a point ---
  const edgeCandidates = (cx: number, cz: number, radius: number): EdgeCandidate[] => {
    const ids = si ? si.queryRadius(cx, cz, radius) : Array.from(doc.contracts.keys());
    const result: EdgeCandidate[] = [];
    for (const id of ids) {
      if (excludeSet.has(id)) continue;
      const yDelta = getYDelta(id);
      if (yDelta === null) continue; // group disabled
      const c = getContract(id);
      if (!c || !reg) continue;
      const def = reg.get(c.kind);
      const edges = def?.getLinearEdges?.(c, doc);
      if (edges) {
        const ayd = Math.abs(yDelta);
        for (const edge of edges) result.push({ id, edge: projectEdge(edge, yDelta), absYDelta: ayd });
      }
    }
    return result;
  };

  // Extension candidates: spatial broadphase + sticky snaps
  const extensionCandidates = (cx: number, cz: number, radius: number): EdgeCandidate[] => {
    const seen = new Set<ContractId>();
    const result: EdgeCandidate[] = [];
    const ids = si ? si.queryRadius(cx, cz, radius) : Array.from(doc.contracts.keys());
    for (const id of ids) {
      if (excludeSet.has(id)) continue;
      const yDelta = getYDelta(id);
      if (yDelta === null) continue;
      const c = getContract(id);
      if (!c || !reg) continue;
      const def = reg.get(c.kind);
      const edges = def?.getLinearEdges?.(c, doc);
      if (edges) {
        const ayd = Math.abs(yDelta);
        for (const edge of edges) result.push({ id, edge: projectEdge(edge, yDelta), absYDelta: ayd });
        seen.add(id);
      }
    }
    for (const [id] of stickySnaps) {
      if (seen.has(id) || excludeSet.has(id)) continue;
      const yDelta = getYDelta(id);
      if (yDelta === null) continue;
      const c = getContract(id);
      if (!c || !reg) continue;
      const def = reg.get(c.kind);
      const edges = def?.getLinearEdges?.(c, doc);
      if (edges) {
        const ayd = Math.abs(yDelta);
        for (const edge of edges) result.push({ id, edge: projectEdge(edge, yDelta), absYDelta: ayd });
      }
    }
    return result;
  };

  // --- Endpoint snap ---
  if (snapSettings.endpointEnabled) {
    let bestDist = Infinity;
    let bestPos: THREE.Vector3 | null = null;
    let bestId: ContractId | undefined;

    // Linear edge endpoints
    for (const { id, edge, absYDelta } of edgeCandidates(constrainedPoint.x, constrainedPoint.z, threshold)) {
      _v1.set(edge.start[0], edge.start[1], edge.start[2]);
      _v2.set(edge.end[0], edge.end[1], edge.end[2]);
      const penalty = absYDelta * CROSS_LEVEL_PENALTY_PER_M;

      const ds = constrainedPoint.distanceTo(_v1) + penalty;
      if (ds < threshold && ds < bestDist) {
        bestDist = ds;
        bestPos = _v1.clone();
        bestId = id;
      }

      const de = constrainedPoint.distanceTo(_v2) + penalty;
      if (de < threshold && de < bestDist) {
        bestDist = de;
        bestPos = _v2.clone();
        bestId = id;
      }
    }

    // Also check registry getSnapPoints for non-linear elements
    if (reg) {
      const nearbyIds = si
        ? si.queryRadius(constrainedPoint.x, constrainedPoint.z, threshold)
        : Array.from(doc.contracts.keys());
      for (const id of nearbyIds) {
        if (excludeSet.has(id)) continue;
        const yDelta = getYDelta(id);
        if (yDelta === null) continue; // group disabled
        const c = getContract(id);
        if (!c) continue;
        const typeDef = reg.get(c.kind);
        // Skip elements that have linear edges (already handled above)
        if (typeDef?.getLinearEdges) continue;
        const snapPoints = typeDef?.getSnapPoints?.(c, doc);
        if (!snapPoints) continue;
        const penalty = Math.abs(yDelta) * CROSS_LEVEL_PENALTY_PER_M;
        for (const sp of snapPoints) {
          // Project snap point Y for cross-group snapping
          const projected = yDelta !== 0 ? sp.position.clone().setY(sp.position.y + yDelta) : sp.position;
          const d = constrainedPoint.distanceTo(projected) + penalty;
          if (d < threshold && d < bestDist) {
            bestDist = d;
            bestPos = projected.clone();
            bestId = id;
          }
        }
      }
    }

    if (bestPos) {
      return { position: bestPos, type: "endpoint", targetId: bestId };
    }
  }

  // --- Midpoint snap ---
  if (snapSettings.midpointEnabled) {
    let bestDist = Infinity;
    let bestPos: THREE.Vector3 | null = null;
    let bestId: ContractId | undefined;

    for (const { id, edge, absYDelta } of edgeCandidates(constrainedPoint.x, constrainedPoint.z, threshold)) {
      _v1.set(edge.start[0], edge.start[1], edge.start[2]);
      _v2.set(edge.end[0], edge.end[1], edge.end[2]);
      _v3.lerpVectors(_v1, _v2, 0.5);

      const d = constrainedPoint.distanceTo(_v3) + absYDelta * CROSS_LEVEL_PENALTY_PER_M;
      if (d < threshold && d < bestDist) {
        bestDist = d;
        bestPos = _v3.clone();
        bestId = id;
      }
    }

    if (bestPos) {
      return { position: bestPos, type: "midpoint", targetId: bestId };
    }
  }

  // --- Perpendicular snap ---
  if (snapSettings.perpendicularEnabled && options.anchor) {
    let bestDist = Infinity;
    let bestPos: THREE.Vector3 | null = null;
    let bestId: ContractId | undefined;

    for (const { id, edge, absYDelta } of extensionCandidates(constrainedPoint.x, constrainedPoint.z, threshold * 5)) {
      _v1.set(edge.start[0], edge.start[1], edge.start[2]);
      _v2.set(edge.end[0], edge.end[1], edge.end[2]);
      const dir = _v3.subVectors(_v2, _v1);
      const len = dir.length();
      if (len < 0.001) continue;
      dir.normalize();

      const toAnchor = _v1.clone().sub(options.anchor).negate();
      const t = toAnchor.dot(dir);

      const foot = _v1
        .set(edge.start[0], edge.start[1], edge.start[2])
        .addScaledVector(dir, t);

      const d = constrainedPoint.distanceTo(foot) + absYDelta * CROSS_LEVEL_PENALTY_PER_M;
      if (d < threshold && d < bestDist) {
        bestDist = d;
        bestPos = foot.clone();
        bestId = id;
      }
    }

    if (bestPos) {
      return { position: bestPos, type: "perpendicular", targetId: bestId, referencePoint: options.anchor!.clone() };
    }
  }

  // --- Edge body snap (for T-junctions) ---
  if (snapSettings.endpointEnabled) {
    let bestDist = Infinity;
    let bestPos: THREE.Vector3 | null = null;
    let bestId: ContractId | undefined;

    for (const { id, edge, absYDelta } of edgeCandidates(constrainedPoint.x, constrainedPoint.z, threshold)) {
      _v1.set(edge.start[0], edge.start[1], edge.start[2]);
      _v2.set(edge.end[0], edge.end[1], edge.end[2]);
      const dir = _v3.subVectors(_v2, _v1);
      const len = dir.length();
      if (len < 0.001) continue;
      dir.normalize();

      const toPoint = constrainedPoint.clone().sub(_v1);
      const t = toPoint.dot(dir);
      const margin = threshold;
      if (t <= margin || t >= len - margin) continue;

      const projected = _v1
        .set(edge.start[0], edge.start[1], edge.start[2])
        .addScaledVector(dir, t);
      const dist = constrainedPoint.distanceTo(projected) + absYDelta * CROSS_LEVEL_PENALTY_PER_M;
      if (dist < threshold && dist < bestDist) {
        bestDist = dist;
        bestPos = projected.clone();
        bestId = id;
      }
    }

    if (bestPos) {
      if (snapSettings.gridEnabled) {
        const step = options.gridStep ?? snapSettings.gridStep;
        bestPos.x = Math.round(bestPos.x / step) * step;
        bestPos.y = Math.round(bestPos.y / step) * step;
        bestPos.z = Math.round(bestPos.z / step) * step;
      }
      return { position: bestPos, type: "edgeBody", targetId: bestId };
    }
  }

  // --- Extension intersection snap ---
  if (snapSettings.extensionEnabled) {
    const extThreshold = threshold * 3;
    let bestDist = Infinity;
    let bestPos: THREE.Vector3 | null = null;

    const axes: { start: THREE.Vector3; end: THREE.Vector3; dir: THREE.Vector3; id: ContractId; absYDelta: number }[] = [];
    for (const { id, edge, absYDelta } of extensionCandidates(constrainedPoint.x, constrainedPoint.z, extThreshold * 5)) {
      const s = new THREE.Vector3(...edge.start);
      const e = new THREE.Vector3(...edge.end);
      const d = new THREE.Vector3().subVectors(e, s);
      if (d.length() < 0.001) continue;
      d.normalize();
      axes.push({ start: s, end: e, dir: d, id, absYDelta });

      // Perpendicular extension: add virtual axes perpendicular to the edge
      // at both endpoints. These let you snap to positions aligned
      // perpendicularly with wall endpoints (like extension snaps but at 90°).
      const perpDir = new THREE.Vector3(-d.z, 0, d.x); // 90° in XZ
      axes.push({ start: s.clone(), end: s.clone().add(perpDir), dir: perpDir.clone(), id, absYDelta });
      axes.push({ start: e.clone(), end: e.clone().add(perpDir), dir: perpDir.clone(), id, absYDelta });
    }

    let bestRef1: THREE.Vector3 | null = null;
    let bestRef2: THREE.Vector3 | null = null;
    for (let i = 0; i < axes.length; i++) {
      for (let j = i + 1; j < axes.length; j++) {
        const intersection = lineLineIntersection2D(axes[i].start, axes[i].dir, axes[j].start, axes[j].dir);
        if (!intersection) continue;

        const ti = intersection.clone().sub(axes[i].start).dot(axes[i].dir);
        const li = axes[i].start.distanceTo(axes[i].end);
        const tj = intersection.clone().sub(axes[j].start).dot(axes[j].dir);
        const lj = axes[j].start.distanceTo(axes[j].end);
        const insideI = ti >= 0 && ti <= li;
        const insideJ = tj >= 0 && tj <= lj;
        if (insideI && insideJ) continue;

        const penalty = Math.max(axes[i].absYDelta, axes[j].absYDelta) * CROSS_LEVEL_PENALTY_PER_M;
        const d = constrainedPoint.distanceTo(intersection) + penalty;
        if (d < extThreshold && d < bestDist) {
          bestDist = d;
          bestPos = intersection;
          bestRef1 = intersection.distanceTo(axes[i].start) < intersection.distanceTo(axes[i].end)
            ? axes[i].start.clone() : axes[i].end.clone();
          bestRef2 = intersection.distanceTo(axes[j].start) < intersection.distanceTo(axes[j].end)
            ? axes[j].start.clone() : axes[j].end.clone();
        }
      }
    }

    if (bestPos) {
      return { position: bestPos, type: "extensionIntersection", referencePoint: bestRef1!, referencePoint2: bestRef2! };
    }
  }

  // --- Extension snap (includes perpendicular virtual axes) ---
  if (snapSettings.extensionEnabled) {
    const extThreshold = threshold * 2;
    let bestDist = Infinity;
    let bestPos: THREE.Vector3 | null = null;
    let bestId: ContractId | undefined;
    let bestRef: THREE.Vector3 | null = null;

    // Collect real extension candidates + perpendicular virtual edges.
    // For every extension candidate, add perpendicular axes at both
    // endpoints so you can snap perpendicularly to any recently-interacted wall.
    const extCands = extensionCandidates(constrainedPoint.x, constrainedPoint.z, extThreshold * 5);
    const allExtEdges: EdgeCandidate[] = [...extCands];
    for (const { id, edge, absYDelta } of extCands) {
      const s = new THREE.Vector3(...edge.start);
      const e = new THREE.Vector3(...edge.end);
      const d = new THREE.Vector3().subVectors(e, s);
      if (d.length() < 0.001) continue;
      d.normalize();
      const perpDir = new THREE.Vector3(-d.z, 0, d.x);
      // Perpendicular axis at start endpoint
      const perpEndS: [number, number, number] = [s.x + perpDir.x, s.y + perpDir.y, s.z + perpDir.z];
      allExtEdges.push({ id, edge: { ...edge, start: edge.start, end: perpEndS, expansion: 0 }, absYDelta });
      // Perpendicular axis at end endpoint
      const perpEndE: [number, number, number] = [e.x + perpDir.x, e.y + perpDir.y, e.z + perpDir.z];
      allExtEdges.push({ id, edge: { ...edge, start: edge.end, end: perpEndE, expansion: 0 }, absYDelta });
    }

    for (const { id, edge, absYDelta } of allExtEdges) {
      _v1.set(edge.start[0], edge.start[1], edge.start[2]);
      _v2.set(edge.end[0], edge.end[1], edge.end[2]);
      const dir = _v3.subVectors(_v2, _v1);
      const len = dir.length();
      if (len < 0.001) continue;
      dir.normalize();

      const toPoint = constrainedPoint.clone().sub(_v1);
      const t = toPoint.dot(dir);
      if (t >= 0 && t <= len) continue; // inside edge body

      const projected = _v1
        .set(edge.start[0], edge.start[1], edge.start[2])
        .addScaledVector(dir, t);
      const dist = constrainedPoint.distanceTo(projected) + absYDelta * CROSS_LEVEL_PENALTY_PER_M;
      if (dist < extThreshold && dist < bestDist) {
        bestDist = dist;
        bestPos = projected.clone();
        bestId = id;
        bestRef = new THREE.Vector3(...edge.start);
      }
    }

    if (bestPos) {
      return { position: bestPos, type: "extension", targetId: bestId, referencePoint: bestRef! };
    }
  }

  // --- Angular constraint result ---
  if (options.shiftKey && options.anchor && constrainedPoint !== point) {
    return { position: constrainedPoint.clone(), type: "angular" };
  }

  // --- Grid snap ---
  if (snapSettings.gridEnabled) {
    const step = options.gridStep ?? snapSettings.gridStep;
    const base = options.shiftKey && options.anchor ? constrainedPoint : point;
    const gridPos = new THREE.Vector3(
      Math.round(base.x / step) * step,
      Math.round(base.y / step) * step,
      Math.round(base.z / step) * step
    );
    return { position: gridPos, type: "grid" };
  }

  return { position: constrainedPoint.clone(), type: "grid" };
}

export function recordStickySnap(result: SnapResult): void {
  if (result.targetId && result.type !== "grid" && result.type !== "angular") {
    stickySnaps.set(result.targetId, performance.now());
  }
}

export function clearStickySnaps(): void {
  stickySnaps.clear();
}

function applyAngularConstraint(point: THREE.Vector3, anchor: THREE.Vector3): THREE.Vector3 {
  const dx = point.x - anchor.x;
  const dz = point.z - anchor.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.001) return point.clone();

  const angle = Math.atan2(dz, dx);
  let bestAngle = 0;
  let bestDiff = Infinity;
  for (const inc of ANGLE_INCREMENTS) {
    const diff = Math.abs(angleDiff(angle, inc));
    if (diff < bestDiff) {
      bestDiff = diff;
      bestAngle = inc;
    }
  }

  return new THREE.Vector3(
    anchor.x + Math.cos(bestAngle) * dist,
    anchor.y,
    anchor.z + Math.sin(bestAngle) * dist
  );
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function lineLineIntersection2D(
  p1: THREE.Vector3, d1: THREE.Vector3,
  p2: THREE.Vector3, d2: THREE.Vector3
): THREE.Vector3 | null {
  const det = d1.x * (-d2.z) - d1.z * (-d2.x);
  if (Math.abs(det) < 1e-8) return null;
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  const t = (dx * (-d2.z) - dz * (-d2.x)) / det;
  return new THREE.Vector3(p1.x + t * d1.x, (p1.y + p2.y) / 2, p1.z + t * d1.z);
}

/**
 * Visual indicator shown when snapping.
 */
export class SnapIndicator {
  private mesh: THREE.Mesh;
  private line: THREE.Line;
  private lineGeo: THREE.BufferGeometry;
  private line2: THREE.Line;
  private lineGeo2: THREE.BufferGeometry;
  /** Vertical dashed line for cross-level snaps. */
  private vertLine: THREE.Line;
  private vertLineGeo: THREE.BufferGeometry;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const geo = new THREE.SphereGeometry(0.08, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ddff, depthTest: false });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0,0,0,0], 3));
    const lineMat = new THREE.LineDashedMaterial({ color: 0xffff00, dashSize: 0.15, gapSize: 0.1, depthTest: false });
    this.line = new THREE.Line(this.lineGeo, lineMat);
    this.line.renderOrder = 10;
    this.line.visible = false;
    scene.add(this.line);

    this.lineGeo2 = new THREE.BufferGeometry();
    this.lineGeo2.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0,0,0,0], 3));
    const lineMat2 = new THREE.LineDashedMaterial({ color: 0xff00ff, dashSize: 0.15, gapSize: 0.1, depthTest: false });
    this.line2 = new THREE.Line(this.lineGeo2, lineMat2);
    this.line2.renderOrder = 10;
    this.line2.visible = false;
    scene.add(this.line2);

    this.vertLineGeo = new THREE.BufferGeometry();
    this.vertLineGeo.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0,0,0,0], 3));
    const vertMat = new THREE.LineDashedMaterial({ color: 0xff8800, dashSize: 0.15, gapSize: 0.1, depthTest: false });
    this.vertLine = new THREE.Line(this.vertLineGeo, vertMat);
    this.vertLine.renderOrder = 10;
    this.vertLine.visible = false;
    scene.add(this.vertLine);
  }

  private static COLORS: Record<string, number> = {
    endpoint: 0x00ddff,
    midpoint: 0x00ff88,
    edgeBody: 0xff8800,
    extension: 0xffff00,
    extensionIntersection: 0xff00ff,
    perpendicular: 0x8888ff,
    angular: 0xff4444,
  };

  update(result: SnapResult) {
    const isCrossLevel = result.sourceElevation != null;
    // For cross-level snaps, show the indicator at the source elevation
    // so the user sees the actual geometry being snapped to.
    const displayPos = isCrossLevel
      ? new THREE.Vector3(result.position.x, result.sourceElevation!, result.position.z)
      : result.position;

    if (result.type !== "grid") {
      this.mesh.position.copy(displayPos);
      const color = SnapIndicator.COLORS[result.type] ?? 0x00ddff;
      (this.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      this.mesh.visible = true;
    } else {
      this.mesh.visible = false;
    }

    if (result.referencePoint) {
      // For cross-level, project reference points to source elevation too
      const ref = isCrossLevel
        ? new THREE.Vector3(result.referencePoint.x, result.sourceElevation!, result.referencePoint.z)
        : result.referencePoint;
      this.updateLine(this.line, this.lineGeo, ref, displayPos,
        SnapIndicator.COLORS[result.type] ?? 0xffff00);
    } else {
      this.line.visible = false;
    }

    if (result.referencePoint2) {
      const ref2 = isCrossLevel
        ? new THREE.Vector3(result.referencePoint2.x, result.sourceElevation!, result.referencePoint2.z)
        : result.referencePoint2;
      this.updateLine(this.line2, this.lineGeo2, ref2, displayPos,
        SnapIndicator.COLORS[result.type] ?? 0xff00ff);
    } else {
      this.line2.visible = false;
    }

    // Vertical dashed line connecting source elevation to work plane
    if (isCrossLevel) {
      this.updateLine(this.vertLine, this.vertLineGeo, displayPos, result.position, 0xff8800);
    } else {
      this.vertLine.visible = false;
    }
  }

  private updateLine(line: THREE.Line, geo: THREE.BufferGeometry, from: THREE.Vector3, to: THREE.Vector3, color: number) {
    const positions = geo.getAttribute("position") as THREE.BufferAttribute;
    positions.setXYZ(0, from.x, from.y + 0.01, from.z);
    positions.setXYZ(1, to.x, to.y + 0.01, to.z);
    positions.needsUpdate = true;
    geo.computeBoundingSphere();
    (line.material as THREE.LineDashedMaterial).color.setHex(color);
    line.computeLineDistances();
    line.visible = true;
  }

  hide() {
    this.mesh.visible = false;
    this.line.visible = false;
    this.line2.visible = false;
    this.vertLine.visible = false;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.scene.remove(this.line);
    this.lineGeo.dispose();
    (this.line.material as THREE.Material).dispose();
    this.scene.remove(this.line2);
    this.lineGeo2.dispose();
    (this.line2.material as THREE.Material).dispose();
    this.scene.remove(this.vertLine);
    this.vertLineGeo.dispose();
    (this.vertLine.material as THREE.Material).dispose();
  }
}
