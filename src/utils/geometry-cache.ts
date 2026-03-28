import * as THREE from "three";
import type { AnyContract } from "../core/contracts";
import type { BimDocument } from "../core/document";
import type { ElementRegistry } from "../core/registry";

/**
 * Content-addressed geometry cache.
 *
 * Keyed on a hash of the contract + all inputs that affect geometry
 * (neighbor contracts for booleans, host contracts for windows, etc.).
 * Returns a CLONED geometry so callers can dispose independently.
 *
 * Two tiers:
 *  - "full" — geometry with boolean cuts (miter, T-junction, window voids)
 *  - "simple" — geometry without boolean cuts (skipBooleans: true)
 */
export class GeometryCache {
  private cache = new Map<string, THREE.BufferGeometry>();
  private maxSize: number;

  /** Cache hit/miss stats for debugging. */
  hits = 0;
  misses = 0;

  constructor(maxSize = 2000) {
    this.maxSize = maxSize;
  }

  /**
   * Get or generate geometry for a contract.
   * Returns a clone — caller owns the returned geometry.
   */
  /**
   * Optional reverse-cuts lookup: returns IDs of elements that cut the given target.
   * Set by FragmentSync to avoid O(n) scanning in computeKey.
   */
  reverseCutsLookup: ((targetId: string) => string[]) | null = null;

  getOrGenerate(
    registry: ElementRegistry,
    engine: import("@thatopen/fragments").GeometryEngine,
    contract: AnyContract,
    doc: BimDocument,
    options?: { skipBooleans?: boolean }
  ): THREE.BufferGeometry {
    const key = this.computeKey(registry, contract, doc, options);
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      return cached.clone();
    }

    this.misses++;
    const geo = registry.generateGeometry(engine, contract, doc, options);

    // Store a clone so the cached copy isn't disposed by the caller
    this.cache.set(key, geo.clone());

    // Evict oldest entries if over budget (simple FIFO)
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value!;
      this.cache.get(firstKey)?.dispose();
      this.cache.delete(firstKey);
    }

    return geo;
  }

  /**
   * Invalidate all entries for a specific contract ID.
   * Called when a contract changes — both its own entry and entries
   * that depend on it (neighbors, hosts) are invalidated.
   */
  invalidate(contractId: string) {
    for (const [key] of this.cache) {
      if (key.includes(contractId)) {
        this.cache.get(key)?.dispose();
        this.cache.delete(key);
      }
    }
  }

  /** Invalidate everything. */
  clear() {
    for (const geo of this.cache.values()) geo.dispose();
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Compute a cache key from the contract and all inputs that affect geometry.
   *
   * For a wall: the wall contract + neighbor contracts (miter/T-junction) + hosted windows.
   * For a window: the window contract + host wall contract.
   * For a floor: the floor contract + referenced wall positions.
   *
   * We use a deterministic JSON serialization of the relevant contract fields.
   * This is simpler than a proper content hash and fast enough for our scale
   * (JSON.stringify of a few contracts is <0.1ms).
   */
  private computeKey(
    registry: ElementRegistry,
    contract: AnyContract,
    doc: BimDocument,
    options?: { skipBooleans?: boolean }
  ): string {
    const tier = options?.skipBooleans ? "S" : "F"; // Simple vs Full
    const parts: string[] = [tier, stableStringify(contract)];

    // Always include related contracts — they affect geometry even without
    // booleans (e.g., floor boundary resolves wall endpoint positions).
    const rels = registry.getRelationships(contract, doc);
    // Sort by targetId for deterministic key
    const sorted = rels.map((r) => r.targetId).sort();
    for (const targetId of sorted) {
      const related = doc.contracts.get(targetId);
      if (related) parts.push(stableStringify(related));
    }

    // Include reverse "cuts" relationships — elements that cut this one
    // affect its geometry but aren't in its own relationship list.
    // Uses the dependentsOf reverse index (O(1) lookup) instead of scanning all contracts.
    if (!options?.skipBooleans && this.reverseCutsLookup) {
      const cutterIds = this.reverseCutsLookup(contract.id);
      if (cutterIds.length > 0) {
        const cutters = cutterIds
          .map((id) => doc.contracts.get(id))
          .filter(Boolean)
          .map((c) => stableStringify(c!))
          .sort();
        parts.push(...cutters);
      }
    }

    return parts.join("|");
  }
}

/**
 * Deterministic JSON stringify — sorts object keys so
 * { a: 1, b: 2 } and { b: 2, a: 1 } produce the same string.
 */
function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}
