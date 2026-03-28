import * as THREE from "three";
import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";
import type { LinearEdge } from "../core/registry";

/**
 * A single temporary dimension shown as an HTML overlay + 3D witness lines.
 */
interface TempDimension {
  /** Start anchor in world space. */
  anchorA: THREE.Vector3;
  /** End anchor in world space. */
  anchorB: THREE.Vector3;
  /** Measured distance. */
  value: number;
  /** Whether the user can type a new value. */
  editable: boolean;
  /** Callback when user edits the value. Receives the new distance. */
  onEdit?: (newValue: number) => void;
  /** Type of dimension for styling. */
  type: "length" | "distance-parallel" | "distance-endpoint";
}

/**
 * Renders temporary dimensions as HTML labels projected from 3D anchors,
 * with thin 3D witness lines in the scene.
 *
 * Revit-style: when a wall is selected, show its length + distances to
 * nearby parallel walls and perpendicular walls at endpoints.
 */
export class TempDimensionRenderer {
  private container: HTMLElement;
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private doc: BimDocument;
  private scene: THREE.Scene;

  /** Currently displayed dimension labels. */
  private labels: HTMLElement[] = [];
  /** Currently displayed 3D lines. */
  private lines: THREE.Line[] = [];
  /** Witness lines (short perpendicular ticks at dimension ends). */
  private witnesses: THREE.Line[] = [];

  /** Active dimensions data (recomputed on selection/update). */
  private dimensions: TempDimension[] = [];
  /** Currently selected contract IDs. */
  private selectedIds = new Set<ContractId>();
  /** Reusable line material. */
  private lineMat: THREE.LineBasicMaterial;
  private witnessMat: THREE.LineBasicMaterial;

  /** Whether the renderer is active (animating). */
  private active = false;
  private rafId = 0;

  constructor(
    container: HTMLElement,
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    doc: BimDocument,
    scene: THREE.Scene
  ) {
    this.container = container;
    this.camera = camera;
    this.canvas = canvas;
    this.doc = doc;
    this.scene = scene;

    this.lineMat = new THREE.LineBasicMaterial({
      color: 0x00aaff,
      depthTest: false,
    });
    this.witnessMat = new THREE.LineBasicMaterial({
      color: 0x00aaff,
      depthTest: false,
    });
  }

  /**
   * Show a single creation-time dimension between two points.
   * Used by tools (e.g. WallTool) while drawing.
   * Pass null to clear.
   */
  showCreationDimension(
    start: THREE.Vector3 | null,
    end?: THREE.Vector3
  ) {
    // Clear previous creation dims
    this.clearGeometry();
    for (const label of this.labels) label.remove();
    this.labels = [];
    this.dimensions = [];

    if (!start || !end) {
      if (this.selectedIds.size === 0) this.active = false;
      return;
    }

    const dist = start.distanceTo(end);
    if (dist < 0.01) return;

    const dir = new THREE.Vector3().subVectors(end, start).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const normal = new THREE.Vector3().crossVectors(dir, up).normalize();
    if (normal.length() < 0.001) normal.set(1, 0, 0);

    const offset = 0.5;
    this.dimensions.push({
      anchorA: start.clone().addScaledVector(normal, offset),
      anchorB: end.clone().addScaledVector(normal, offset),
      value: dist,
      editable: false,
      type: "length",
    });

    this.buildGeometry();
    this.buildLabels();
    if (!this.active) this.startLoop();
  }

  /** Call when selection changes. Pass null/empty to clear. */
  onSelectionChanged(contracts: AnyContract[]) {
    this.selectedIds.clear();
    for (const c of contracts) this.selectedIds.add(c.id);

    if (contracts.length === 0) {
      this.clear();
      return;
    }

    this.recompute();
    if (!this.active) this.startLoop();
  }

  /** Call when a selected contract is updated (e.g. during drag). */
  onContractUpdated(contract: AnyContract) {
    if (!this.selectedIds.has(contract.id)) return;
    this.recompute();
  }

  /** Recompute all temp dimensions from current contract state. */
  private recompute() {
    this.clearGeometry();
    this.dimensions = [];

    const reg = this.doc.registry;
    for (const id of this.selectedIds) {
      const contract = this.doc.contracts.get(id);
      if (!contract || !reg) continue;
      const def = reg.get(contract.kind);
      const edges = def?.getLinearEdges?.(contract, this.doc);
      if (edges) {
        for (const edge of edges) {
          this.computeEdgeDimensions(contract, edge);
        }
      }
    }

    this.buildGeometry();
    this.buildLabels();
  }

  /** Compute dimensions for a linear edge (generic — works for any element). */
  private computeEdgeDimensions(contract: AnyContract, edge: LinearEdge) {
    const s = new THREE.Vector3(...edge.start);
    const e = new THREE.Vector3(...edge.end);
    const edgeDir = new THREE.Vector3().subVectors(e, s);
    const edgeLen = edgeDir.length();
    if (edgeLen < 0.001) return;
    edgeDir.normalize();

    const up = new THREE.Vector3(0, 1, 0);
    const edgeNormal = new THREE.Vector3().crossVectors(edgeDir, up).normalize();

    // 1. Edge length dimension
    const dimOffset = (edge.expansion ?? 0) + 0.4;
    const anchorA = s.clone().addScaledVector(edgeNormal, dimOffset);
    const anchorB = e.clone().addScaledVector(edgeNormal, dimOffset);

    this.dimensions.push({
      anchorA,
      anchorB,
      value: edgeLen,
      editable: true,
      type: "length",
      onEdit: (newLen) => {
        if (newLen <= 0) return;
        const dir = new THREE.Vector3().subVectors(e, s).normalize();
        const newEnd = s.clone().addScaledVector(dir, newLen);
        this.doc.update(contract.id, { end: [newEnd.x, newEnd.y, newEnd.z] });
      },
    });

    // 2. Distance to nearest parallel edge
    const parallelDims = this.findParallelEdgeDistances(contract.id, s, e, edgeDir, edgeNormal);
    this.dimensions.push(...parallelDims);

    // 3. Distance from endpoints to nearest perpendicular edge
    const endpointDims = this.findEndpointEdgeDistances(contract.id, s, e, edgeDir);
    this.dimensions.push(...endpointDims);
  }

  /** Collect all linear edges from nearby elements (generic). */
  private collectNearbyEdges(
    excludeId: ContractId,
    cx: number, cz: number, radius: number
  ): { id: ContractId; edge: LinearEdge }[] {
    const reg = this.doc.registry;
    if (!reg) return [];
    const candidateIds = this.doc.spatialIndex
      ? this.doc.spatialIndex.queryNearSegment(cx - radius, cz - radius, cx + radius, cz + radius, 0)
      : Array.from(this.doc.contracts.keys());
    const result: { id: ContractId; edge: LinearEdge }[] = [];
    for (const id of candidateIds) {
      if (id === excludeId || this.selectedIds.has(id)) continue;
      const c = this.doc.contracts.get(id);
      if (!c) continue;
      const def = reg.get(c.kind);
      const edges = def?.getLinearEdges?.(c, this.doc);
      if (edges) {
        for (const edge of edges) result.push({ id, edge });
      }
    }
    return result;
  }

  /** Find distances to parallel edges. */
  private findParallelEdgeDistances(
    selfId: ContractId,
    s: THREE.Vector3, e: THREE.Vector3,
    edgeDir: THREE.Vector3, edgeNormal: THREE.Vector3
  ): TempDimension[] {
    const dims: TempDimension[] = [];
    const mid = s.clone().add(e).multiplyScalar(0.5);
    const PARALLEL_THRESHOLD = 0.005;
    const MAX_DIST = 20;

    let bestPos: { dist: number; dim: TempDimension } | null = null;
    let bestNeg: { dist: number; dim: TempDimension } | null = null;

    for (const { edge: other } of this.collectNearbyEdges(selfId, mid.x, mid.z, MAX_DIST)) {
      const os = new THREE.Vector3(...other.start);
      const oe = new THREE.Vector3(...other.end);
      const otherDir = new THREE.Vector3().subVectors(oe, os);
      if (otherDir.length() < 0.001) continue;
      otherDir.normalize();

      const dot = Math.abs(edgeDir.dot(otherDir));
      if (dot < 1 - PARALLEL_THRESHOLD) continue;

      const toMid = new THREE.Vector3().subVectors(mid, os);
      const t = toMid.dot(otherDir);
      const closestOnOther = os.clone().addScaledVector(otherDir, t);

      const diff = new THREE.Vector3().subVectors(closestOnOther, mid);
      const absDist = diff.length();
      if (absDist < 0.01 || absDist > MAX_DIST) continue;

      const perpDist = diff.dot(edgeNormal);
      const dim: TempDimension = {
        anchorA: mid.clone(),
        anchorB: closestOnOther,
        value: absDist,
        editable: false,
        type: "distance-parallel",
      };

      if (perpDist > 0) {
        if (!bestPos || absDist < bestPos.dist) bestPos = { dist: absDist, dim };
      } else {
        if (!bestNeg || absDist < bestNeg.dist) bestNeg = { dist: absDist, dim };
      }
    }

    if (bestPos) dims.push(bestPos.dim);
    if (bestNeg) dims.push(bestNeg.dim);
    return dims;
  }

  /** Find distance from endpoints to nearest perpendicular edge. */
  private findEndpointEdgeDistances(
    selfId: ContractId,
    s: THREE.Vector3, e: THREE.Vector3,
    edgeDir: THREE.Vector3
  ): TempDimension[] {
    const PERP_THRESHOLD = 0.05;
    const MAX_DIST = 20;
    let best: { dist: number; dim: TempDimension } | null = null;

    for (const endpoint of [s, e]) {
      for (const { edge: other } of this.collectNearbyEdges(selfId, endpoint.x, endpoint.z, MAX_DIST)) {
        const os = new THREE.Vector3(...other.start);
        const oe = new THREE.Vector3(...other.end);
        const otherDir = new THREE.Vector3().subVectors(oe, os);
        const otherLen = otherDir.length();
        if (otherLen < 0.001) continue;
        otherDir.normalize();

        const dot = Math.abs(edgeDir.dot(otherDir));
        if (dot > PERP_THRESHOLD) continue;

        const distStoOther = this.pointToSegmentDist(s, os, oe);
        const distEtoOther = this.pointToSegmentDist(e, os, oe);
        if (distStoOther < 0.01 || distEtoOther < 0.01) continue;

        const toEndpoint = new THREE.Vector3().subVectors(endpoint, os);
        const t = toEndpoint.dot(otherDir);
        if (t < -0.5 || t > otherLen + 0.5) continue;

        const projectedPoint = os.clone().addScaledVector(otherDir, t);
        const dist = endpoint.distanceTo(projectedPoint);
        if (dist < 0.01 || dist > MAX_DIST) continue;

        if (!best || dist < best.dist) {
          best = {
            dist,
            dim: { anchorA: endpoint.clone(), anchorB: projectedPoint, value: dist, editable: false, type: "distance-endpoint" },
          };
        }
      }
    }

    return best ? [best.dim] : [];
  }

  /** Build 3D line geometry for all dimensions. */
  private buildGeometry() {
    for (const dim of this.dimensions) {
      // Main dimension line
      const geo = new THREE.BufferGeometry().setFromPoints([
        dim.anchorA,
        dim.anchorB,
      ]);
      const line = new THREE.Line(geo, this.lineMat);
      line.renderOrder = 15;
      this.scene.add(line);
      this.lines.push(line);

      // Witness ticks at each end (short perpendicular lines)
      const dir = new THREE.Vector3()
        .subVectors(dim.anchorB, dim.anchorA)
        .normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const perpDir = new THREE.Vector3().crossVectors(dir, up);
      if (perpDir.length() < 0.001) perpDir.set(1, 0, 0);
      perpDir.normalize();

      const tickLen = 0.15;
      for (const anchor of [dim.anchorA, dim.anchorB]) {
        const tickGeo = new THREE.BufferGeometry().setFromPoints([
          anchor.clone().addScaledVector(perpDir, -tickLen),
          anchor.clone().addScaledVector(perpDir, tickLen),
        ]);
        const tick = new THREE.Line(tickGeo, this.witnessMat);
        tick.renderOrder = 15;
        this.scene.add(tick);
        this.witnesses.push(tick);
      }
    }
  }

  /** Build HTML label elements for each dimension. */
  private buildLabels() {
    // Remove old labels
    for (const label of this.labels) label.remove();
    this.labels = [];

    for (let i = 0; i < this.dimensions.length; i++) {
      const dim = this.dimensions[i];
      const label = document.createElement("div");
      label.className = "temp-dim-label";
      if (dim.editable) label.classList.add("editable");
      label.textContent = formatDim(dim.value);
      label.dataset.dimIndex = String(i);

      if (dim.editable) {
        label.addEventListener("dblclick", () => {
          this.startEdit(label, dim);
        });
      }

      this.container.appendChild(label);
      this.labels.push(label);
    }
  }

  /** Make a label editable — replace text with input. */
  private startEdit(label: HTMLElement, dim: TempDimension) {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "temp-dim-input";
    input.value = dim.value.toFixed(3);
    input.step = "0.01";
    label.textContent = "";
    label.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const val = parseFloat(input.value);
      if (!isNaN(val) && val > 0 && dim.onEdit) {
        dim.onEdit(val);
      }
      // Label will be rebuilt on next recompute via onContractUpdated
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { commit(); input.blur(); }
      if (e.key === "Escape") input.blur();
    });
  }

  /** Project labels to screen each frame. */
  private updateLabelPositions() {
    const rect = this.canvas.getBoundingClientRect();

    for (let i = 0; i < this.dimensions.length && i < this.labels.length; i++) {
      const dim = this.dimensions[i];
      const label = this.labels[i];

      // Midpoint of the dimension line
      const mid = dim.anchorA.clone().add(dim.anchorB).multiplyScalar(0.5);
      const projected = mid.clone().project(this.camera);

      // Check if behind camera
      if (projected.z > 1) {
        label.style.display = "none";
        continue;
      }

      const x = ((projected.x + 1) / 2) * rect.width;
      const y = ((-projected.y + 1) / 2) * rect.height;

      label.style.display = "";
      label.style.left = `${x}px`;
      label.style.top = `${y}px`;
    }
  }

  /** Start the animation loop for label positioning. */
  private startLoop() {
    this.active = true;
    const loop = () => {
      if (!this.active) return;
      this.updateLabelPositions();
      this.rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  /** Stop animation and clear everything. */
  clear() {
    this.active = false;
    cancelAnimationFrame(this.rafId);
    this.selectedIds.clear();
    this.dimensions = [];
    this.clearGeometry();
    for (const label of this.labels) label.remove();
    this.labels = [];
  }

  private clearGeometry() {
    for (const line of this.lines) {
      this.scene.remove(line);
      line.geometry.dispose();
    }
    this.lines = [];
    for (const w of this.witnesses) {
      this.scene.remove(w);
      w.geometry.dispose();
    }
    this.witnesses = [];
  }

  /** Distance from a point to a line segment. */
  private pointToSegmentDist(
    p: THREE.Vector3,
    a: THREE.Vector3,
    b: THREE.Vector3
  ): number {
    const ab = new THREE.Vector3().subVectors(b, a);
    const len = ab.length();
    if (len < 0.001) return p.distanceTo(a);
    ab.normalize();
    const t = Math.max(0, Math.min(len, new THREE.Vector3().subVectors(p, a).dot(ab)));
    const proj = a.clone().addScaledVector(ab, t);
    return p.distanceTo(proj);
  }

  dispose() {
    this.clear();
    this.lineMat.dispose();
    this.witnessMat.dispose();
  }
}

function formatDim(value: number): string {
  // Show 3 decimals for small values, 2 for large
  if (value < 1) return value.toFixed(3);
  return value.toFixed(2);
}
