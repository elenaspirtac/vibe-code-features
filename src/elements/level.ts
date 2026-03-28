import type { ElementTypeDefinition } from "../core/registry";
import type { BaseContract } from "../core/contracts";

// ── Contract ──────────────────────────────────────────────────────

export interface LevelContract extends BaseContract {
  kind: "level";
  name: string;
  elevation: number; // Y coordinate in meters
}

export function isLevel(c: { kind: string }): c is LevelContract {
  return c.kind === "level";
}

export function createLevel(
  name: string,
  elevation: number
): LevelContract {
  return {
    id: crypto.randomUUID(),
    kind: "level",
    name,
    elevation,
  };
}

// ── Element definition ────────────────────────────────────────────

export const levelElement: ElementTypeDefinition = {
  kind: "level",
  dataOnly: true,
  metadataKeys: ["name"],

  generateGeometry() {
    throw new Error("level has no geometry — it is a data-only contract");
  },

  getRelationships() {
    return [];
  },
};
