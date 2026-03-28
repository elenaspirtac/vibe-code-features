import RBush from "rbush";
import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";

interface SpatialItem {
  minX: number; // world X min
  minY: number; // world Z min (RBush Y = world Z)
  maxX: number;
  maxY: number;
  id: ContractId;
}

/**
 * 2D spatial index on the XZ plane using an R-tree (RBush).
 * Provides O(log n) broadphase queries for snap, temp dimensions,
 * and joint detection — replacing linear scans over all contracts.
 *
 * Fully generic: uses registry hooks (getSpatialBounds, getLinearEdges,
 * getSnapPoints) to compute AABBs for any element type.
 *
 * Axis mapping: RBush X = world X, RBush Y = world Z.
 */
export class SpatialIndex {
  private tree = new RBush<SpatialItem>();
  private items = new Map<ContractId, SpatialItem>();
  private doc: BimDocument;

  private onAddedHandler: (c: AnyContract) => void;
  private onUpdatedHandler: (e: { contract: AnyContract; patchKeys: string[] }) => void;
  private onRemovedHandler: (id: ContractId) => void;

  /** IDs to skip during incremental updates (paused during drag). */
  private pausedIds = new Set<ContractId>();

  constructor(doc: BimDocument) {
    this.doc = doc;
    this.onAddedHandler = (c) => this.insert(c);
    this.onUpdatedHandler = ({ contract: c }) => {
      if (this.pausedIds.has(c.id)) return;
      this.update(c);
    };
    this.onRemovedHandler = (id) => this.remove(id);
  }

  /** Pause incremental updates for specific IDs (e.g. during drag). */
  pauseUpdates(ids: Iterable<ContractId>): void {
    for (const id of ids) this.pausedIds.add(id);
  }

  /** Resume incremental updates and re-index the paused elements. */
  resumeUpdates(): void {
    for (const id of this.pausedIds) {
      const contract = this.doc.contracts.get(id);
      if (contract) this.update(contract);
    }
    this.pausedIds.clear();
  }

  connect(): void {
    this.doc.onAdded.add(this.onAddedHandler);
    this.doc.onUpdated.add(this.onUpdatedHandler);
    this.doc.onRemoved.add(this.onRemovedHandler);
  }

  dispose(): void {
    this.doc.onAdded.remove(this.onAddedHandler);
    this.doc.onUpdated.remove(this.onUpdatedHandler);
    this.doc.onRemoved.remove(this.onRemovedHandler);
  }

  rebuild(): void {
    this.tree.clear();
    this.items.clear();
    const bulk: SpatialItem[] = [];
    for (const [, contract] of this.doc.contracts) {
      const item = this.computeItem(contract);
      if (item) {
        this.items.set(contract.id, item);
        bulk.push(item);
      }
    }
    this.tree.load(bulk);
  }

  // ── Queries ──────────────────────────────────────────────────────

  queryRadius(x: number, z: number, radius: number): ContractId[] {
    const results = this.tree.search({
      minX: x - radius,
      minY: z - radius,
      maxX: x + radius,
      maxY: z + radius,
    });
    return results.map((r) => r.id);
  }

  queryBox(minX: number, minZ: number, maxX: number, maxZ: number): ContractId[] {
    const results = this.tree.search({
      minX,
      minY: minZ,
      maxX,
      maxY: maxZ,
    });
    return results.map((r) => r.id);
  }

  queryNearSegment(
    x1: number, z1: number,
    x2: number, z2: number,
    radius: number
  ): ContractId[] {
    return this.queryBox(
      Math.min(x1, x2) - radius,
      Math.min(z1, z2) - radius,
      Math.max(x1, x2) + radius,
      Math.max(z1, z2) + radius,
    );
  }

  // ── Incremental updates ──────────────────────────────────────────

  private insert(contract: AnyContract): void {
    const item = this.computeItem(contract);
    if (!item) return;
    this.items.set(contract.id, item);
    this.tree.insert(item);
  }

  private update(contract: AnyContract): void {
    this.remove(contract.id);
    this.insert(contract);
  }

  private remove(id: ContractId): void {
    const existing = this.items.get(id);
    if (!existing) return;
    this.tree.remove(existing);
    this.items.delete(id);
  }

  // ── AABB computation (fully generic via registry hooks) ─────────

  private computeItem(contract: AnyContract): SpatialItem | null {
    const reg = this.doc.registry;
    if (!reg) return null;
    const def = reg.get(contract.kind);
    if (!def || def.dataOnly) return null;

    // 1. Prefer explicit getSpatialBounds
    const bounds = def.getSpatialBounds?.(contract, this.doc);
    if (bounds) {
      return {
        minX: bounds.min[0],
        minY: bounds.min[2], // RBush Y = world Z
        maxX: bounds.max[0],
        maxY: bounds.max[2],
        id: contract.id,
      };
    }

    // 2. Fall back to getLinearEdges
    const edges = def.getLinearEdges?.(contract, this.doc);
    if (edges && edges.length > 0) {
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const e of edges) {
        const pad = e.expansion ?? 0;
        minX = Math.min(minX, e.start[0] - pad, e.end[0] - pad);
        minZ = Math.min(minZ, e.start[2] - pad, e.end[2] - pad);
        maxX = Math.max(maxX, e.start[0] + pad, e.end[0] + pad);
        maxZ = Math.max(maxZ, e.start[2] + pad, e.end[2] + pad);
      }
      return { minX, minY: minZ, maxX, maxY: maxZ, id: contract.id };
    }

    // 3. Fall back to getSnapPoints
    const snapPoints = def.getSnapPoints?.(contract, this.doc);
    if (snapPoints && snapPoints.length > 0) {
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const sp of snapPoints) {
        if (sp.position.x < minX) minX = sp.position.x;
        if (sp.position.z < minZ) minZ = sp.position.z;
        if (sp.position.x > maxX) maxX = sp.position.x;
        if (sp.position.z > maxZ) maxZ = sp.position.z;
      }
      const PAD = 0.5;
      return { minX: minX - PAD, minY: minZ - PAD, maxX: maxX + PAD, maxY: maxZ + PAD, id: contract.id };
    }

    return null;
  }
}
