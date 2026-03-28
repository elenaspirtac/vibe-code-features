import { TypedEvent } from "./events";
import type { TransactionRecord } from "./transaction";
import type { ContractId } from "./contracts";
import type { FragmentElementIds } from "../fragments/writer";

// ── Dependency interfaces ─────────────────────────────────────────

/** Minimal BimDocument API needed by UndoManager. */
export interface UndoDocumentApi {
  readonly contracts: ReadonlyMap<ContractId, any>;
  readonly fragmentIds: ReadonlyMap<ContractId, FragmentElementIds>;
  undo(record: TransactionRecord): TransactionRecord;
}

/** Minimal FragmentSync API needed by UndoManager. */
export interface UndoSyncApi {
  readonly lastFragmentRequestIndex: number;
  readonly hasExtracted: boolean;
  isUndoRedo: boolean;
  flush(): Promise<void>;
  navigateFragmentHistory(
    targetIndex: number,
    affectedIds: ContractId[]
  ): Promise<void>;
  refreshExtractedOverlays(): void;
  setModelTranslucency(translucent: boolean): void;
  expandWithNeighbors(ids: ContractId[]): ContractId[];
  updateFastOverlays(ids: ContractId[]): void;
}

// ── Types ─────────────────────────────────────────────────────────

export interface UndoEntry {
  record: TransactionRecord;
  fragIndex: number;
}

// ── UndoManager ───────────────────────────────────────────────────

export class UndoManager {
  /** Fires when canUndo or canRedo may have changed. */
  readonly onStateChanged = new TypedEvent<void>();
  /** Fires once when entering fast undo/redo (first press). */
  onBeforeUndoRedo: (() => void) | null = null;

  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private isUndoRedoFlag = false;
  private recording: Promise<void> = Promise.resolve();

  // Selection-session record: accumulates ALL mutations while elements
  // are extracted. Finalized on deselect → one undo entry.
  private selectionRecord: TransactionRecord | null = null;

  // Pending grouped record (e.g. drag without selection): accumulated
  // until the group ends and fragments flush.
  private pendingGroupRecord: TransactionRecord | null = null;

  // Fast undo/redo state (S.27): accumulates across rapid presses,
  // debounces the expensive fragment rebuild.
  private fastState: {
    targetIndex: number;
    affectedIds: Set<ContractId>;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private FAST_DEBOUNCE_MS = 800;


  constructor(
    private doc: UndoDocumentApi,
    private sync: UndoSyncApi
  ) {}

  // ── Public getters ──────────────────────────────────────────────

  get canUndo(): boolean {
    return (
      this.undoStack.length > 0 ||
      this.pendingGroupRecord !== null ||
      this.selectionRecord !== null
    );
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** True while fast undo/redo is in progress (model is translucent, awaiting finalize). */
  get isBusy(): boolean {
    return this.fastState !== null;
  }

  // ── Primary actions ─────────────────────────────────────────────

  /** Undo the last action. Chains onto the recording queue. */
  undo(): void {
    this.chain(async () => {
      await this.finalizePendingGroupAsync();
      const entry = this.undoStack.pop();
      if (!entry) return;

      const prevEntry = this.undoStack[this.undoStack.length - 1];
      const targetIndex = prevEntry ? prevEntry.fragIndex : -1;

      const affectedIds = entry.record.mutations.map((m) => m.id);
      const primaryIds = this.primaryMutationIds(entry.record);
      // Expand to cascade neighbors BEFORE undo removes contracts/indexes
      const expandedIds = this.sync.expandWithNeighbors(affectedIds);

      this.sync.isUndoRedo = true;
      this.isUndoRedoFlag = true;
      const reverseRecord = this.doc.undo(entry.record);
      this.isUndoRedoFlag = false;
      this.sync.isUndoRedo = false;

      this.redoStack.push({ record: reverseRecord, fragIndex: entry.fragIndex });
      this.sync.refreshExtractedOverlays();

      // If primary items were removed by undo (creation undone), show the
      // previous entry's primary element instead (the history point we land on).
      const survivingPrimary = primaryIds.filter((id) =>
        this.doc.contracts.has(id)
      );
      const overlayIds =
        survivingPrimary.length > 0
          ? primaryIds
          : prevEntry
            ? this.primaryMutationIds(prevEntry.record)
            : [];

      this.accumulateFast(targetIndex, expandedIds, overlayIds);
      this.emitStateChanged();
    });
  }

  /** Redo the last undone action. Chains onto the recording queue. */
  redo(): void {
    this.chain(async () => {
      await this.finalizePendingGroupAsync();
      const entry = this.redoStack.pop();
      if (!entry) return;

      const affectedIds = entry.record.mutations.map((m) => m.id);
      const primaryIds = this.primaryMutationIds(entry.record);
      // Expand to cascade neighbors BEFORE redo removes contracts/indexes
      const expandedIds = this.sync.expandWithNeighbors(affectedIds);

      this.sync.isUndoRedo = true;
      this.isUndoRedoFlag = true;
      const reverseRecord = this.doc.undo(entry.record);
      this.isUndoRedoFlag = false;
      this.sync.isUndoRedo = false;

      this.undoStack.push({ record: reverseRecord, fragIndex: entry.fragIndex });
      this.sync.refreshExtractedOverlays();

      this.accumulateFast(entry.fragIndex, expandedIds, primaryIds);
      this.emitStateChanged();
    });
  }

  // ── Transaction recording ───────────────────────────────────────

  /**
   * Record a committed transaction. Called externally from
   * doc.onTransactionCommit. Handles selection accumulation,
   * grouped transactions, and normal recording.
   */
  recordTransaction(record: TransactionRecord): void {
    if (this.isUndoRedoFlag) return;

    // While elements are selected, accumulate ALL mutations into one
    // session record. Keep only the first `before` per contract ID.
    if (this.sync.hasExtracted) {
      if (!this.selectionRecord) {
        this.selectionRecord = record;
      } else {
        this.mergeMutations(this.selectionRecord, record);
      }
      this.emitStateChanged();
      return;
    }

    // Grouped transactions (e.g. drag without selection): accumulate
    // until group ends.
    if (record.groupId) {
      if (
        !this.pendingGroupRecord ||
        this.pendingGroupRecord.groupId !== record.groupId
      ) {
        // New group — finalize previous group async
        if (this.pendingGroupRecord) {
          const prev = this.pendingGroupRecord;
          this.pendingGroupRecord = null;
          this.chain(async () => {
            await this.sync.flush();
            this.undoStack.push({
              record: prev,
              fragIndex: this.sync.lastFragmentRequestIndex,
            });
            this.redoStack.length = 0;
            this.emitStateChanged();
          });
        }
        this.pendingGroupRecord = record;
        this.emitStateChanged();
      } else {
        // Same group: merge mutations
        this.mergeMutations(this.pendingGroupRecord, record);
      }
      return;
    }

    // Non-grouped, nothing selected: finalize any pending group, flush, push.
    this.chain(async () => {
      await this.finalizePendingGroupAsync();
      await this.sync.flush();
      const fragIndex = this.sync.lastFragmentRequestIndex;
      const top = this.undoStack[this.undoStack.length - 1];
      if (top && top.fragIndex === fragIndex) {
        // Same fragment batch — merge into one undo step
        top.record.mutations.push(...record.mutations);
      } else {
        this.undoStack.push({ record, fragIndex });
      }
      this.redoStack.length = 0;
      this.emitStateChanged();
    });
  }

  // ── Selection session lifecycle ─────────────────────────────────

  /**
   * Finalize the selection session record. Called when selection
   * clears (onSelectionChanged → null). Chains onto recording so
   * fragIndex is captured after the restore flush completes.
   */
  finalizeSelectionRecord(): void {
    this.chain(async () => {
      if (!this.selectionRecord) return;
      await this.sync.flush();
      this.undoStack.push({
        record: this.selectionRecord,
        fragIndex: this.sync.lastFragmentRequestIndex,
      });
      this.redoStack.length = 0;
      this.selectionRecord = null;
      this.emitStateChanged();
    });
  }

  // ── Save/load integration ───────────────────────────────────────

  /** Enqueue finalization of any pending grouped transaction. */
  finalizePendingGroup(): void {
    this.chain(() => this.finalizePendingGroupAsync());
  }

  /** Returns the recording promise chain for external awaiting (save flow). */
  awaitRecording(): Promise<void> {
    return this.recording;
  }

  /** Clear all state. Used on file load. */
  reset(): void {
    this.cancelFast();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pendingGroupRecord = null;
    this.selectionRecord = null;
    this.isUndoRedoFlag = false;
    this.recording = Promise.resolve();
    this.emitStateChanged();
  }

  /** Clean up timers. */
  dispose(): void {
    this.cancelFast();
  }

  // ── Fast undo/redo (S.27) ────────────────────────────────────────

  private accumulateFast(
    targetIndex: number,
    expandedIds: ContractId[],
    primaryIds: ContractId[]
  ) {
    if (!this.fastState) {
      // First press — clear selection and make the fragment model translucent
      this.onBeforeUndoRedo?.();
      this.sync.setModelTranslucency(true);
      this.fastState = {
        targetIndex,
        affectedIds: new Set(expandedIds),
        timer: setTimeout(() => this.finalizeFast(), this.FAST_DEBOUNCE_MS),
      };
    } else {
      // Subsequent press — update target, accumulate affected IDs
      clearTimeout(this.fastState.timer);
      this.fastState.targetIndex = targetIndex;
      for (const id of expandedIds) this.fastState.affectedIds.add(id);
      this.fastState.timer = setTimeout(
        () => this.finalizeFast(),
        this.FAST_DEBOUNCE_MS
      );
    }
    // Show overlays only for primary items (not cascade neighbors)
    this.sync.updateFastOverlays(primaryIds);
  }

  private finalizeFast() {
    if (!this.fastState) return;
    const { targetIndex, affectedIds } = this.fastState;
    this.fastState = null;
    this.chain(async () => {
      await this.sync.navigateFragmentHistory(targetIndex, [...affectedIds]);
    });
  }

  private cancelFast() {
    if (this.fastState) {
      clearTimeout(this.fastState.timer);
      this.fastState = null;
      this.sync.setModelTranslucency(false);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  private chain(fn: () => Promise<void>): void {
    this.recording = this.recording.then(fn);
  }

  private emitStateChanged(): void {
    this.onStateChanged.trigger();
  }

  private async finalizePendingGroupAsync(): Promise<void> {
    if (!this.pendingGroupRecord) return;
    await this.sync.flush();
    this.undoStack.push({
      record: this.pendingGroupRecord,
      fragIndex: this.sync.lastFragmentRequestIndex,
    });
    this.redoStack.length = 0;
    this.pendingGroupRecord = null;
    this.emitStateChanged();
  }

  /**
   * Extract the primary mutation IDs from a transaction record.
   * Primary = add/remove mutations (the directly created/deleted items).
   * Falls back to all mutation IDs if the transaction is pure updates.
   */
  private primaryMutationIds(record: TransactionRecord): ContractId[] {
    const addRemove = record.mutations
      .filter((m) => m.type === "add" || m.type === "remove")
      .map((m) => m.id);
    return addRemove.length > 0
      ? addRemove
      : record.mutations.map((m) => m.id);
  }

  /**
   * Merge mutations from `source` into `target`, keeping only the
   * first `before` per contract ID (deduplication).
   */
  private mergeMutations(
    target: TransactionRecord,
    source: TransactionRecord
  ): void {
    const seen = new Set(target.mutations.map((m) => m.id));
    for (const m of source.mutations) {
      if (!seen.has(m.id)) {
        target.mutations.push(m);
        seen.add(m.id);
      }
    }
  }
}
