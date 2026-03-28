import * as THREE from "three";
import type { AnyContract, ContractId } from "../core/contracts";
import type { BimDocument } from "../core/document";
import type { ElementRegistry } from "../core/registry";
import { isLevel, type LevelContract } from "../elements/level";

/**
 * Clipboard entry: snapshot of contracts + a base point for relative placement.
 */
export interface ClipboardEntry {
  /** All contracts in the copied subgraph (selected + hosted children). */
  contracts: AnyContract[];
  /** Centroid of the copied elements — used as the origin for paste placement. */
  basePoint: THREE.Vector3;
  /** Level ID of the source elements (if any). Used to compute elevation shift on cross-level paste. */
  sourceLevelId: ContractId | null;
}

/**
 * In-memory model clipboard for copy/paste (1.18).
 *
 * Copy snapshots the selected contracts and their hosted dependents.
 * Paste creates deep clones with remapped IDs and applies a translation.
 */
export class ModelClipboard {
  private entry: ClipboardEntry | null = null;

  get hasContent(): boolean {
    return this.entry !== null;
  }

  get current(): ClipboardEntry | null {
    return this.entry;
  }

  /**
   * Copy the given contracts + their hosted dependents to the clipboard.
   * Walks the relationship graph to collect children (windows on walls, etc.).
   */
  copy(
    selectedContracts: AnyContract[],
    doc: BimDocument,
    registry: ElementRegistry
  ): void {
    if (selectedContracts.length === 0) return;

    // Collect the full subgraph: selected + hosted children
    const collected = new Map<ContractId, AnyContract>();
    for (const c of selectedContracts) {
      collected.set(c.id, { ...c });
    }
    // Walk "hosts" relationships to find children (windows, doors on walls)
    for (const c of selectedContracts) {
      const def = registry.get(c.kind);
      if (!def) continue;
      const rels = def.getRelationships(c, doc);
      for (const rel of rels) {
        if (rel.type === "hosts" && !collected.has(rel.targetId)) {
          const child = doc.contracts.get(rel.targetId);
          if (child) collected.set(child.id, { ...child });
        }
      }
    }

    // Compute centroid as base point
    const basePoint = this.computeCentroid([...collected.values()], doc, registry);

    // Capture source level: use the levelId of the first element that has one
    let sourceLevelId: ContractId | null = null;
    for (const c of collected.values()) {
      const lid = (c as Record<string, unknown>).levelId as string | undefined;
      if (lid) { sourceLevelId = lid; break; }
    }

    this.entry = {
      contracts: [...collected.values()],
      basePoint,
      sourceLevelId,
    };
  }

  /**
   * Create a paste-ready set of cloned contracts with new IDs,
   * remapped internal references, and translated positions.
   *
   * @param delta - Translation from original basePoint to target position
   * @param registry - Element registry for remapIds / applyTranslation hooks
   * @param options.targetLevelId - If set and different from source level, stamps
   *   this levelId on clones and shifts Y by the elevation difference.
   * @param options.doc - Needed to resolve level elevations for cross-level paste.
   * @returns Cloned contracts ready to `doc.add()`, or null if clipboard is empty
   */
  createPasteSet(
    delta: THREE.Vector3,
    registry: ElementRegistry,
    options?: { targetLevelId?: ContractId | null; doc?: BimDocument }
  ): AnyContract[] | null {
    if (!this.entry) return null;

    // Compute elevation shift for cross-level paste
    let elevationShift = 0;
    const targetLevelId = options?.targetLevelId ?? null;
    const doc = options?.doc;
    if (targetLevelId && doc && this.entry.sourceLevelId && targetLevelId !== this.entry.sourceLevelId) {
      const sourceLevel = doc.contracts.get(this.entry.sourceLevelId);
      const targetLevel = doc.contracts.get(targetLevelId);
      if (sourceLevel && targetLevel && isLevel(sourceLevel) && isLevel(targetLevel)) {
        elevationShift = targetLevel.elevation - sourceLevel.elevation;
      }
    }

    // 1. Generate new IDs
    const idMap = new Map<ContractId, ContractId>();
    for (const c of this.entry.contracts) {
      idMap.set(c.id, crypto.randomUUID());
    }

    // 2. Clone, remap IDs, translate, and re-stamp level
    const clones: AnyContract[] = [];
    const deltaArr: [number, number, number] = [delta.x, delta.y + elevationShift, delta.z];

    for (const original of this.entry.contracts) {
      // Start with a copy using the new ID
      let clone: AnyContract = { ...original, id: idMap.get(original.id)! };

      // Remap internal references (hostId, cutTargets, etc.)
      const def = registry.get(clone.kind);
      if (def?.remapIds) {
        clone = def.remapIds(clone, idMap);
        // Ensure the new ID is preserved after remapIds (which spreads the original)
        clone = { ...clone, id: idMap.get(original.id)! };
      }

      // Translate position (includes elevation shift for cross-level paste)
      if (def?.applyTranslation) {
        const translated = def.applyTranslation(clone, deltaArr);
        if (translated) clone = translated;
      }

      // Stamp target level on elements that have a levelId
      if (targetLevelId && "levelId" in clone) {
        (clone as Record<string, unknown>).levelId = targetLevelId;
      }

      clones.push(clone);
    }

    return clones;
  }

  /**
   * Compute centroid of a set of contracts using spatial bounds or snap points.
   */
  private computeCentroid(
    contracts: AnyContract[],
    doc: BimDocument,
    registry: ElementRegistry
  ): THREE.Vector3 {
    const center = new THREE.Vector3();
    let count = 0;

    for (const c of contracts) {
      const def = registry.get(c.kind);
      if (!def || def.dataOnly) continue;

      // Try spatial bounds
      const bounds = def.getSpatialBounds?.(c, doc);
      if (bounds) {
        center.x += (bounds.min[0] + bounds.max[0]) / 2;
        center.y += (bounds.min[1] + bounds.max[1]) / 2;
        center.z += (bounds.min[2] + bounds.max[2]) / 2;
        count++;
        continue;
      }

      // Try snap points
      const snapPts = def.getSnapPoints?.(c, doc);
      if (snapPts && snapPts.length > 0) {
        const avg = new THREE.Vector3();
        for (const sp of snapPts) avg.add(sp.position);
        avg.divideScalar(snapPts.length);
        center.add(avg);
        count++;
      }
    }

    if (count > 0) center.divideScalar(count);
    return center;
  }
}
