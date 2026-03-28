import type { ElementTypeDefinition, ElementRelationship } from "../core/registry";
import type { BaseContract, ContractId } from "../core/contracts";

// ── Contract ──────────────────────────────────────────────────────

export interface WallTypeContract extends BaseContract {
  kind: "wallType";
  name: string;
  height: number;       // defaultable — instances can override
  thickness: number;    // type-only — all walls of this type share it
  materials?: Record<string, ContractId>;  // slot name → material contract ID
}

export function isWallType(c: { kind: string }): c is WallTypeContract {
  return c.kind === "wallType";
}

export function createWallType(
  options?: Partial<Pick<WallTypeContract, "name" | "height" | "thickness">>
): WallTypeContract {
  return {
    id: crypto.randomUUID(),
    kind: "wallType",
    name: options?.name ?? "Wall Type",
    height: options?.height ?? 3.0,
    thickness: options?.thickness ?? 0.2,
  };
}

// ── Element definition ────────────────────────────────────────────

export const wallTypeElement: ElementTypeDefinition = {
  kind: "wallType",
  dataOnly: true,
  metadataKeys: ["name"],
  instanceKind: "wall",
  typeGroupLabel: "Wall Types",
  materialSlots: ["body"],
  createDefault: () => createWallType(),
  typeParams: [
    { key: "height", label: "Height", category: "defaultable", inputType: "number", step: 0.1, min: 0.5, max: 20, fallback: 3.0, summaryPrefix: "H", summaryUnit: "m" },
    { key: "thickness", label: "Thickness", category: "type-only", inputType: "number", step: 0.01, min: 0.05, max: 2, fallback: 0.2, summaryPrefix: "T", summaryUnit: "m" },
  ],

  generateGeometry() {
    throw new Error("wallType has no geometry — it is a data-only type contract");
  },

  getRelationships(contract) {
    const wt = contract as WallTypeContract;
    const rels: ElementRelationship[] = [];
    if (wt.materials) {
      for (const matId of Object.values(wt.materials)) {
        if (matId) rels.push({ type: "usesMaterial", targetId: matId });
      }
    }
    return rels;
  },
};
