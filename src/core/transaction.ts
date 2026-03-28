import type { ContractId, AnyContract } from "./contracts";
import type { FragmentElementIds } from "../fragments/writer";

export interface MutationRecord {
  type: "add" | "update" | "remove";
  id: ContractId;
  before: AnyContract | null;
  after: AnyContract | null;
  /** Preserved on remove so undo can restore the fragment mapping. */
  fragmentId?: FragmentElementIds;
}

export interface TransactionRecord {
  mutations: MutationRecord[];
  timestamp: number;
  groupId?: string;
}

export class Transaction {
  readonly mutations: MutationRecord[] = [];

  recordAdd(contract: AnyContract) {
    this.mutations.push({ type: "add", id: contract.id, before: null, after: contract });
  }

  recordUpdate(before: AnyContract, after: AnyContract) {
    this.mutations.push({ type: "update", id: before.id, before: { ...before }, after });
  }

  recordRemove(contract: AnyContract, fragmentId?: FragmentElementIds) {
    this.mutations.push({
      type: "remove",
      id: contract.id,
      before: { ...contract },
      after: null,
      fragmentId,
    });
  }

  commit(): TransactionRecord {
    return {
      mutations: this.mutations,
      timestamp: Date.now(),
    };
  }
}
