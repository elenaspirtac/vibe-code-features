import type { ElementTypeDefinition, ElementRelationship } from "../core/registry";
import type { BaseContract, ContractId } from "../core/contracts";

// ── Contract ──────────────────────────────────────────────────────

export interface DoorTypeContract extends BaseContract {
  kind: "doorType";
  name: string;
  width: number;   // defaultable
  height: number;  // defaultable
  materials?: Record<string, ContractId>;
}

export function isDoorType(c: { kind: string }): c is DoorTypeContract {
  return c.kind === "doorType";
}

export function createDoorType(
  options?: Partial<Pick<DoorTypeContract, "name" | "width" | "height">>
): DoorTypeContract {
  return {
    id: crypto.randomUUID(),
    kind: "doorType",
    name: options?.name ?? "Door Type",
    width: options?.width ?? 0.9,
    height: options?.height ?? 2.1,
  };
}

// ── Element definition ────────────────────────────────────────────

export const doorTypeElement: ElementTypeDefinition = {
  kind: "doorType",
  dataOnly: true,
  metadataKeys: ["name"],
  instanceKind: "door",
  typeGroupLabel: "Door Types",
  materialSlots: ["frame", "panel"],
  createDefault: () => createDoorType(),
  typeParams: [
    { key: "width", label: "Width", category: "defaultable", inputType: "number", step: 0.1, min: 0.5, max: 3, fallback: 0.9, summaryPrefix: "W" },
    { key: "height", label: "Height", category: "defaultable", inputType: "number", step: 0.1, min: 1.5, max: 5, fallback: 2.1, summaryPrefix: "H" },
  ],

  generateGeometry() {
    throw new Error("doorType has no geometry — it is a data-only type contract");
  },

  getRelationships(contract) {
    const dt = contract as DoorTypeContract;
    const rels: ElementRelationship[] = [];
    if (dt.materials) {
      for (const matId of Object.values(dt.materials)) {
        if (matId) rels.push({ type: "usesMaterial", targetId: matId });
      }
    }
    return rels;
  },
};
