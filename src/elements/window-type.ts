import type { ElementTypeDefinition, ElementRelationship } from "../core/registry";
import type { BaseContract, ContractId } from "../core/contracts";

// ── Contract ──────────────────────────────────────────────────────

export interface WindowTypeContract extends BaseContract {
  kind: "windowType";
  name: string;
  width: number;        // defaultable
  height: number;       // defaultable
  sillHeight: number;   // defaultable
  materials?: Record<string, ContractId>;
}

export function isWindowType(c: { kind: string }): c is WindowTypeContract {
  return c.kind === "windowType";
}

export function createWindowType(
  options?: Partial<Pick<WindowTypeContract, "name" | "width" | "height" | "sillHeight">>
): WindowTypeContract {
  return {
    id: crypto.randomUUID(),
    kind: "windowType",
    name: options?.name ?? "Window Type",
    width: options?.width ?? 1.2,
    height: options?.height ?? 1.0,
    sillHeight: options?.sillHeight ?? 1.0,
  };
}

// ── Element definition ────────────────────────────────────────────

export const windowTypeElement: ElementTypeDefinition = {
  kind: "windowType",
  dataOnly: true,
  metadataKeys: ["name"],
  instanceKind: "window",
  typeGroupLabel: "Window Types",
  materialSlots: ["frame", "glass"],
  createDefault: () => createWindowType(),
  typeParams: [
    { key: "width", label: "Width", category: "defaultable", inputType: "number", step: 0.1, min: 0.3, max: 5, fallback: 1.2, summaryPrefix: "W" },
    { key: "height", label: "Height", category: "defaultable", inputType: "number", step: 0.1, min: 0.3, max: 5, fallback: 1.0, summaryPrefix: "H" },
    { key: "sillHeight", label: "Sill Height", category: "instance-only", inputType: "number", step: 0.1, min: 0, max: 10, fallback: 1.0, summaryPrefix: "Sill" },
  ],

  generateGeometry() {
    throw new Error("windowType has no geometry — it is a data-only type contract");
  },

  getRelationships(contract) {
    const wt = contract as WindowTypeContract;
    const rels: ElementRelationship[] = [];
    if (wt.materials) {
      for (const matId of Object.values(wt.materials)) {
        if (matId) rels.push({ type: "usesMaterial", targetId: matId });
      }
    }
    return rels;
  },
};
