/**
 * Shared contract types — the foundation all element types build on.
 * Element-specific contracts, factories, and resolvers live in their
 * own element files (e.g., src/elements/wall.ts).
 */

export type ContractId = string;
export type JoinType = "butt" | "miter";

/** Base interface for all contracts. Custom element types extend this. */
export interface BaseContract {
  id: ContractId;
  kind: string;
  [key: string]: unknown;
}

/**
 * Open contract type — any object with id + kind.
 * New element types extend BaseContract without modifying this file.
 */
export type AnyContract = BaseContract;
