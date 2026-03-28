import { TypedEvent } from "../core/events";
import type { ContractId } from "../core/contracts";

/**
 * Explicit visibility states an element can be in.
 * Elements not tracked by the state machine are implicitly Normal.
 */
export enum VisState {
  /** Fragment visible (base or delta), no overlay. Default state. */
  Normal,
  /** Fragment hidden (base+delta), overlay visible. Selected for editing. */
  Extracted,
  /** Async transition: flush dirty → show fragment → remove overlay → Normal. */
  Restoring,
  /** Fragment hidden, overlay shows undo/redo preview. Debounced rebuild pending. */
  FastUndo,
  /** Fragment write in background, overlay visible until flush completes. */
  Flushing,
  /** Delta rebuilding during history navigation, overlay bridges the gap. */
  HistoryNav,
}

interface ElementEntry {
  state: VisState;
  /** Modified while extracted — needs fragment write on restore. */
  dirty: boolean;
}

/** Valid state transitions. Key = from state, value = set of allowed target states. */
const ALLOWED = new Map<VisState, Set<VisState>>([
  [
    VisState.Normal,
    new Set([VisState.Extracted, VisState.FastUndo, VisState.Flushing, VisState.HistoryNav]),
  ],
  [
    VisState.Extracted,
    new Set([VisState.Restoring, VisState.Normal]),
  ],
  [
    VisState.Restoring,
    new Set([VisState.Normal, VisState.Extracted]),
  ],
  [
    VisState.FastUndo,
    new Set([VisState.Normal, VisState.Extracted, VisState.HistoryNav]),
  ],
  [
    VisState.Flushing,
    new Set([VisState.Normal, VisState.Extracted]),
  ],
  [
    VisState.HistoryNav,
    new Set([VisState.Normal, VisState.Extracted]),
  ],
]);

/**
 * Tracks the explicit visibility state of every non-Normal element.
 * Pure data structure — no side effects (no setVisible, no overlay calls).
 * FragmentSync reads state and dispatches the actual async operations.
 */
export class VisibilityStateMachine {
  private entries = new Map<ContractId, ElementEntry>();

  /** Fires on every state transition (for debug logging / observability). */
  readonly onTransition = new TypedEvent<{
    id: ContractId;
    from: VisState;
    to: VisState;
  }>();

  /** Returns VisState.Normal for elements not in the map. */
  getState(id: ContractId): VisState {
    return this.entries.get(id)?.state ?? VisState.Normal;
  }

  /**
   * Validate and perform a state transition.
   * Throws on illegal transitions.
   */
  transition(id: ContractId, to: VisState): void {
    const from = this.getState(id);
    if (from === to) return; // no-op

    const allowed = ALLOWED.get(from);
    if (!allowed || !allowed.has(to)) {
      throw new Error(
        `Illegal visibility transition: ${VisState[from]} → ${VisState[to]} for element "${id}"`
      );
    }

    if (to === VisState.Normal) {
      this.entries.delete(id);
    } else {
      const entry = this.entries.get(id);
      if (entry) {
        entry.state = to;
        // Keep dirty flag when transitioning Extracted → Restoring so
        // restore() can flush dirty contracts. Clear otherwise.
        if (from === VisState.Extracted && to !== VisState.Restoring) entry.dirty = false;
      } else {
        this.entries.set(id, { state: to, dirty: false });
      }
    }

    this.onTransition.trigger({ id, from, to });
  }

  /** Batch transition — validates each individually. */
  transitionMany(ids: ContractId[], to: VisState): void {
    for (const id of ids) {
      this.transition(id, to);
    }
  }

  /** Remove element from tracking (returns to implicit Normal). Fires transition event. */
  clear(id: ContractId): void {
    const entry = this.entries.get(id);
    if (!entry) return; // already Normal
    const from = entry.state;
    this.entries.delete(id);
    this.onTransition.trigger({ id, from, to: VisState.Normal });
  }

  /** All element IDs currently in a given state. */
  inState(state: VisState): ContractId[] {
    if (state === VisState.Normal) {
      throw new Error("Cannot query Normal state — it is implicit (not tracked).");
    }
    const result: ContractId[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.state === state) result.push(id);
    }
    return result;
  }

  /** True if any element is in the given state. O(n) worst case but short-circuits. */
  hasAny(state: VisState): boolean {
    for (const entry of this.entries.values()) {
      if (entry.state === state) return true;
    }
    return false;
  }

  /** Mark an element as dirty (modified while Extracted). */
  markDirty(id: ContractId): void {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== VisState.Extracted) return;
    entry.dirty = true;
  }

  /** Check if an element is dirty. */
  isDirty(id: ContractId): boolean {
    return this.entries.get(id)?.dirty ?? false;
  }

  /** Reset all state (for load/reset scenarios). */
  reset(): void {
    this.entries.clear();
  }

  /** Number of tracked (non-Normal) elements. For debugging. */
  get size(): number {
    return this.entries.size;
  }
}
