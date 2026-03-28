import * as THREE from "three";
import type {
  ElementTypeDefinition,
  ElementRelationship,
} from "../core/registry";
import type {
  AnyContract,
  BaseContract,
  ContractId,
  JoinType,
} from "../core/contracts";
import type { WallTypeContract } from "./wall-type";
import type { BimDocument } from "../core/document";

// ── Contract ──────────────────────────────────────────────────────

export interface WallContract extends BaseContract {
  kind: "wall";
  typeId: ContractId;
  start: [number, number, number];
  end: [number, number, number];
  height?: number;      // override type default; undefined = use type value
  // thickness is type-only — not on instances
  offset: number;
  startJoin: JoinType;
  endJoin: JoinType;
  startTJunction?: ContractId;
  endTJunction?: ContractId;
  /** IDs of elements this wall cuts via boolean DIFFERENCE. */
  cutTargets?: ContractId[];
}

export function isWall(c: { kind: string }): c is WallContract {
  return c.kind === "wall";
}

export function createWall(
  start: [number, number, number],
  end: [number, number, number],
  typeId: ContractId,
  options?: Partial<Pick<WallContract, "height" | "offset">>
): WallContract {
  return {
    id: crypto.randomUUID(),
    kind: "wall",
    start,
    end,
    typeId,
    height: options?.height,
    offset: options?.offset ?? 0,
    startJoin: "miter",
    endJoin: "miter",
  };
}

/** Resolved wall parameters — all values guaranteed present. */
export interface ResolvedWallParams {
  height: number;
  thickness: number;
}

/** Wall contract with all params resolved. */
export type ResolvedWall = WallContract & ResolvedWallParams;

export function resolveWallParams(
  wall: WallContract,
  doc: { contracts: ReadonlyMap<ContractId, AnyContract> }
): ResolvedWallParams {
  const type = doc.contracts.get(wall.typeId) as WallTypeContract | undefined;
  return {
    thickness: type?.thickness ?? 0.2,
    height: wall.height ?? type?.height ?? 3.0,
  };
}
/** Query all elements hosted on a wall (windows, etc.) by scanning contracts. */
export function getHostedElements(wallId: ContractId, doc: { contracts: ReadonlyMap<ContractId, AnyContract> }): ContractId[] {
  const ids: ContractId[] = [];
  for (const [, c] of doc.contracts) {
    if ((c as any).hostId === wallId) ids.push(c.id);
  }
  return ids;
}

import {
  generateWallGeometry,
  buildMiterCutBox,
  buildTJunctionCutBox,
  type MiterNeighbor,
  type TJunctionHost,
} from "../generators/wall";
import { findNeighborsAtEndpoint } from "../utils/joints";
import { WallHandles } from "../handles/wall-handles";
import type { BooleanOperand } from "../utils/boolean-cuts";

/** Gather miter neighbors for a wall, resolving type params. */
function gatherMiterNeighbors(
  wall: WallContract,
  doc: BimDocument
): MiterNeighbor[] | undefined {
  const neighbors: MiterNeighbor[] = [];
  if (wall.startJoin === "miter") {
    for (const n of findNeighborsAtEndpoint(doc, wall.id, "start")) {
      if (isWall(n)) neighbors.push({ endpoint: "start", neighbor: resolveWall(n, doc) });
    }
  }
  if (wall.endJoin === "miter") {
    for (const n of findNeighborsAtEndpoint(doc, wall.id, "end")) {
      if (isWall(n)) neighbors.push({ endpoint: "end", neighbor: resolveWall(n, doc) });
    }
  }
  return neighbors.length > 0 ? neighbors : undefined;
}

/** Gather T-junction hosts for a wall, resolving type params. */
function gatherTJunctions(
  wall: WallContract,
  doc: BimDocument
): TJunctionHost[] | undefined {
  const junctions: TJunctionHost[] = [];
  for (const [ep, hostId] of [
    ["start", wall.startTJunction] as const,
    ["end", wall.endTJunction] as const,
  ]) {
    if (!hostId) continue;
    const host = doc.contracts.get(hostId);
    if (host && isWall(host)) {
      junctions.push({ endpoint: ep, host: resolveWall(host, doc) });
    }
  }
  return junctions.length > 0 ? junctions : undefined;
}

/**
 * Resolve wall dimensions from type + instance overrides.
 * Returns a wall-like object with all params guaranteed present.
 */
function resolveWall(wall: WallContract, doc: { contracts: ReadonlyMap<string, any> }): ResolvedWall {
  const params = resolveWallParams(wall, doc);
  return { ...wall, height: params.height, thickness: params.thickness };
}

export const wallElement: ElementTypeDefinition = {
  kind: "wall",
  typeKind: "wallType",

  renderCustomProperties(contract, container, helpers) {
    const wall = contract as WallContract;
    helpers.addField(container, "Offset", wall.offset, 0.01, -1, 1, (v) =>
      helpers.debouncedUpdate(wall.id, { offset: v }));
    const dx = wall.end[0] - wall.start[0];
    const dz = wall.end[2] - wall.start[2];
    helpers.addReadOnlyField(container, "Length", Math.sqrt(dx * dx + dz * dz));

    // Top level constraint dropdown
    const levels: { id: string; label: string }[] = [];
    for (const [, c] of helpers.doc.contracts) {
      if (c.kind === "level") levels.push({ id: c.id, label: `${(c as any).name} (${(c as any).elevation}m)` });
    }
    levels.sort((a, b) => {
      const la = helpers.doc.contracts.get(a.id) as any;
      const lb = helpers.doc.contracts.get(b.id) as any;
      return (la?.elevation ?? 0) - (lb?.elevation ?? 0);
    });
    helpers.addSelectField(container, "Top Level", (wall as any).topLevelId ?? null, levels, (v) => {
      const patch: Record<string, unknown> = { topLevelId: v };
      if (v) {
        // Recalculate height from base level to top level
        const topLevel = helpers.doc.contracts.get(v);
        const baseLevel = wall.levelId ? helpers.doc.contracts.get(wall.levelId as string) : null;
        if (topLevel && baseLevel && (topLevel as any).elevation != null && (baseLevel as any).elevation != null) {
          patch.height = (topLevel as any).elevation - (baseLevel as any).elevation;
        }
      }
      helpers.doc.update(wall.id, patch);
    });
  },

  onRemove(contract, doc) {
    const wall = contract as WallContract;
    for (const [, c] of doc.contracts) {
      if (c.id === wall.id) continue;

      // Clean up T-junction refs on other walls pointing to this wall
      if (c.kind === "wall") {
        const other = c as WallContract;
        const patch: Record<string, unknown> = {};
        if (other.startTJunction === wall.id) patch.startTJunction = undefined;
        if (other.endTJunction === wall.id) patch.endTJunction = undefined;
        if (Object.keys(patch).length > 0) doc.update(other.id, patch);
      }

      // Convert floor boundary wallEndpoint refs to free vertices
      if (c.kind === "floor") {
        const floor = c as any;
        const boundary: any[] = floor.boundary;
        if (!boundary?.some((v: any) => v.type === "wallEndpoint" && v.wallId === wall.id)) continue;
        const newBoundary = boundary.map((v: any) => {
          if (v.type !== "wallEndpoint" || v.wallId !== wall.id) return v;
          const pos = v.endpoint === "start" ? wall.start : wall.end;
          return { type: "free", position: [...pos] };
        });
        doc.update(c.id, { boundary: newBoundary });
      }
    }
  },

  generateGeometry(engine, contract, doc) {
    const wall = resolveWall(contract as WallContract, doc);
    // Base geometry with joint extensions — no boolean cuts.
    // Booleans are applied by the registry via getBooleanOperands.
    const miterNeighbors = gatherMiterNeighbors(wall, doc);
    const tJunctions = gatherTJunctions(wall, doc);
    return generateWallGeometry(engine, wall, miterNeighbors, tJunctions);
  },

  getBooleanOperands(_engine, contract, doc) {
    const wall = resolveWall(contract as WallContract, doc);
    const operands: BooleanOperand[] = [];

    // Hosted element voids (windows, doors, etc.) — uses registry
    // so any hosted element with getVoidGeometry cuts the wall.
    const registry = doc.registry;
    for (const childId of getHostedElements(wall.id, doc)) {
      const child = doc.contracts.get(childId);
      if (!child) continue;
      const def = registry?.get(child.kind);
      const voidMesh = def?.getVoidGeometry?.(_engine, child, doc);
      if (voidMesh) operands.push({ type: "DIFFERENCE", mesh: voidMesh });
    }

    // Miter cut boxes
    const miterNeighbors = gatherMiterNeighbors(wall, doc);
    if (miterNeighbors) {
      for (const { endpoint, neighbor } of miterNeighbors) {
        const cutMesh = buildMiterCutBox(wall, endpoint, neighbor);
        if (cutMesh) operands.push({ type: "DIFFERENCE", mesh: cutMesh });
      }
    }

    // T-junction cut boxes
    const tJunctions = gatherTJunctions(wall, doc);
    if (tJunctions) {
      const wallDir = new THREE.Vector3(
        wall.end[0] - wall.start[0],
        wall.end[1] - wall.start[1],
        wall.end[2] - wall.start[2]
      ).normalize();
      for (const { endpoint, host } of tJunctions) {
        const cutMesh = buildTJunctionCutBox(wall, endpoint, wallDir, host);
        if (cutMesh) operands.push({ type: "DIFFERENCE", mesh: cutMesh });
      }
    }

    return operands;
  },

  getVoidGeometry(engine, contract, doc) {
    const wall = resolveWall(contract as WallContract, doc);
    const geo = generateWallGeometry(engine, wall);
    const mesh = new THREE.Mesh(geo);
    mesh.updateMatrixWorld(true);
    return mesh;
  },

  getRelationships(contract, doc) {
    const wall = contract as WallContract;
    const rels: ElementRelationship[] = [];

    // Type reference
    if (wall.typeId) {
      rels.push({ type: "instanceOf", targetId: wall.typeId });
    }

    // Level relationships
    if (wall.levelId) {
      rels.push({ type: "belongsToLevel", targetId: wall.levelId as string });
    }
    if ((wall as any).topLevelId) {
      rels.push({ type: "constrainedToLevel", targetId: (wall as any).topLevelId });
    }

    // Hosted windows (derived from querying contracts by hostId)
    for (const childId of getHostedElements(wall.id, doc)) {
      rels.push({ type: "hosts", targetId: childId });
    }

    // Miter neighbors
    const seen = new Set<string>();
    for (const ep of ["start", "end"] as const) {
      const joinType = ep === "start" ? wall.startJoin : wall.endJoin;
      if (joinType !== "miter") continue;
      for (const n of findNeighborsAtEndpoint(doc, wall.id, ep)) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          rels.push({ type: "connectedTo", targetId: n.id });
        }
      }
    }

    // T-junction hosts
    for (const hostId of [wall.startTJunction, wall.endTJunction]) {
      if (hostId && !seen.has(hostId)) {
        seen.add(hostId);
        rels.push({ type: "connectedTo", targetId: hostId });
      }
    }

    // Ad-hoc cuts
    if (wall.cutTargets) {
      for (const targetId of wall.cutTargets) {
        rels.push({ type: "cuts", targetId });
      }
    }

    return rels;
  },

  createHandles(scene, doc, engine, contract) {
    return new WallHandles(scene, doc, engine, contract);
  },

  getLinearEdges(contract, doc) {
    const wall = contract as WallContract;
    const { thickness } = resolveWallParams(wall, doc);
    return [{
      startId: "start",
      endId: "end",
      start: wall.start,
      end: wall.end,
      expansion: thickness / 2,
    }];
  },

  getSpatialBounds(contract, doc) {
    const wall = contract as WallContract;
    const { thickness } = resolveWallParams(wall, doc);
    const halfT = thickness / 2;
    return {
      min: [
        Math.min(wall.start[0], wall.end[0]) - halfT,
        Math.min(wall.start[1], wall.end[1]),
        Math.min(wall.start[2], wall.end[2]) - halfT,
      ],
      max: [
        Math.max(wall.start[0], wall.end[0]) + halfT,
        Math.max(wall.start[1], wall.end[1]),
        Math.max(wall.start[2], wall.end[2]) + halfT,
      ],
    };
  },

  getEndpointPosition(contract, endpointId) {
    const wall = contract as WallContract;
    if (endpointId === "start") return wall.start;
    if (endpointId === "end") return wall.end;
    return null;
  },

  applyTranslation(contract, delta) {
    const wall = contract as WallContract;
    return {
      ...wall,
      start: [wall.start[0] + delta[0], wall.start[1] + delta[1], wall.start[2] + delta[2]] as [number, number, number],
      end: [wall.end[0] + delta[0], wall.end[1] + delta[1], wall.end[2] + delta[2]] as [number, number, number],
    };
  },

  remapIds(contract, idMap) {
    const wall = contract as WallContract;
    return {
      ...wall,
      // T-junctions: remap if target is in copied set, else clear
      startTJunction: wall.startTJunction ? idMap.get(wall.startTJunction) ?? undefined : undefined,
      endTJunction: wall.endTJunction ? idMap.get(wall.endTJunction) ?? undefined : undefined,
      // Ad-hoc cuts: remap targets in copied set, drop others
      cutTargets: wall.cutTargets?.map(id => idMap.get(id)).filter((id): id is ContractId => id !== undefined),
    };
  },
};
