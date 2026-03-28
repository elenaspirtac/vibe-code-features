import * as THREE from "three";
import type { GeometryEngine } from "@thatopen/fragments";
import type { AnyContract, ContractId } from "../core/contracts";
import type { BimDocument } from "../core/document";
import type { ElementRegistry } from "../core/registry";
import type { GeometryCache } from "../utils/geometry-cache";
import type { MaterialContract } from "../elements/material";
import { PREVIEW_MATERIAL } from "../utils/material-resolve";

/**
 * Manages temporary opaque three.js meshes that appear instantly
 * while the slower fragment edit runs in the background.
 */
export class OverlayManager {
  private scene: THREE.Scene;
  private engine: GeometryEngine;
  private doc: BimDocument;
  private registry: ElementRegistry;
  private overlays = new Map<ContractId, THREE.Mesh>();
  private geoCache: GeometryCache;

  /** IDs currently being dragged — overlays skip boolean cuts for these. */
  readonly draggingIds = new Set<ContractId>();

  private overlayMatCache = new Map<string, THREE.MeshLambertMaterial>();

  private material = new THREE.MeshLambertMaterial({
    color: new THREE.Color(0.85, 0.85, 0.82),
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  constructor(
    scene: THREE.Scene,
    engine: GeometryEngine,
    doc: BimDocument,
    registry: ElementRegistry,
    geoCache: GeometryCache
  ) {
    this.scene = scene;
    this.engine = engine;
    this.doc = doc;
    this.registry = registry;
    this.geoCache = geoCache;
  }

  /** Resolve the primary material for an element from its type's first material slot. */
  private resolveOverlayMaterial(contract: AnyContract): THREE.MeshLambertMaterial {
    const typeId = (contract as any).typeId as ContractId | undefined;
    if (!typeId) return this.material;
    const typeContract = this.doc.contracts.get(typeId) as any;
    if (!typeContract?.materials) return this.material;

    // Find the type def's materialSlots to get the first slot name
    const typeDef = this.registry.get(typeContract.kind);
    const slots = typeDef?.materialSlots;
    const firstSlot = slots?.[0];
    const matId = firstSlot ? typeContract.materials[firstSlot] : undefined;
    if (!matId) return this.material;

    const matContract = this.doc.contracts.get(matId) as MaterialContract | undefined;
    if (!matContract || matContract.kind !== "material") return this.material;

    // Content-keyed cache for overlay materials
    const key = `overlay:${matContract.color[0]}:${matContract.color[1]}:${matContract.color[2]}:${matContract.opacity}:${matContract.doubleSided}`;
    let cached = this.overlayMatCache.get(key);
    if (!cached) {
      cached = new THREE.MeshLambertMaterial({
        color: new THREE.Color(matContract.color[0], matContract.color[1], matContract.color[2]),
        opacity: matContract.opacity,
        transparent: matContract.opacity < 1,
        side: matContract.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      this.overlayMatCache.set(key, cached);
    }
    return cached;
  }

  /** Create or update an overlay mesh for a contract (instant). */
  set(contract: AnyContract) {
    // Skip booleans for dragged elements AND their cascade neighbors
    const skipBooleans = this.draggingIds.size > 0;
    // During drag, bypass the geometry cache entirely — every frame is a
    // cache miss (contract changed) so computeKey + clone are pure waste.
    // Eliminating per-frame JSON.stringify + clone reduces GC pressure that
    // causes progressive lag over long drags.
    const geo = skipBooleans
      ? this.registry.generateGeometry(this.engine, contract, this.doc, { skipBooleans })
      : this.geoCache.getOrGenerate(
          this.registry,
          this.engine,
          contract,
          this.doc,
          { skipBooleans }
        );
    // During drag, hosted elements use a translucent material so they're
    // visible inside the host wall (same style as placement previews).
    const isHosted = "hostId" in contract;
    const isDragging = isHosted && this.draggingIds.has(contract.id);
    const overlayMat = isDragging ? PREVIEW_MATERIAL : this.resolveOverlayMaterial(contract);
    let mesh = this.overlays.get(contract.id);
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geo;
      mesh.material = overlayMat;
    } else {
      mesh = new THREE.Mesh(geo, overlayMat);
      this.overlays.set(contract.id, mesh);
      this.scene.add(mesh);
    }
    mesh.renderOrder = isDragging ? 2 : 1;
  }

  /** Remove overlay for a contract (called after fragment edit completes). */
  remove(contractId: ContractId) {
    const mesh = this.overlays.get(contractId);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.overlays.delete(contractId);
  }

  has(contractId: ContractId) {
    return this.overlays.has(contractId);
  }

  /** Hide an overlay mesh (keeps it in the map, just sets visible=false). */
  hide(contractId: ContractId) {
    const mesh = this.overlays.get(contractId);
    if (mesh) mesh.visible = false;
  }

  /** Show an overlay mesh. */
  show(contractId: ContractId) {
    const mesh = this.overlays.get(contractId);
    if (mesh) mesh.visible = true;
  }

  /** All overlay IDs (for debug dump). */
  get ids(): ContractId[] {
    return [...this.overlays.keys()];
  }

  /** Remove all overlays except those in the given set or array. */
  removeAllExcept(keep: Set<ContractId> | ContractId[]) {
    const keepSet = keep instanceof Set ? keep : new Set(keep);
    for (const id of [...this.overlays.keys()]) {
      if (!keepSet.has(id)) this.remove(id);
    }
  }

  /** Raycast against all overlay meshes. Returns the contractId of the closest hit. */
  raycast(raycaster: THREE.Raycaster): { id: ContractId; distance: number } | null {
    const meshes = [...this.overlays.values()];
    if (meshes.length === 0) return null;
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    // Find which contractId owns the hit mesh
    for (const [id, mesh] of this.overlays) {
      if (mesh === hits[0].object) return { id, distance: hits[0].distance };
    }
    return null;
  }

  /** Remove all overlay meshes but keep the manager reusable. */
  clear() {
    for (const id of [...this.overlays.keys()]) {
      this.remove(id);
    }
    this.draggingIds.clear();
  }

  dispose() {
    this.clear();
    this.material.dispose();
    for (const mat of this.overlayMatCache.values()) mat.dispose();
    this.overlayMatCache.clear();
  }
}
