import type { ElementTypeDefinition } from "../core/registry";
import type { BaseContract, ContractId } from "../core/contracts";

// ── Contract ──────────────────────────────────────────────────────

export interface MaterialContract extends BaseContract {
  kind: "material";
  name: string;
  color: [number, number, number]; // RGB 0-1
  opacity: number;                  // 0-1
  doubleSided: boolean;
  stroke: number;
}

export function isMaterial(c: { kind: string }): c is MaterialContract {
  return c.kind === "material";
}

/** Random pastel color in 0-1 range. */
function randomPastel(): [number, number, number] {
  const h = Math.random();
  const s = 0.3 + Math.random() * 0.3;
  const l = 0.6 + Math.random() * 0.2;
  // HSL to RGB
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return [f(0), f(8), f(4)];
}

export function createMaterial(
  options?: Partial<Pick<MaterialContract, "name" | "color" | "opacity" | "doubleSided" | "stroke">>
): MaterialContract {
  return {
    id: crypto.randomUUID(),
    kind: "material",
    name: options?.name ?? "Material",
    color: options?.color ?? randomPastel(),
    opacity: options?.opacity ?? 1,
    doubleSided: options?.doubleSided ?? true,
    stroke: options?.stroke ?? 0,
  };
}

// ── Element definition ────────────────────────────────────────────

export const materialElement: ElementTypeDefinition = {
  kind: "material",
  dataOnly: true,
  metadataKeys: ["name"],

  createDefault: () => createMaterial(),

  generateGeometry() {
    throw new Error("material has no geometry — it is a data-only contract");
  },

  getRelationships() {
    return [];
  },
};
