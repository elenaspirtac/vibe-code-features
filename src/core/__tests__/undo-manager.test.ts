import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  UndoManager,
  type UndoDocumentApi,
  type UndoSyncApi,
} from "../undo-manager";
import type { TransactionRecord, MutationRecord } from "../transaction";
import type { ContractId } from "../contracts";
import type { FragmentElementIds } from "../../fragments/writer";

// ── Helpers ───────────────────────────────────────────────────────

function makeMutation(
  id: ContractId,
  type: "add" | "update" | "remove" = "update"
): MutationRecord {
  return {
    type,
    id,
    before: type === "add" ? null : { id, kind: "wall" } as any,
    after: type === "remove" ? null : { id, kind: "wall" } as any,
  };
}

function makeRecord(
  ids: ContractId[],
  opts?: { groupId?: string }
): TransactionRecord {
  return {
    mutations: ids.map((id) => makeMutation(id)),
    timestamp: Date.now(),
    groupId: opts?.groupId,
  };
}

function createMockDoc(): UndoDocumentApi {
  const fragmentIds = new Map<ContractId, FragmentElementIds>();
  return {
    contracts: new Map(),
    fragmentIds,
    undo: vi.fn((record: TransactionRecord) => {
      // Return a reverse record
      return {
        mutations: record.mutations.map((m) => ({
          ...m,
          before: m.after,
          after: m.before,
        })),
        timestamp: Date.now(),
      };
    }),
  };
}

function createMockSync(): UndoSyncApi & { _fragIndex: number } {
  const mock = {
    _fragIndex: -1,
    get lastFragmentRequestIndex() {
      return mock._fragIndex;
    },
    hasExtracted: false as boolean,
    isUndoRedo: false,
    flush: vi.fn(async () => {
      mock._fragIndex++;
    }),
    navigateFragmentHistory: vi.fn(async () => {}),
    refreshExtractedOverlays: vi.fn(),
    setModelTranslucency: vi.fn(),
    expandWithNeighbors: vi.fn((ids: string[]) => ids),
    updateFastOverlays: vi.fn(),
  };
  return mock;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("UndoManager", () => {
  let doc: ReturnType<typeof createMockDoc>;
  let sync: ReturnType<typeof createMockSync>;
  let mgr: UndoManager;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = createMockDoc();
    sync = createMockSync();
    mgr = new UndoManager(doc, sync);
  });

  afterEach(() => {
    mgr.dispose();
    vi.useRealTimers();
  });

  /** Drain the async recording chain + advance timers. */
  async function drain(ms = 50) {
    await vi.advanceTimersByTimeAsync(ms);
    await mgr.awaitRecording();
  }

  // ── Basic recording ─────────────────────────────────────────────

  describe("basic recording", () => {
    it("records a transaction and enables undo", async () => {
      expect(mgr.canUndo).toBe(false);

      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();

      expect(mgr.canUndo).toBe(true);
      expect(mgr.canRedo).toBe(false);
    });

    it("fires onStateChanged when transaction is recorded", async () => {
      const spy = vi.fn();
      mgr.onStateChanged.add(spy);

      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();

      expect(spy).toHaveBeenCalled();
    });

    it("clears redo stack on new transaction", async () => {
      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();

      mgr.undo();
      await drain();

      expect(mgr.canRedo).toBe(true);

      mgr.recordTransaction(makeRecord(["w2"]));
      await drain();

      expect(mgr.canRedo).toBe(false);
    });
  });

  // ── Undo / redo cycle ──────────────────────────────────────────

  describe("undo / redo", () => {
    it("undo calls doc.undo with the correct record", async () => {
      const record = makeRecord(["w1"]);
      mgr.recordTransaction(record);
      await drain();

      mgr.undo();
      await drain();

      expect(doc.undo).toHaveBeenCalledWith(record);
    });

    it("undo → canRedo true, canUndo false", async () => {
      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();

      mgr.undo();
      await drain();

      expect(mgr.canUndo).toBe(false);
      expect(mgr.canRedo).toBe(true);
    });

    it("undo → redo → canUndo true", async () => {
      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();

      mgr.undo();
      await drain();

      mgr.redo();
      await drain();

      expect(mgr.canUndo).toBe(true);
      expect(mgr.canRedo).toBe(false);
    });

    it("sets sync.isUndoRedo during undo", async () => {
      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();

      let capturedFlag = false;
      (doc.undo as any).mockImplementation((r: TransactionRecord) => {
        capturedFlag = sync.isUndoRedo;
        return { mutations: r.mutations, timestamp: Date.now() };
      });

      mgr.undo();
      await drain();

      expect(capturedFlag).toBe(true);
      expect(sync.isUndoRedo).toBe(false); // reset after
    });

    it("calls navigateFragmentHistory on undo (after debounce)", async () => {
      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();

      mgr.undo();
      await drain(900); // wait for fast undo debounce (800ms) + chain

      expect(sync.navigateFragmentHistory).toHaveBeenCalled();
    });

    it("calls navigateFragmentHistory on redo (after debounce)", async () => {
      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();

      mgr.undo();
      await drain(900);

      mgr.redo();
      await drain(900);

      expect(sync.navigateFragmentHistory).toHaveBeenCalledTimes(2);
    });

    it("undo of creation shows previous entry's primary overlay", async () => {
      // Record two "add" transactions: create w1, then create w2
      const rec1: TransactionRecord = {
        mutations: [makeMutation("w1", "add")],
        timestamp: Date.now(),
      };
      const rec2: TransactionRecord = {
        mutations: [makeMutation("w2", "add")],
        timestamp: Date.now(),
      };

      // Simulate: w1 exists after rec1, w1+w2 exist after rec2
      (doc as any).contracts = new Map([
        ["w1", { id: "w1" }],
        ["w2", { id: "w2" }],
      ]);

      mgr.recordTransaction(rec1);
      await drain();
      mgr.recordTransaction(rec2);
      await drain();

      // Undo w2 creation — doc.undo removes w2 from contracts
      (doc.undo as any).mockImplementation((r: TransactionRecord) => {
        (doc as any).contracts.delete("w2");
        return {
          mutations: r.mutations.map((m) => ({
            ...m,
            type: "remove",
            before: m.after,
            after: m.before,
          })),
          timestamp: Date.now(),
        };
      });

      mgr.undo();
      await drain();

      // updateFastOverlays should be called with w1's ID (the previous
      // entry's primary), NOT w2 (which no longer has a contract).
      const lastCall = (sync.updateFastOverlays as any).mock.calls.at(-1);
      expect(lastCall[0]).toEqual(["w1"]);
    });

    it("makes model translucent during fast phase", async () => {
      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();

      mgr.undo();
      await drain(); // chain runs but debounce hasn't fired

      expect(sync.setModelTranslucency).toHaveBeenCalledWith(true);
      expect(sync.updateFastOverlays).toHaveBeenCalled();
      // navigateFragmentHistory NOT yet called
      expect(sync.navigateFragmentHistory).not.toHaveBeenCalled();

      // After debounce fires
      await drain(900);
      expect(sync.navigateFragmentHistory).toHaveBeenCalled();
      // Opacity restoration now happens inside navigateFragmentHistory (not testable via mock),
      // but cancelFast still restores it as a safety net.
    });
  });

  // ── isUndoRedo suppression ─────────────────────────────────────

  describe("isUndoRedo suppression", () => {
    it("ignores recordTransaction during undo", async () => {
      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();

      // Simulate: doc.undo triggers onTransactionCommit which calls recordTransaction
      (doc.undo as any).mockImplementation((r: TransactionRecord) => {
        // This would be called during undo — should be suppressed
        mgr.recordTransaction(makeRecord(["spurious"]));
        return { mutations: r.mutations, timestamp: Date.now() };
      });

      mgr.undo();
      await drain();

      // Should not have pushed spurious entry
      expect(mgr.canUndo).toBe(false);
      expect(mgr.canRedo).toBe(true);
    });
  });

  // ── Selection session ──────────────────────────────────────────

  describe("selection session", () => {
    it("accumulates mutations while extracted", async () => {
      sync.hasExtracted = true;

      mgr.recordTransaction(makeRecord(["w1"]));
      mgr.recordTransaction(makeRecord(["w2"]));

      // Not yet on undo stack (still in selection session)
      expect(mgr.canUndo).toBe(true); // selectionRecord exists

      sync.hasExtracted = false;
      mgr.finalizeSelectionRecord();
      await drain();

      expect(mgr.canUndo).toBe(true);
    });

    it("deduplicates by contract ID (keeps first before)", async () => {
      sync.hasExtracted = true;

      mgr.recordTransaction(makeRecord(["w1"]));
      mgr.recordTransaction(makeRecord(["w1"])); // duplicate

      sync.hasExtracted = false;
      mgr.finalizeSelectionRecord();
      await drain();

      // Undo should have one entry with one mutation for w1
      mgr.undo();
      await drain();

      const calls = (doc.undo as any).mock.calls;
      const record = calls[calls.length - 1][0] as TransactionRecord;
      expect(record.mutations.length).toBe(1);
      expect(record.mutations[0].id).toBe("w1");
    });
  });

  // ── Grouped transactions ───────────────────────────────────────

  describe("grouped transactions", () => {
    it("merges mutations with same groupId", async () => {
      mgr.recordTransaction(makeRecord(["w1"], { groupId: "drag-1" }));
      mgr.recordTransaction(makeRecord(["w2"], { groupId: "drag-1" }));

      expect(mgr.canUndo).toBe(true); // pendingGroupRecord exists

      // Finalize and check: one entry with both mutations
      mgr.finalizePendingGroup();
      await drain();

      mgr.undo();
      await drain();

      const calls = (doc.undo as any).mock.calls;
      const record = calls[calls.length - 1][0] as TransactionRecord;
      expect(record.mutations.length).toBe(2);
    });

    it("finalizes previous group when groupId changes", async () => {
      mgr.recordTransaction(makeRecord(["w1"], { groupId: "drag-1" }));
      mgr.recordTransaction(makeRecord(["w2"], { groupId: "drag-2" }));
      await drain();

      // drag-1 should be finalized, drag-2 is pending
      mgr.finalizePendingGroup();
      await drain();

      // Two separate undo entries
      mgr.undo();
      await drain();
      expect(mgr.canUndo).toBe(true); // still have drag-1
    });
  });

  // ── Same-fragIndex coalescing ──────────────────────────────────

  describe("same-fragIndex coalescing", () => {
    it("merges records at the same fragment index", async () => {
      // Force flush to return same fragIndex
      sync.flush = vi.fn(async () => {
        /* don't increment */
      }) as any;
      sync._fragIndex = 0;

      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();
      mgr.recordTransaction(makeRecord(["w2"]));
      await drain();

      // Both should be merged into one entry
      mgr.undo();
      await drain();

      const calls = (doc.undo as any).mock.calls;
      const record = calls[calls.length - 1][0] as TransactionRecord;
      expect(record.mutations.length).toBe(2);
    });
  });

  // ── Reset ──────────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all state", async () => {
      mgr.recordTransaction(makeRecord(["w1"]));
      await drain();
      expect(mgr.canUndo).toBe(true);

      mgr.reset();

      expect(mgr.canUndo).toBe(false);
      expect(mgr.canRedo).toBe(false);
    });

    it("fires onStateChanged", () => {
      const spy = vi.fn();
      mgr.onStateChanged.add(spy);
      mgr.reset();
      expect(spy).toHaveBeenCalled();
    });
  });
});
