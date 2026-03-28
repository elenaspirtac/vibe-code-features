import * as THREE from "three";
import type {
  ElementTypeDefinition,
  ElementRelationship,
} from "../core/registry";
import type {
  AnyContract,
  BaseContract,
  ContractId,
} from "../core/contracts";
import type { DoorTypeContract } from "./door-type";
import { resolveWallParams } from "./wall";
import type { WallContract, ResolvedWall } from "./wall";
import { generateDoorGeometry, generateDoorPartsLocal, generateDoorVoid } from "../generators/door";
import { resolveMaterial } from "../utils/material-resolve";
import { HostedElementHandles } from "../handles/hosted-handles";

// ── Contract ──────────────────────────────────────────────────────

export interface DoorContract extends BaseContract {
  kind: "door";
  typeId: ContractId;
  hostId: ContractId;
  position: number;
  width?: number;
  height?: number;
}

export function isDoor(c: { kind: string }): c is DoorContract {
  return c.kind === "door";
}

export function createDoor(
  hostId: ContractId,
  position: number,
  typeId: ContractId,
  options?: Partial<Pick<DoorContract, "width" | "height">>
): DoorContract {
  return {
    id: crypto.randomUUID(),
    kind: "door",
    hostId,
    position: Math.max(0, Math.min(1, position)),
    typeId,
    width: options?.width,
    height: options?.height,
  };
}

/** Resolved door parameters — all values guaranteed present. */
export interface ResolvedDoorParams {
  width: number;
  height: number;
}

/** Door contract with all params resolved. */
export type ResolvedDoor = DoorContract & ResolvedDoorParams;

export function resolveDoorParams(
  door: DoorContract,
  doc: { contracts: ReadonlyMap<ContractId, AnyContract> }
): ResolvedDoorParams {
  const type = doc.contracts.get(door.typeId) as DoorTypeContract | undefined;
  return {
    width: door.width ?? type?.width ?? 0.9,
    height: door.height ?? type?.height ?? 2.1,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function resolveHost(door: DoorContract, doc: { contracts: ReadonlyMap<string, any> }): ResolvedWall | null {
  const host = doc.contracts.get(door.hostId) as WallContract | undefined;
  if (!host) return null;
  const params = resolveWallParams(host, doc);
  return { ...host, height: params.height, thickness: params.thickness };
}

function resolveDoor(door: DoorContract, doc: { contracts: ReadonlyMap<string, any> }): ResolvedDoor {
  const params = resolveDoorParams(door, doc);
  return { ...door, width: params.width, height: params.height };
}

// ── Element definition ────────────────────────────────────────────

const DEFAULT_FRAME_MAT = new THREE.MeshLambertMaterial({ color: 0xd6d6d1, side: THREE.DoubleSide });
const DEFAULT_PANEL_MAT = new THREE.MeshLambertMaterial({ color: 0xc8a882, side: THREE.DoubleSide });

export const doorElement: ElementTypeDefinition = {
  kind: "door",
  typeKind: "doorType",

  generateGeometry(_engine, contract, doc) {
    const door = resolveDoor(contract as DoorContract, doc);
    const host = resolveHost(door, doc);
    if (!host) throw new Error(`Door host wall not found: ${door.hostId}`);
    return generateDoorGeometry(door, host);
  },

  generateLocalGeometry(_engine, contract, doc) {
    const door = resolveDoor(contract as DoorContract, doc);
    const host = resolveHost(door, doc);
    if (!host) return null;
    const type = doc.contracts.get(door.typeId) as DoorTypeContract | undefined;
    const { frame, panel, worldTransform, frameDepth } = generateDoorPartsLocal(door, host);
    const frameMatId = type?.materials?.frame;
    const panelMatId = type?.materials?.panel;
    return {
      worldTransform,
      parts: [
        {
          geometry: frame,
          geoHash: `door-frame:${door.width}:${door.height}:${frameDepth}|${frameMatId ?? ""}`,
          material: resolveMaterial(frameMatId, doc, DEFAULT_FRAME_MAT),
        },
        {
          geometry: panel,
          geoHash: `door-panel:${door.width}:${door.height}|${panelMatId ?? ""}`,
          material: resolveMaterial(panelMatId, doc, DEFAULT_PANEL_MAT),
        },
      ],
    };
  },

  getVoidGeometry(_engine, contract, doc) {
    const door = resolveDoor(contract as DoorContract, doc);
    const host = resolveHost(door, doc);
    if (!host) return null;
    return generateDoorVoid(door, host);
  },

  getRelationships(contract, _doc) {
    const door = contract as DoorContract;
    const rels: ElementRelationship[] = [
      { type: "hostedBy", targetId: door.hostId },
    ];
    if (door.typeId) {
      rels.push({ type: "instanceOf", targetId: door.typeId });
    }
    return rels;
  },

  createHandles(scene, doc, _engine, contract, camera, container) {
    const door = contract as DoorContract;
    const params = resolveDoorParams(door, doc);
    // Y offset from wall base to door center
    const yOffset = params.height / 2;
    return new HostedElementHandles(scene, doc, contract, yOffset, camera, container);
  },

  getSpatialBounds(contract, doc) {
    const door = contract as DoorContract;
    const resolved = resolveDoorParams(door, doc);
    const host = doc.contracts.get(door.hostId) as WallContract | undefined;
    if (!host) return null;
    const sx = host.start[0], sz = host.start[2];
    const ex = host.end[0], ez = host.end[2];
    const cx = sx + (ex - sx) * door.position;
    const cz = sz + (ez - sz) * door.position;
    const hw = resolved.width / 2;
    return {
      min: [cx - hw, host.start[1], cz - hw] as [number, number, number],
      max: [cx + hw, host.start[1] + resolved.height, cz + hw] as [number, number, number],
    };
  },

  applyTranslation() {
    return null; // Hosted elements move with their host wall
  },

  remapIds(contract, idMap) {
    const door = contract as DoorContract;
    const newHostId = idMap.get(door.hostId);
    if (!newHostId) throw new Error(`Door host ${door.hostId} not in copied set`);
    return { ...door, hostId: newHostId };
  },
};
