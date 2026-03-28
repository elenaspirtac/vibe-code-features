import * as THREE from "three";
import type { BimDocument } from "../core/document";
import type { ContractId } from "../core/contracts";
import type { MaterialContract } from "../elements/material";

const cache = new Map<string, THREE.MeshLambertMaterial>();

/**
 * Resolve a material contract ID to a THREE.MeshLambertMaterial.
 * Caches materials by a content key so identical contracts share the same object.
 * Returns the fallback material if materialId is undefined or contract not found.
 */
export function resolveMaterial(
  materialId: ContractId | undefined,
  doc: BimDocument,
  fallback: THREE.MeshLambertMaterial
): THREE.MeshLambertMaterial {
  if (!materialId) return fallback;
  const contract = doc.contracts.get(materialId) as MaterialContract | undefined;
  if (!contract || contract.kind !== "material") return fallback;

  // Content-keyed cache so material edits produce new entries
  const key = `${contract.color[0]}:${contract.color[1]}:${contract.color[2]}:${contract.opacity}:${contract.doubleSided}:${contract.stroke}`;
  let mat = cache.get(key);
  if (mat) return mat;

  mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(contract.color[0], contract.color[1], contract.color[2]),
    opacity: contract.opacity,
    transparent: contract.opacity < 1,
    side: contract.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  cache.set(key, mat);
  return mat;
}

/** Clear the material cache (e.g. on document reload). */
export function clearMaterialCache() {
  for (const mat of cache.values()) mat.dispose();
  cache.clear();
}

/** Shared translucent material for all placement previews and drag overlays. */
export const PREVIEW_MATERIAL = new THREE.MeshLambertMaterial({
  color: 0x4488cc,
  transparent: true,
  opacity: 0.5,
  side: THREE.DoubleSide,
  depthTest: false,
});
