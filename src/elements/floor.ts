import type {
  ElementTypeDefinition,
  ElementRelationship,
} from "../core/registry";
import type { BaseContract, ContractId } from "../core/contracts";
import { generateFloorGeometry } from "../generators/floor";
import { FloorHandles } from "../handles/floor-handles";

// ── Contract ──────────────────────────────────────────────────────

export type FloorBoundaryVertex =
  | { type: "wallEndpoint"; wallId: ContractId; endpoint: "start" | "end" }
  | { type: "free"; position: [number, number, number] };

export interface FloorContract extends BaseContract {
  kind: "floor";
  boundary: FloorBoundaryVertex[];
  thickness: number;
  elevation: number;
}

export function isFloor(c: { kind: string }): c is FloorContract {
  return c.kind === "floor";
}

export function createFloor(
  boundary: FloorBoundaryVertex[],
  options?: Partial<Pick<FloorContract, "thickness" | "elevation">>
): FloorContract {
  return {
    id: crypto.randomUUID(),
    kind: "floor",
    boundary,
    thickness: options?.thickness ?? 0.2,
    elevation: options?.elevation ?? 0,
  };
}

// ── Element definition ────────────────────────────────────────────

export const floorElement: ElementTypeDefinition = {
  kind: "floor",

  generateGeometry(engine, contract, doc) {
    return generateFloorGeometry(engine, contract as FloorContract, doc);
  },

  getRelationships(contract, _doc) {
    const floor = contract as FloorContract;
    const rels: ElementRelationship[] = [];
    const seen = new Set<string>();

    if (floor.levelId) {
      rels.push({ type: "belongsToLevel", targetId: floor.levelId as string });
    }

    for (const v of floor.boundary) {
      if (v.type === "wallEndpoint" && !seen.has(v.wallId)) {
        seen.add(v.wallId);
        rels.push({ type: "connectedTo", targetId: v.wallId });
      }
    }

    return rels;
  },

  createHandles(scene, doc, engine, contract) {
    return new FloorHandles(scene, doc, engine, contract as FloorContract);
  },

  applyTranslation(contract, delta) {
    const floor = contract as FloorContract;
    return {
      ...floor,
      elevation: floor.elevation + delta[1],
      boundary: floor.boundary.map((v) => {
        if (v.type === "free") {
          return {
            ...v,
            position: [
              v.position[0] + delta[0],
              v.position[1] + delta[1],
              v.position[2] + delta[2],
            ] as [number, number, number],
          };
        }
        return v; // wallEndpoint vertices resolve from their host wall
      }),
    };
  },

  remapIds(contract, idMap) {
    const floor = contract as FloorContract;
    return {
      ...floor,
      boundary: floor.boundary.map((v): FloorBoundaryVertex => {
        if (v.type === "wallEndpoint") {
          const newWallId = idMap.get(v.wallId);
          if (newWallId) return { ...v, wallId: newWallId };
          // Wall not in copied set — resolve to a free point (position will be
          // computed during paste from the original wall's current position)
          return v; // keep as wallEndpoint referencing original wall
        }
        return v;
      }),
    };
  },
};
