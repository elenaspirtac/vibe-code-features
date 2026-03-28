import * as THREE from "three";
import type { ElementTypeDefinition, ElementRelationship } from "../core/registry";
import type { BaseContract, ContractId, AnyContract } from "../core/contracts";
import type { ColumnTypeContract } from "./column-type";
import type { BimDocument } from "../core/document";
import { ColumnHandles } from "../handles/column-handles";
import { rectangleProfile, extrudeProfile } from "../generators/profiles";
import { resolveMaterial } from "../utils/material-resolve";

// ── Contract ──────────────────────────────────────────────────────

export interface ColumnContract extends BaseContract {
  kind: "column";
  typeId: ContractId;
  base: [number, number, number];
  // height and width are type-only — resolved via resolveColumnParams
  /** IDs of elements this column cuts via boolean DIFFERENCE. */
  cutTargets?: ContractId[];
}

export function isColumn(c: BaseContract): c is ColumnContract {
  return c.kind === "column";
}

export function createColumn(
  base: [number, number, number],
  typeId: ContractId,
  options?: Partial<Pick<ColumnContract, "cutTargets">>
): ColumnContract {
  return {
    id: crypto.randomUUID(),
    kind: "column",
    typeId,
    base,
    cutTargets: options?.cutTargets,
  };
}

/** Resolved column parameters — all values guaranteed present. */
export interface ResolvedColumnParams {
  height: number;
  width: number;
}

export function resolveColumnParams(
  col: { typeId: ContractId },
  doc: { contracts: ReadonlyMap<ContractId, AnyContract> }
): ResolvedColumnParams {
  const type = doc.contracts.get(col.typeId) as ColumnTypeContract | undefined;
  return {
    height: type?.height ?? 3.0,
    width: type?.width ?? 0.3,
  };
}

// ── Element definition ────────────────────────────────────────────

const DEFAULT_MAT = new THREE.MeshLambertMaterial({ color: 0xd6d6d1, side: THREE.DoubleSide });

export const columnElement: ElementTypeDefinition = {
  kind: "column",
  typeKind: "columnType",

  generateGeometry(engine, contract, doc) {
    const col = contract as ColumnContract;
    const { height, width } = resolveColumnParams(col, doc);
    return extrudeProfile(engine, {
      profile: rectangleProfile(width, width),
      position: col.base,
      direction: [0, 1, 0],
      length: height,
    });
  },

  generateLocalGeometry(engine, contract, doc) {
    const col = contract as ColumnContract;
    const { height, width } = resolveColumnParams(col, doc);
    const type = doc.contracts.get(col.typeId) as ColumnTypeContract | undefined;
    const bodyMatId = type?.materials?.body;
    const geometry = extrudeProfile(engine, {
      profile: rectangleProfile(width, width),
      position: [0, 0, 0],
      direction: [0, 1, 0],
      length: height,
    });
    const worldTransform = new THREE.Matrix4().makeTranslation(...col.base);
    return {
      worldTransform,
      parts: [{
        geometry,
        geoHash: `col:${height}:${width}|${bodyMatId ?? ""}`,
        material: resolveMaterial(bodyMatId, doc, DEFAULT_MAT),
      }],
    };
  },

  getVoidGeometry(engine, contract, doc) {
    const col = contract as ColumnContract;
    const { height, width } = resolveColumnParams(col, doc);
    const geo = extrudeProfile(engine, {
      profile: rectangleProfile(width, width),
      position: col.base,
      direction: [0, 1, 0],
      length: height,
    });
    const mesh = new THREE.Mesh(geo);
    mesh.updateMatrixWorld(true);
    return mesh;
  },

  getRelationships(contract, _doc) {
    const col = contract as ColumnContract;
    const rels: ElementRelationship[] = [];
    if (col.typeId) {
      rels.push({ type: "instanceOf", targetId: col.typeId });
    }
    if (col.levelId) {
      rels.push({ type: "belongsToLevel", targetId: col.levelId as string });
    }
    if (col.cutTargets) {
      for (const targetId of col.cutTargets) {
        rels.push({ type: "cuts", targetId });
      }
    }
    return rels;
  },

  getSnapPoints(contract, doc) {
    const col = contract as ColumnContract;
    const { height } = resolveColumnParams(col, doc!);
    return [
      {
        position: new THREE.Vector3(...col.base),
        type: "endpoint" as const,
      },
      {
        position: new THREE.Vector3(
          col.base[0],
          col.base[1] + height,
          col.base[2]
        ),
        type: "endpoint" as const,
      },
      {
        position: new THREE.Vector3(
          col.base[0],
          col.base[1] + height / 2,
          col.base[2]
        ),
        type: "center" as const,
      },
    ];
  },

  createHandles(scene, doc, _engine, contract) {
    return new ColumnHandles(scene, doc, contract as ColumnContract);
  },

  applyTranslation(contract, delta) {
    const col = contract as ColumnContract;
    return {
      ...col,
      base: [col.base[0] + delta[0], col.base[1] + delta[1], col.base[2] + delta[2]] as [number, number, number],
    };
  },

  remapIds(contract, idMap) {
    const col = contract as ColumnContract;
    return {
      ...col,
      cutTargets: col.cutTargets?.map(id => idMap.get(id)).filter((id): id is ContractId => id !== undefined),
    };
  },
};
