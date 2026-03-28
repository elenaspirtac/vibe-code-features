import { TypedEvent } from "./events";
import { Transaction } from "./transaction";
import type { TransactionRecord } from "./transaction";
import type { ContractId, AnyContract } from "./contracts";
import type { SpatialIndex } from "../utils/spatial-index";
import type { ElementRegistry } from "./registry";
import type { FragmentElementIds, SharedReprIds } from "../fragments/writer";

export class BimDocument {
  readonly contracts = new Map<ContractId, AnyContract>();

  /** Optional spatial index for O(log n) spatial queries. Set externally. */
  spatialIndex?: SpatialIndex;

  /** Optional element registry for snap point providers. Set externally. */
  registry?: ElementRegistry;

  /** Maps contract ID → all fragment sub-entity localIds */
  readonly fragmentIds = new Map<ContractId, FragmentElementIds>();

  /** Maps type contract ID → geoHash → shared repr/lt/mat fragment IDs.
   *  Representations are owned at the type level and shared across instances. */
  readonly typeReprIds = new Map<ContractId, Map<string, SharedReprIds>>();

  readonly onAdded = new TypedEvent<AnyContract>();
  readonly onUpdated = new TypedEvent<{ contract: AnyContract; patchKeys: string[] }>();
  readonly onRemoved = new TypedEvent<ContractId>();
  readonly onTransactionCommit = new TypedEvent<TransactionRecord>();

  private activeTransaction: Transaction | null = null;

  /**
   * When set, auto-wrapped transactions (from add/update/remove without
   * an explicit transaction) will use this groupId. Consumers use this
   * to coalesce rapid-fire updates (e.g. drag) into a single undo step.
   */
  transactionGroupId: string | null = null;

  /**
   * Resolves cascade deletions. Given an ID about to be removed,
   * returns additional IDs that should be removed in the same transaction.
   */
  private cascadeResolver:
    | ((id: ContractId, doc: BimDocument) => ContractId[])
    | null = null;

  setCascadeResolver(
    fn: (id: ContractId, doc: BimDocument) => ContractId[]
  ): void {
    this.cascadeResolver = fn;
  }

  /**
   * Group mutations into an atomic transaction.
   * Events fire immediately (overlays update per-frame during drag).
   * The transaction records mutations for undo/redo.
   */
  transaction(
    fn: () => void,
    options?: { groupId?: string }
  ): TransactionRecord {
    if (this.activeTransaction) {
      // Already inside a transaction — just run the body, mutations join it
      fn();
      return this.activeTransaction.commit(); // caller ignores this
    }

    const txn = new Transaction();
    this.activeTransaction = txn;
    try {
      fn();
      const record = txn.commit();
      if (options?.groupId) record.groupId = options.groupId;
      this.onTransactionCommit.trigger(record);
      return record;
    } catch (e) {
      this.rollback(txn);
      throw e;
    } finally {
      this.activeTransaction = null;
    }
  }

  add(contract: AnyContract): void {
    if (!this.activeTransaction) {
      const opts = this.transactionGroupId ? { groupId: this.transactionGroupId } : undefined;
      this.transaction(() => this.add(contract), opts);
      return;
    }
    this.activeTransaction.recordAdd(contract);
    this.contracts.set(contract.id, contract);
    this.onAdded.trigger(contract);
  }

  update(id: ContractId, patch: Record<string, unknown>): void {
    if (!this.activeTransaction) {
      const opts = this.transactionGroupId ? { groupId: this.transactionGroupId } : undefined;
      this.transaction(() => this.update(id, patch), opts);
      return;
    }
    const existing = this.contracts.get(id);
    if (!existing) return;
    this.activeTransaction.recordUpdate(existing, { ...existing, ...patch, id } as AnyContract);
    const updated = { ...existing, ...patch, id } as AnyContract;
    this.contracts.set(id, updated);
    this.onUpdated.trigger({ contract: updated, patchKeys: Object.keys(patch) });
  }

  remove(id: ContractId): void {
    if (!this.activeTransaction) {
      const opts = this.transactionGroupId ? { groupId: this.transactionGroupId } : undefined;
      this.transaction(() => this.remove(id), opts);
      return;
    }
    // Resolve cascade BEFORE removing the element — the resolver needs
    // the contract still in the map to read its relationships.
    const cascadeIds = this.cascadeResolver?.(id, this) ?? [];

    this.removeOne(id);

    for (const cascadeId of cascadeIds) {
      this.removeOne(cascadeId);
    }
  }

  /**
   * Undo a transaction by applying its mutations in reverse.
   * Skips cascade (the original transaction already has all cascaded removals).
   * Returns a redo record that can be passed to undo() to redo.
   */
  undo(record: TransactionRecord): TransactionRecord {
    const txn = new Transaction();
    this.activeTransaction = txn;
    try {
      for (let i = record.mutations.length - 1; i >= 0; i--) {
        const m = record.mutations[i];
        switch (m.type) {
          case "add":
            // Undo add = remove (skip cascade — txn already has all removals)
            this.removeOne(m.id);
            break;
          case "update":
            if (m.before) this.update(m.id, m.before);
            break;
          case "remove":
            if (m.before) {
              this.add(m.before);
              // Restore fragment mapping so sync can delete the fragment on re-remove
              if (m.fragmentId !== undefined) {
                this.fragmentIds.set(m.id, m.fragmentId);
              }
            }
            break;
        }
      }
      const redoRecord = txn.commit();
      this.onTransactionCommit.trigger(redoRecord);
      return redoRecord;
    } finally {
      this.activeTransaction = null;
    }
  }

  /**
   * Serialize contracts and fragmentIds for persistence.
   * Accepts an optional `stampVersion` callback to add `_v` fields
   * to each contract (schema versioning, S.7).
   */
  toJSON(stampVersion?: (kind: string) => number): {
    contracts: [ContractId, AnyContract][];
    fragmentIds: [ContractId, FragmentElementIds][];
    typeReprIds: [ContractId, [string, SharedReprIds][]][];
  } {
    const contracts: [ContractId, AnyContract][] = [];
    for (const [id, contract] of this.contracts) {
      if (stampVersion) {
        contracts.push([id, { ...contract, _v: stampVersion(contract.kind) } as AnyContract]);
      } else {
        contracts.push([id, contract]);
      }
    }
    const typeReprIds: [ContractId, [string, SharedReprIds][]][] = [];
    for (const [typeId, hashMap] of this.typeReprIds) {
      typeReprIds.push([typeId, [...hashMap.entries()]]);
    }
    return {
      contracts,
      fragmentIds: [...this.fragmentIds.entries()],
      typeReprIds,
    };
  }

  /**
   * Restore contracts and fragmentIds from serialized data. No events fire.
   * Accepts an optional `migrate` callback to transform each raw contract
   * before insertion (schema migration, S.7).
   */
  loadFromJSON(
    data: {
      contracts: [ContractId, Record<string, unknown>][];
      fragmentIds: [ContractId, FragmentElementIds][];
      typeReprIds?: [ContractId, [string, SharedReprIds][]][];
    },
    migrate?: (contracts: [ContractId, Record<string, unknown>][]) => [ContractId, Record<string, unknown>][]
  ): void {
    this.contracts.clear();
    this.fragmentIds.clear();
    this.typeReprIds.clear();
    const contracts = migrate ? migrate(data.contracts) : data.contracts;
    for (const [id, contract] of contracts) {
      this.contracts.set(id, contract as unknown as AnyContract);
    }
    for (const [id, localId] of data.fragmentIds) {
      // Migration: old flat shape → new multi-sample shape
      if ("sampleId" in localId && !("samples" in localId)) {
        const flat = localId as any;
        this.fragmentIds.set(id, {
          itemId: flat.itemId,
          gtId: flat.gtId,
          samples: [{ sampleId: flat.sampleId, reprId: flat.reprId, ltId: flat.ltId, matId: flat.matId }],
        });
      } else {
        this.fragmentIds.set(id, localId);
      }
    }
    if (data.typeReprIds) {
      for (const [typeId, entries] of data.typeReprIds) {
        this.typeReprIds.set(typeId, new Map(entries));
      }
    }
  }

  /** Reverse lookup: fragment item localId → contract */
  getContractByFragmentId(localId: number): AnyContract | undefined {
    for (const [contractId, ids] of this.fragmentIds) {
      if (ids.itemId === localId) return this.contracts.get(contractId);
    }
    return undefined;
  }

  // ── Private ──────────────────────────────────────────────────────

  private removeOne(id: ContractId) {
    const contract = this.contracts.get(id);
    if (!contract) return;
    const fragmentIds = this.fragmentIds.get(id);
    this.activeTransaction?.recordRemove(contract, fragmentIds);
    // Fire event before deleting so listeners can still read the contract
    this.onRemoved.trigger(id);
    this.contracts.delete(id);
    this.fragmentIds.delete(id);
  }

  /** Reverse all mutations in a failed transaction (error recovery, not undo). */
  private rollback(txn: Transaction) {
    for (let i = txn.mutations.length - 1; i >= 0; i--) {
      const m = txn.mutations[i];
      switch (m.type) {
        case "add":
          this.contracts.delete(m.id);
          this.fragmentIds.delete(m.id);
          break;
        case "update":
          if (m.before) this.contracts.set(m.id, m.before);
          break;
        case "remove":
          if (m.before) this.contracts.set(m.id, m.before);
          if (m.fragmentId !== undefined) this.fragmentIds.set(m.id, m.fragmentId);
          break;
      }
    }
  }
}
