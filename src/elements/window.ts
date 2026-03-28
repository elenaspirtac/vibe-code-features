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
import type { WindowTypeContract } from "./window-type";
import { resolveWallParams } from "./wall";
import type { WallContract, ResolvedWall } from "./wall";
import { generateWindowGeometry, generateWindowPartsLocal, generateWindowVoid } from "../generators/window";
import { resolveMaterial } from "../utils/material-resolve";
import { HostedElementHandles } from "../handles/hosted-handles";

// ── Contract ──────────────────────────────────────────────────────

export interface WindowContract extends BaseContract {
  kind: "window";
  typeId: ContractId;
  hostId: ContractId;
  position: number;
  width?: number;
  height?: number;
  sillHeight?: number;
}

export function isWindow(c: { kind: string }): c is WindowContract {
  return c.kind === "window";
}

export function createWindow(
  hostId: ContractId,
  position: number,
  typeId: ContractId,
  options?: Partial<Pick<WindowContract, "width" | "height" | "sillHeight">>
): WindowContract {
  return {
    id: crypto.randomUUID(),
    kind: "window",
    hostId,
    position: Math.max(0, Math.min(1, position)),
    typeId,
    width: options?.width,
    height: options?.height,
    sillHeight: options?.sillHeight,
  };
}

/** Resolved window parameters — all values guaranteed present. */
export interface ResolvedWindowParams {
  width: number;
  height: number;
  sillHeight: number;
}

/** Window contract with all params resolved. */
export type ResolvedWindow = WindowContract & ResolvedWindowParams;

export function resolveWindowParams(
  win: WindowContract,
  doc: { contracts: ReadonlyMap<ContractId, AnyContract> }
): ResolvedWindowParams {
  const type = doc.contracts.get(win.typeId) as WindowTypeContract | undefined;
  return {
    width: win.width ?? type?.width ?? 1.2,
    height: win.height ?? type?.height ?? 1.0,
    sillHeight: win.sillHeight ?? type?.sillHeight ?? 1.0,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function resolveHost(win: WindowContract, doc: { contracts: ReadonlyMap<string, any> }): ResolvedWall | null {
  const host = doc.contracts.get(win.hostId) as WallContract | undefined;
  if (!host) return null;
  const params = resolveWallParams(host, doc);
  return { ...host, height: params.height, thickness: params.thickness };
}

function resolveWindow(win: WindowContract, doc: { contracts: ReadonlyMap<string, any> }): ResolvedWindow {
  const params = resolveWindowParams(win, doc);
  return { ...win, width: params.width, height: params.height, sillHeight: params.sillHeight };
}

// ── Element definition ────────────────────────────────────────────

const DEFAULT_FRAME_MAT = new THREE.MeshLambertMaterial({ color: 0xd6d6d1, side: THREE.DoubleSide });
const DEFAULT_GLASS_MAT = new THREE.MeshLambertMaterial({
  color: 0x88bbdd,
  transparent: true,
  opacity: 0.3,
  side: THREE.DoubleSide,
});

export const windowElement: ElementTypeDefinition = {
  kind: "window",
  typeKind: "windowType",

  generateGeometry(_engine, contract, doc) {
    const win = resolveWindow(contract as WindowContract, doc);
    const host = resolveHost(win, doc);
    if (!host) throw new Error(`Window host wall not found: ${win.hostId}`);
    return generateWindowGeometry(win, host);
  },

  generateLocalGeometry(_engine, contract, doc) {
    const win = resolveWindow(contract as WindowContract, doc);
    const host = resolveHost(win, doc);
    if (!host) return null;
    const type = doc.contracts.get(win.typeId) as WindowTypeContract | undefined;
    const { frame, glass, worldTransform } = generateWindowPartsLocal(win, host);
    const frameMatId = type?.materials?.frame;
    const glassMatId = type?.materials?.glass;
    return {
      worldTransform,
      parts: [
        {
          geometry: frame,
          geoHash: `win-frame:${win.width}:${win.height}:${win.sillHeight}|${frameMatId ?? ""}`,
          material: resolveMaterial(frameMatId, doc, DEFAULT_FRAME_MAT),
        },
        {
          geometry: glass,
          geoHash: `win-glass:${win.width}:${win.height}:${win.sillHeight}|${glassMatId ?? ""}`,
          material: resolveMaterial(glassMatId, doc, DEFAULT_GLASS_MAT),
        },
      ],
    };
  },

  getVoidGeometry(_engine, contract, doc) {
    const win = resolveWindow(contract as WindowContract, doc);
    const host = resolveHost(win, doc);
    if (!host) return null;
    return generateWindowVoid(win, host);
  },

  getRelationships(contract, _doc) {
    const win = contract as WindowContract;
    const rels: ElementRelationship[] = [
      { type: "hostedBy", targetId: win.hostId },
    ];
    if (win.typeId) {
      rels.push({ type: "instanceOf", targetId: win.typeId });
    }
    return rels;
  },

  createHandles(scene, doc, _engine, contract, camera, container) {
    const win = contract as WindowContract;
    const params = resolveWindowParams(win, doc);
    // Y offset from wall base to window center
    const yOffset = params.sillHeight + params.height / 2;
    return new HostedElementHandles(scene, doc, contract, yOffset, camera, container);
  },

  getSpatialBounds(contract, doc) {
    const win = contract as WindowContract;
    const resolved = resolveWindowParams(win, doc);
    const host = doc.contracts.get(win.hostId) as WallContract | undefined;
    if (!host) return null;
    const sx = host.start[0], sz = host.start[2];
    const ex = host.end[0], ez = host.end[2];
    const cx = sx + (ex - sx) * win.position;
    const cz = sz + (ez - sz) * win.position;
    const hw = resolved.width / 2;
    return {
      min: [cx - hw, host.start[1] + (resolved.sillHeight ?? 0), cz - hw] as [number, number, number],
      max: [cx + hw, host.start[1] + (resolved.sillHeight ?? 0) + resolved.height, cz + hw] as [number, number, number],
    };
  },

  applyTranslation() {
    return null; // Hosted elements move with their host wall
  },

  remapIds(contract, idMap) {
    const win = contract as WindowContract;
    const newHostId = idMap.get(win.hostId);
    if (!newHostId) throw new Error(`Window host ${win.hostId} not in copied set`);
    return { ...win, hostId: newHostId };
  },
};
