import type { ElementTypeDefinition, ElementRelationship } from "../core/registry";
import type { BaseContract, ContractId } from "../core/contracts";

// ── Contract ──────────────────────────────────────────────────────

export interface ColumnTypeContract extends BaseContract {
  kind: "columnType";
  name: string;
  height: number;       // type-only
  width: number;        // type-only (square cross-section side length)
  materials?: Record<string, ContractId>;
}

export function isColumnType(c: { kind: string }): c is ColumnTypeContract {
  return c.kind === "columnType";
}

export function createColumnType(
  options?: Partial<Pick<ColumnTypeContract, "name" | "height" | "width">>
): ColumnTypeContract {
  return {
    id: crypto.randomUUID(),
    kind: "columnType",
    name: options?.name ?? "Column Type",
    height: options?.height ?? 3.0,
    width: options?.width ?? 0.3,
  };
}

// ── Element definition ────────────────────────────────────────────

export const columnTypeElement: ElementTypeDefinition = {
  kind: "columnType",
  dataOnly: true,
  metadataKeys: ["name"],
  instanceKind: "column",
  typeGroupLabel: "Column Types",
  materialSlots: ["body"],
  createDefault: () => createColumnType(),
  typeParams: [
    { key: "height", label: "Height", category: "type-only", inputType: "number", step: 0.1, min: 0.5, max: 20, fallback: 3.0, summaryPrefix: "H", summaryUnit: "m" },
    { key: "width", label: "Width", category: "type-only", inputType: "number", step: 0.01, min: 0.05, max: 2, fallback: 0.3, summaryPrefix: "W", summaryUnit: "m" },
  ],

  generateGeometry() {
    throw new Error("columnType has no geometry — it is a data-only type contract");
  },

  getRelationships(contract) {
    const ct = contract as ColumnTypeContract;
    const rels: ElementRelationship[] = [];
    if (ct.materials) {
      for (const matId of Object.values(ct.materials)) {
        if (matId) rels.push({ type: "usesMaterial", targetId: matId });
      }
    }
    return rels;
  },
};
