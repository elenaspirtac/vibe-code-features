import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { EditRequestType, GeomsFbUtils, type EditRequest, type GeometryEngine } from "@thatopen/fragments";
import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";
import type { ElementRegistry } from "../core/registry";
import type { FragmentManager } from "./manager";
import { OverlayManager } from "./overlay";
import { FragmentWriter, type FragmentElementIds, type InstancedPart, type SharedReprIds } from "./writer";
import { VisState, VisibilityStateMachine } from "./visibility-state";
import { GeometryCache } from "../utils/geometry-cache";
import { resolveMaterial } from "../utils/material-resolve";

interface PendingOp {
  type: "create" | "update";
  contract: AnyContract;
}

export class FragmentSync {
  private doc: BimDocument;
  private mgr: FragmentManager;
  /** Exposed for paste-tool preview generation. */
  readonly engine: GeometryEngine;
  private registry: ElementRegistry;
  private overlay: OverlayManager;

  private defaultMaterial = new THREE.MeshLambertMaterial({
    color: new THREE.Color(0.85, 0.85, 0.82),
    side: THREE.DoubleSide,
  });
  private identityTransform = new THREE.Matrix4().identity();

  private pendingOps = new Map<ContractId, PendingOp>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private DEBOUNCE_MS = 100;

  /** Re-entrancy guard for cascadeOnChange — prevents infinite loops
   *  with symmetric relationships (e.g. wall A ↔ wall B via connectedTo). */
  private cascadingIds = new Set<string>();
  private cascadeDepth = 0;

  /** Content-addressed geometry cache (S.9). */
  readonly geoCache = new GeometryCache();

  /** Explicit visibility state for every non-Normal element. */
  readonly vsm = new VisibilityStateMachine();
  /** Relationships snapshot at extraction time — used to cascade to old neighbors after move. */
  private priorRelationships = new Map<ContractId, ContractId[]>();
  /** Reverse index: targetId → set of element IDs that declare a relationship to it. */
  private dependentsOf = new Map<ContractId, Set<ContractId>>();
  /** When true, dependentsOf needs a full rebuild before next access. */
  private dependentsIndexDirty = false;

  private editQueue: Promise<void> = Promise.resolve();
  /** Number of tasks pending in the editQueue (for transient-state detection). */
  private editQueueDepth = 0;

  /** Batches cascade deletes so they go through a single editor.edit() call. */
  private pendingDeleteBatch: { contractId: ContractId; ids: FragmentElementIds; isInstanced: boolean }[] = [];

  /** Type-owned repr/lt/mat to delete alongside the next onDeleteBatch. */
  private pendingTypeReprDeletes: SharedReprIds[] = [];

  /** World transforms of instanced elements at extraction time.
   *  Used during flush to skip GT updates when the transform hasn't changed. */
  private extractedWorldTransforms = new Map<ContractId, THREE.Matrix4>();


  /** When true, event handlers skip fragment writes (used during undo/redo). */
  isUndoRedo = false;
  /** True while model is translucent during fast undo/redo. */
  modelTranslucent = false;


  /** True when any elements are extracted (selected) into overlays. */
  get hasExtracted(): boolean {
    return this.vsm.hasAny(VisState.Extracted);
  }

  /** True when any elements are being dragged (move tool or select-tool
   *  endpoint drag). Used to skip tempDims/properties updates that are
   *  unnecessary and expensive during drag. */
  get isDragging(): boolean {
    return this.overlay.draggingIds.size > 0;
  }

  /** IDs in rigid (whole-element) drag — enables aggressive fast path. */
  private rigidDragIds = new Set<ContractId>();

  /** Debug: IDs of all current overlays. */
  get overlayIds(): Iterable<string> {
    return this.overlay.ids;
  }

  /** Shorthand: is this element in the Extracted state? */
  isExtracted(id: ContractId): boolean {
    return this.vsm.getState(id) === VisState.Extracted;
  }

  /** Fragment history request index after the most recent editor.edit() call. */
  lastFragmentRequestIndex = -1;

  // ── Fast undo/redo support ─────────────────────────────────────
  // A promise that stays open while a debounced fragment rebuild is
  // pending. External code (extract, save) can await it to ensure the
  // rebuild completes before proceeding.

  private enqueue(fn: () => Promise<void>) {
    this.editQueueDepth++;
    const wrapped = async () => {
      try { await fn(); }
      finally { this.editQueueDepth--; }
    };
    this.editQueue = this.editQueue.then(wrapped, wrapped);
  }

  constructor(
    doc: BimDocument,
    mgr: FragmentManager,
    engine: GeometryEngine,
    scene: THREE.Scene,
    registry: ElementRegistry
  ) {
    this.doc = doc;
    this.mgr = mgr;
    this.engine = engine;
    this.registry = registry;
    this.overlay = new OverlayManager(scene, engine, doc, registry, this.geoCache);

    // Wire reverse-cuts lookup into geometry cache using dependentsOf index.
    // O(k) where k = number of dependents, instead of O(n) scanning all contracts.
    this.geoCache.reverseCutsLookup = (targetId: string) => {
      const deps = this.getDependents(targetId);
      if (!deps) return [];
      const cutters: string[] = [];
      for (const depId of deps) {
        const depContract = doc.contracts.get(depId);
        if (!depContract) continue;
        const rels = registry.getRelationships(depContract, doc);
        if (rels.some((r) => r.type === "cuts" && r.targetId === targetId)) {
          cutters.push(depId);
        }
      }
      return cutters;
    };

    doc.onAdded.add((c) => {
      this.invalidateGeoCache(c.id);
      // Incrementally update reverse dependency index: index the new
      // element AND re-index its neighbors (they now have a new
      // relationship that didn't exist when they were first indexed).
      this.updateDependentsIndex(c);
      const addedRels = this.registry.getRelationships(c, this.doc);
      for (const rel of addedRels) {
        const neighbor = this.doc.contracts.get(rel.targetId);
        if (neighbor) this.updateDependentsIndex(neighbor);
      }
      if (this.isUndoRedo) return;
      // Data-only contracts (type definitions) have no geometry or fragments.
      if (this.registry.isDataOnly(c.kind)) return;
      this.overlay.set(c);
      this.schedulePending(c.id, "create", c);
      // Related elements may need fragment updates (e.g., host wall needs void cut)
      this.cascadeOnChange(c, true);
    });

    doc.onUpdated.add(({ contract: c, patchKeys }) => {

      // ── Fast path for rigid drag (move tool) ─────────────────────
      // During rigid drag, skip ALL expensive bookkeeping: dependency
      // index rebuild, spatial index R-tree updates, AND geometry cache
      // invalidation scan. The cache is bypassed in overlay.set during
      // drag (every frame is a miss), so scanning it is pure waste.
      // Indexes + cache are rebuilt in bulk when drag ends (endDragAll).
      //
      // NOT used for select-tool endpoint drag (non-rigid) — those need
      // cascade + index updates because dragging an endpoint can create
      // or break connections (e.g. miter joint with a nearby wall).
      if (this.rigidDragIds.has(c.id)) {
        if (this.isUndoRedo) return;
        this.overlay.set(c);
        this.vsm.markDirty(c.id);
        this.schedulePending(c.id, "update", c);
        this.refreshDraggingDependents(c);
        return;
      }

      this.invalidateGeoCache(c.id);
      // ── Normal path: update dependency + spatial indexes ────────
      // Incrementally update reverse dependency index: capture old
      // neighbors BEFORE re-indexing so stale entries are dropped,
      // then re-index new neighbors too.
      const oldNeighborIds: ContractId[] = [];
      for (const [targetId, deps] of this.dependentsOf) {
        if (deps.has(c.id)) oldNeighborIds.push(targetId);
      }
      const entry = this.dependentsOf.get(c.id);
      if (entry) for (const depId of entry) oldNeighborIds.push(depId);
      this.updateDependentsIndex(c);
      for (const nId of oldNeighborIds) {
        const neighbor = this.doc.contracts.get(nId);
        if (neighbor) this.updateDependentsIndex(neighbor);
      }
      const newRels = this.registry.getRelationships(c, this.doc);
      for (const rel of newRels) {
        if (oldNeighborIds.includes(rel.targetId)) continue;
        const neighbor = this.doc.contracts.get(rel.targetId);
        if (neighbor) this.updateDependentsIndex(neighbor);
      }
      if (this.isUndoRedo) return;
      // Data-only contracts (type definitions): no geometry/fragments for the type
      // itself, but cascade to dependents (instances) so they pick up new params.
      // Skip cascade when only metadata keys changed (e.g. renaming a type).
      if (this.registry.isDataOnly(c.kind)) {
        if (!this.registry.isMetadataOnly(c.kind, patchKeys)) {
          // Skip overlays for type cascade — geometry generation for
          // hundreds of instances would freeze the UI. Fragment writes
          // (async, batched) handle the visual update instead.
          this.cascadeOnChange(c, true, true);
        }
        return;
      }
      if (this.isExtracted(c.id)) {
        // Element is extracted — update overlay, schedule fragment write in background
        // so the fragment is ready when restored (stays hidden via reHideExtracted).
        this.overlay.set(c);
        this.vsm.markDirty(c.id);
        this.schedulePending(c.id, "update", c);
        this.cascadeOnChange(c, true);
        return;
      }
      this.overlay.set(c);
      this.schedulePending(c.id, "update", c);
      // Related elements may need overlay refresh + fragment writes
      this.cascadeOnChange(c, true);
    });

    doc.onRemoved.add((id) => {
      this.invalidateGeoCache(id);
      // Capture dependents BEFORE removing from index — we need the
      // current reverse lookup to refresh elements that depended on the
      // removed element (e.g., floor referencing a deleted wall).
      this.ensureDependentsIndex();
      const dependents = this.dependentsOf.get(id);
      const depSnapshot = dependents ? [...dependents] : [];
      // Capture neighbors before the contract is deleted — needed for
      // cascade refresh and deferred cuts cleanup below.
      const contract = doc.contracts.get(id);
      const neighborIds: ContractId[] = [];
      if (contract) {
        const rels = this.registry.getRelationships(contract, this.doc);
        for (const rel of rels) neighborIds.push(rel.targetId);
      }
      // Incrementally remove this element from the reverse index and
      // re-index its neighbors so they drop their references to it.
      this._deletingId = id;
      this.dependentsOf.delete(id);
      for (const [targetId, deps] of this.dependentsOf) {
        deps.delete(id);
        if (deps.size === 0) this.dependentsOf.delete(targetId);
      }
      for (const nId of neighborIds) {
        const neighbor = this.doc.contracts.get(nId);
        if (neighbor) this.updateDependentsIndex(neighbor);
      }
      this._deletingId = null;
      if (this.isUndoRedo) {
        if (this.isExtracted(id)) {
          this.vsm.transition(id, VisState.Normal);
          this.priorRelationships.delete(id);
        }
        this.pendingOps.delete(id);
        this.overlay.remove(id);
        return;
      }
      // Data-only contracts (type definitions): no geometry/fragments/overlays.
      // Cascade to dependents (instances) so they know the type is gone,
      // then bail — there's nothing to delete from the fragment model.
      // Also clean up type-owned representations from the fragment model.
      if (contract && this.registry.isDataOnly(contract.kind)) {
        for (const depId of depSnapshot) {
          const dep = this.doc.contracts.get(depId);
          if (!dep) continue;
          this.invalidateGeoCache(depId);
          if (this.isExtracted(depId)) {
            this.vsm.markDirty(depId);
          } else {
            this.overlay.set(dep);
            this.schedulePending(depId, "update", dep);
          }
        }
        // Clean up type-owned repr/lt/mat.
        // If instances are cascade-deleting, stash for onDeleteBatch (same editor.edit).
        // If no instances remain, delete directly.
        const typeReprMap = this.doc.typeReprIds.get(id);
        this.doc.typeReprIds.delete(id);
        if (typeReprMap && typeReprMap.size > 0) {
          const reprEntries = [...typeReprMap.values()];
          const hasInstanceDeletes = depSnapshot.some(depId => this.doc.fragmentIds.has(depId));
          if (hasInstanceDeletes) {
            for (const entry of reprEntries) {
              this.pendingTypeReprDeletes.push(entry);
            }
          } else {
            this.enqueue(async () => {
              const deleteReqs: EditRequest[] = [];
              for (const entry of reprEntries) {
                deleteReqs.push(
                  { type: EditRequestType.DELETE_REPRESENTATION, localId: entry.reprId } as EditRequest,
                  { type: EditRequestType.DELETE_LOCAL_TRANSFORM, localId: entry.ltId } as EditRequest,
                  { type: EditRequestType.DELETE_MATERIAL, localId: entry.matId } as EditRequest,
                );
              }
              if (deleteReqs.length > 0) {
                await this.mgr.editor.edit(this.mgr.modelId, deleteReqs);
                await this.updateFragmentHistoryIndex();
                await this.mgr.update(true);
              }
            });
          }
        }
        return;
      }
      // Contract is still available (event fires before delete)
      if (contract) {
        // Type-specific cleanup (e.g., window removes itself from host's list)
        this.registry.get(contract.kind)?.onRemove?.(contract, doc);
        // Related elements need fragment updates — defer "cuts" targets
        // until after the contract is deleted, so collectGenericCuts
        // won't find the removed cutter.
        const rels = this.registry.getRelationships(contract, doc);
        const deferredTargets: ContractId[] = [];
        for (const rel of rels) {
          if (rel.type === "cuts") {
            deferredTargets.push(rel.targetId);
            continue;
          }
          const related = doc.contracts.get(rel.targetId);
          if (!related || this.registry.isDataOnly(related.kind)) continue;
          this.invalidateGeoCache(rel.targetId);
          if (this.isExtracted(rel.targetId)) {
            this.vsm.markDirty(rel.targetId);
          } else {
            this.overlay.set(related);
            this.schedulePending(rel.targetId, "update", related);
          }
        }
        // Refresh cut targets after contract is removed from the map
        if (deferredTargets.length > 0) {
          queueMicrotask(() => {
            for (const targetId of deferredTargets) {
              this.forceRefresh(targetId);
            }
          });
        }
      }
      // Refresh elements that depended on the removed element (e.g., floor → deleted wall).
      // Also clean up stale cutTargets references — if another element
      // has cutTargets: [..., deletedId], remove the stale entry so the
      // relationship graph stays consistent.
      for (const depId of depSnapshot) {
        const dep = this.doc.contracts.get(depId);
        if (!dep || this.registry.isDataOnly(dep.kind)) continue;
        // Prune stale cutTargets — doc.update fires onUpdated which handles
        // overlay refresh, schedulePending, and dependentsOf update.
        const ct: ContractId[] | undefined = (dep as Record<string, unknown>).cutTargets as ContractId[] | undefined;
        if (ct && ct.includes(id)) {
          const pruned = ct.filter((t) => t !== id);
          this.doc.update(depId, { cutTargets: pruned.length > 0 ? pruned : [] });
          // onUpdated already refreshed this dep — skip manual refresh below
          continue;
        }
        this.invalidateGeoCache(depId);
        if (this.isExtracted(depId)) {
          this.vsm.markDirty(depId);
        } else {
          this.overlay.set(dep);
          this.schedulePending(depId, "update", dep);
        }
      }
      if (this.isExtracted(id)) {
        this.vsm.transition(id, VisState.Normal);
        this.priorRelationships.delete(id);
      }
      // Cancel any pending create/update — the element is gone.
      this.pendingOps.delete(id);
      // Remove overlay AFTER cascade processing — cascadeOnChange (triggered
      // by doc.update on dependents) can re-create the overlay via
      // priorRelationships if the removed element was a former cascade target.
      this.overlay.remove(id);
      // Capture IDs now — removeOne() deletes them from fragmentIds
      // before the async onDelete gets to run.
      const ids = this.doc.fragmentIds.get(id);
      if (ids !== undefined) {
        // Batch deletes: cascade fires synchronously, so collect all IDs
        // and process them in a single editor.edit() call (via microtask).
        const isFirst = this.pendingDeleteBatch.length === 0;
        const isInstanced = !!(contract && (contract as any).typeId);
        this.pendingDeleteBatch.push({ contractId: id, ids, isInstanced });
        if (isFirst) {
          queueMicrotask(() => {
            const batch = this.pendingDeleteBatch.splice(0);
            this.enqueue(() => this.onDeleteBatch(batch));
          });
        }
      }
    });
  }

  async init() {}

  /**
   * Update the reverse dependency index for an element.
   * Removes old entries and adds current relationships.
   */
  /** Track a deleted id so we can detect stale re-additions. */
  private _deletingId: ContractId | null = null;

  private updateDependentsIndex(contract: AnyContract) {
    const id = contract.id;

    // Remove old entries pointing from this element
    for (const [targetId, deps] of this.dependentsOf) {
      deps.delete(id);
      if (deps.size === 0) this.dependentsOf.delete(targetId);
    }

    // Add current relationships
    const rels = this.registry.getRelationships(contract, this.doc);
    for (const rel of rels) {
      // Skip relationships involving an element being deleted — the contract
      // is still in the map when onRemoved fires, so queries like
      // getHostedElements can return it. Prevents stale dependentsOf entries.
      if (this._deletingId && (rel.targetId === this._deletingId || id === this._deletingId)) {
        continue;
      }
      let set = this.dependentsOf.get(rel.targetId);
      if (!set) {
        set = new Set();
        this.dependentsOf.set(rel.targetId, set);
      }
      set.add(id);
    }
  }

  /**
   * Navigate fragment history to a specific request index (for undo/redo).
   * Index -1 means "before any edits". Requires editor.edit() afterward
   * to rebuild the delta model.
   */
  async navigateFragmentHistory(
    targetIndex: number,
    affectedIds?: ContractId[]
  ) {
    const fromFastPath = this.modelTranslucent;

    if (!fromFastPath) {
      // Slow path: clear overlays and create bridge overlays for the rebuild gap
      this.overlay.removeAllExcept(this.vsm.inState(VisState.Extracted));

      const bridgeIds = new Set(affectedIds ?? []);
      if (affectedIds) {
        for (const id of affectedIds) {
          const contract = this.doc.contracts.get(id);
          if (!contract) continue;
          const rels = this.registry.getRelationships(contract, this.doc);
          for (const rel of rels) bridgeIds.add(rel.targetId);
          const deps = this.getDependents(id);
          if (deps) for (const depId of deps) bridgeIds.add(depId);
        }
      } else {
        for (const [id] of this.doc.contracts) bridgeIds.add(id);
      }
      for (const id of bridgeIds) {
        if (this.isExtracted(id)) continue;
        const contract = this.doc.contracts.get(id);
        if (contract && !this.registry.isDataOnly(contract.kind)) this.overlay.set(contract);
      }
    }
    // Fast path: keep existing fast-phase overlays as the bridge;
    // translucent model covers cascade neighbors — no extra overlays needed.

    const editor = this.mgr.editor;
    const modelId = this.mgr.modelId;
    const model = this.mgr.fragments.models.list.get(modelId);

    if (targetIndex >= 0) {
      await editor.selectRequest(modelId, targetIndex);
    } else if (model) {
      // Go to "before any edits": mark all requests as undone.
      // selectRequest doesn't accept -1, so use internal _setRequests.
      const { requests, undoneRequests } = await editor.getModelRequests(modelId);
      const all = [...requests, ...undoneRequests];
      if (all.length > 0) {
        await model._setRequests({ requests: [], undoneRequests: all });
      }
    }

    await editor.edit(modelId, [], { removeRedo: false });

    // After rebuilding the delta, show non-edited elements on base and
    // explicitly hide edited elements.
    const baseModel = this.mgr.fragments.models.list.get(this.mgr.modelId);
    const deltaAfter = this.getDeltaModel();
    const editedSet = (deltaAfter && baseModel)
      ? new Set(await baseModel.getEditedElements())
      : new Set<number>();

    if (baseModel?.setVisible) {
      const showIds: number[] = [];
      const hideIds: number[] = [];
      for (const [, ids] of this.doc.fragmentIds) {
        if (editedSet.has(ids.itemId)) {
          hideIds.push(ids.itemId);
        } else {
          showIds.push(ids.itemId);
        }
      }
      if (hideIds.length > 0) {
        await baseModel.setVisible(hideIds, false);
      }
      if (showIds.length > 0) {
        await baseModel.setVisible(showIds, true);
      }
    }

    // Re-hide extracted elements on both base and delta models
    await this.reHideExtracted();

    // Show the delta BEFORE update so everything renders in one pass.
    if (deltaAfter) {
      for (const mesh of deltaAfter.object.children) {
        mesh.visible = true;
      }
    }

    await this.mgr.update(true);

    if (targetIndex < 0) {
      // At -1 (initial state) the delta is empty — all rendering comes
      // from the base model's tile system. Wait for tiles to be ready
      // before removing the bridging overlays.
      await this.waitForTilesReady();
    }

    // Fast path: restore opacity BEFORE removing overlays so the user
    // sees the updated opaque model, then overlays disappear cleanly.
    if (fromFastPath) {
      this.setModelTranslucency(false);
    }

    this.overlay.removeAllExcept(this.vsm.inState(VisState.Extracted));

    this.lastFragmentRequestIndex = targetIndex;

    // Rebuild type repr map — fragment history may have changed which reprs exist
    this.rebuildTypeReprIds();
  }

  /** Raycast against overlay meshes. Returns contractId + distance of closest hit, or null. */
  raycastOverlays(raycaster: THREE.Raycaster): { id: ContractId; distance: number } | null {
    return this.overlay.raycast(raycaster);
  }

  /**
   * Mark an element as being dragged — overlay skips expensive boolean cuts.
   *
   * `rigid: true` (move tool) enables the aggressive fast path: skip cascade,
   * dependency index, spatial index, and geometry cache. Safe because rigid
   * translation preserves relationships (stretch targets handle connections).
   *
   * `rigid: false` (select tool endpoint drag) only skips boolean cuts.
   * Cascade and indexes still run because dragging an endpoint can create
   * or break connections (e.g. miter joint with a nearby wall).
   */
  startDrag(contractId: ContractId, rigid = false) {
    this.overlay.draggingIds.add(contractId);
    if (rigid) {
      this.rigidDragIds.add(contractId);
      // Pause spatial index updates for rigid drags — R-tree
      // remove+insert on every pointer move causes tree fragmentation
      // and progressive perf degradation. Rebuilt in endDragAll.
      this.doc.spatialIndex?.pauseUpdates([contractId]);
    }
  }

  endDrag(contractId: ContractId) {
    this.overlay.draggingIds.delete(contractId);
    this.rigidDragIds.delete(contractId);
    const contract = this.doc.contracts.get(contractId);
    if (contract) {
      this.overlay.set(contract);
      this.invalidateGeoCache(contractId);
      this.refreshExtractedNeighbors(contract, new Set([contractId]));
    }
    // Rebuild indexes paused during drag
    this.doc.spatialIndex?.resumeUpdates();
    this.dependentsIndexDirty = true;
    // Flush any pending ops that were deferred during drag
    if (this.overlay.draggingIds.size === 0 && this.pendingOps.size > 0) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.drainPending(), this.DEBOUNCE_MS);
    }
  }

  /**
   * End drag for multiple elements at once, then run ONE cascade pass
   * for all of them. Avoids redundant overlay rebuilds when multiple
   * moved elements share neighbors (e.g. stress-test grid).
   */
  endDragAll(contractIds: ContractId[]) {
    const contracts: AnyContract[] = [];
    for (const id of contractIds) {
      this.overlay.draggingIds.delete(id);
      this.rigidDragIds.delete(id);
      const contract = this.doc.contracts.get(id);
      if (contract) {
        this.overlay.set(contract);
        this.invalidateGeoCache(id);
        this.refreshExtractedNeighbors(contract, new Set([id]));
        contracts.push(contract);
      }
    }

    // Rebuild indexes that were paused during drag.
    // Spatial index: resume paused IDs (re-indexes only the dragged elements).
    this.doc.spatialIndex?.resumeUpdates();
    // Dependency index: mark dirty so it rebuilds on next access.
    this.dependentsIndexDirty = true;

    // Single cascade pass: bump cascadeDepth so cascadingIds accumulates
    // across all elements — shared neighbors are only processed once.
    this.cascadeDepth++;
    try {
      for (const contract of contracts) {
        // skipOverlays=true: non-extracted dependents (e.g. hosted windows)
        // get fragment writes scheduled. Overlays for non-extracted elements
        // would become orphans that restore can't clean up. The fragment
        // write is flushed during restore → flush().
        this.cascadeOnChange(contract, true, true);
      }
    } finally {
      this.cascadeDepth--;
      if (this.cascadeDepth === 0) this.cascadingIds.clear();
    }
    // Flush any pending ops that were deferred during drag
    if (this.overlay.draggingIds.size === 0 && this.pendingOps.size > 0) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.drainPending(), this.DEBOUNCE_MS);
    }
  }

  /**
   * Lightweight cascade during drag: only refresh dependents that are
   * both extracted AND dragging (e.g. hosted windows on a stretch-target
   * wall). Skips connected walls (expensive booleans) — they refresh at
   * endDrag. No recursion needed since hosted elements don't have their
   * own hosted children.
   */
  private refreshDraggingDependents(contract: AnyContract) {
    const dependents = this.getDependents(contract.id);
    if (!dependents) return;
    for (const depId of dependents) {
      if (!this.overlay.draggingIds.has(depId)) continue;
      if (!this.isExtracted(depId)) continue;
      const dep = this.doc.contracts.get(depId);
      if (!dep || this.registry.isDataOnly(dep.kind)) continue;
      // Skip invalidateGeoCache — overlay.set bypasses cache during drag
      this.overlay.set(dep);
    }
  }

  /**
   * Recursively refresh overlays for extracted neighbors of a contract.
   * Unlike cascadeOnChange, this ONLY touches elements that are already
   * extracted — it won't create orphan overlays for non-extracted elements.
   */
  private refreshExtractedNeighbors(contract: AnyContract, visited: Set<ContractId>) {
    const rels = this.registry.getRelationships(contract, this.doc);
    for (const rel of rels) {
      if (visited.has(rel.targetId)) continue;
      visited.add(rel.targetId);
      const related = this.doc.contracts.get(rel.targetId);
      if (!related || this.registry.isDataOnly(related.kind)) continue;
      if (!this.isExtracted(rel.targetId)) continue;
      this.invalidateGeoCache(rel.targetId);
      this.overlay.set(related);
      // Recurse: wall a → wall b → wall c (all extracted)
      this.refreshExtractedNeighbors(related, visited);
    }
    // Also check reverse dependents
    const dependents = this.getDependents(contract.id);
    if (dependents) {
      for (const depId of dependents) {
        if (visited.has(depId)) continue;
        visited.add(depId);
        const dep = this.doc.contracts.get(depId);
        if (!dep || this.registry.isDataOnly(dep.kind)) continue;
        if (!this.isExtracted(depId)) continue;
        this.invalidateGeoCache(depId);
        this.overlay.set(dep);
        this.refreshExtractedNeighbors(dep, visited);
      }
    }
  }

  /** IDs temporarily hidden via temporaryHide (debug/inspection). */
  private tempHidden = new Set<ContractId>();

  /**
   * Temporarily hide elements — hides both overlay and fragment.
   * Use showAllTemporary() to reveal them again.
   */
  temporaryHide(ids: ContractId[]) {
    for (const id of ids) this.tempHidden.add(id);
    this.setTemporaryVisibility(ids, false);
  }

  /** Show all temporarily hidden elements. */
  showAllTemporary() {
    const ids = [...this.tempHidden];
    this.tempHidden.clear();
    this.setTemporaryVisibility(ids, true);
  }

  private setTemporaryVisibility(ids: ContractId[], visible: boolean) {
    for (const id of ids) {
      visible ? this.overlay.show(id) : this.overlay.hide(id);
    }
    const localIds: number[] = [];
    for (const id of ids) {
      const fragIds = this.doc.fragmentIds.get(id);
      if (fragIds !== undefined) localIds.push(fragIds.itemId);
    }
    if (localIds.length > 0) {
      this.enqueue(async () => {
        for (const [, model] of this.mgr.fragments.models.list) {
          await model.setVisible(localIds, visible);
        }
        await this.mgr.update(true);
      });
    }
  }

  /**
   * Force-refresh an element's overlay and schedule a fragment write.
   * Clears the geometry cache first so a fresh geometry is generated.
   * Use when external changes affect this element's geometry indirectly
   * (e.g., a "cuts" relationship was added or removed by another element).
   */
  forceRefresh(contractId: ContractId) {
    this.invalidateGeoCache(contractId);
    const contract = this.doc.contracts.get(contractId);
    if (!contract) return;
    // If the element is extracted, update overlay immediately + mark dirty
    // so restore will write the correct geometry.
    if (this.isExtracted(contractId)) {
      this.overlay.set(contract);
      this.vsm.markDirty(contractId);
      return;
    }
    // For non-extracted elements, enqueue a direct fragment write
    // (bypasses drainPending which skips while any element is extracted).
    this.enqueue(async () => {
      const fresh = this.doc.contracts.get(contractId);
      if (!fresh || this.isExtracted(contractId)) return;
      this.invalidateGeoCache(contractId);
      this.overlay.set(fresh);
      await this.onFlush([], [fresh]);
    });
  }

  /**
   * Add a boolean cut: cutter element cuts one or more target elements.
   * Updates the cutter's contract and refreshes target geometry.
   */
  addCut(cutterId: ContractId, targetIds: ContractId | ContractId[]) {
    const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
    const cutter = this.doc.contracts.get(cutterId);
    if (!cutter) return;
    const existing: ContractId[] = (cutter as Record<string, unknown>).cutTargets as ContractId[] ?? [];
    const newTargets = [...existing];
    for (const id of ids) {
      if (!newTargets.includes(id)) newTargets.push(id);
    }
    this.doc.update(cutterId, { cutTargets: newTargets });
    for (const id of ids) this.forceRefresh(id);
  }

  /**
   * Remove all boolean cuts from an element. Refreshes former targets.
   */
  removeCuts(contractId: ContractId) {
    const contract = this.doc.contracts.get(contractId);
    if (!contract) return;
    const targets: ContractId[] = (contract as Record<string, unknown>).cutTargets as ContractId[] ?? [];
    if (targets.length === 0) return;
    this.doc.update(contractId, { cutTargets: [] });
    for (const id of targets) this.forceRefresh(id);
  }

  /**
   * Refresh overlays for all extracted elements based on current contract state.
   * Call after undo/redo to pick up reverted geometry (including cascade neighbors).
   */
  refreshExtractedOverlays() {
    for (const id of this.vsm.inState(VisState.Extracted)) {
      const contract = this.doc.contracts.get(id);
      if (contract) this.overlay.set(contract);
    }
  }

  // ── Fast undo/redo support (S.27) ──────────────────────────────

  /**
   * Make all fragment model meshes translucent or restore full opacity.
   * Used during rapid undo/redo to de-emphasize stale geometry while
   * overlays show the accurate current state.
   */
  /** Saved original opacity/transparent per material before translucency was applied. */
  private savedMaterialState = new Map<number, { opacity: number; transparent: boolean }>();

  setModelTranslucency(translucent: boolean) {
    this.modelTranslucent = translucent;
    const base = this.mgr.fragments.models.list.get(this.mgr.modelId);
    const delta = this.getDeltaModel();
    const models = [base, delta].filter(Boolean);

    if (translucent) {
      // Save original state and make everything translucent
      this.savedMaterialState.clear();
      for (const model of models) {
        for (const child of model!.object.children) {
          const mesh = child as THREE.Mesh;
          const materials = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
          for (const mat of materials) {
            if (!mat) continue;
            this.savedMaterialState.set(mat.id, {
              opacity: mat.opacity,
              transparent: mat.transparent,
            });
            mat.transparent = true;
            mat.opacity = 0.3;
            mat.needsUpdate = true;
          }
        }
      }
    } else {
      // Restore original state (the delta model may have been rebuilt,
      // so materials might not be in the saved map — leave those as-is)
      for (const model of models) {
        for (const child of model!.object.children) {
          const mesh = child as THREE.Mesh;
          const materials = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
          for (const mat of materials) {
            if (!mat) continue;
            const saved = this.savedMaterialState.get(mat.id);
            if (saved) {
              mat.opacity = saved.opacity;
              mat.transparent = saved.transparent;
            }
            // New materials (from rebuilt delta) keep their correct values
            mat.needsUpdate = true;
          }
        }
      }
      this.savedMaterialState.clear();
    }
  }

  /**
   * Expand a set of IDs to include cascade neighbors (relationships +
   * dependentsOf). Must be called BEFORE doc.undo() removes contracts
   * and cleans up the reverse dependency index.
   */
  expandWithNeighbors(ids: ContractId[]): ContractId[] {
    const expanded = new Set(ids);
    for (const id of ids) {
      const contract = this.doc.contracts.get(id);
      if (contract) {
        const rels = this.registry.getRelationships(contract, this.doc);
        for (const rel of rels) expanded.add(rel.targetId);
      }
      const deps = this.getDependents(id);
      if (deps) for (const depId of deps) expanded.add(depId);
    }
    return [...expanded];
  }

  /**
   * Create/update overlays for the given IDs (already expanded to
   * include cascade neighbors). Remove overlays for elements whose
   * contracts no longer exist (e.g., undo of an add).
   */
  updateFastOverlays(ids: ContractId[]) {
    for (const id of ids) {
      if (this.isExtracted(id)) continue;
      const contract = this.doc.contracts.get(id);
      if (contract && this.registry.isDataOnly(contract.kind)) continue;
      if (contract) {
        this.overlay.set(contract);
      } else {
        this.overlay.remove(id);
      }
    }
  }

  /**
   * Clear all internal state for a fresh start (e.g., after loading a saved file).
   * Removes overlays, cancels pending ops, resets tracking.
   * The overlay manager remains reusable.
   */
  reset() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.restoreBatchTimer) {
      clearTimeout(this.restoreBatchTimer);
      this.restoreBatchTimer = null;
    }
    this.pendingRestoreContracts.length = 0;
    this.pendingRestoreIds.length = 0;
    this.vsm.reset();
    this.priorRelationships.clear();
    this.dependentsOf.clear();
    this.dependentsIndexDirty = true;
    this.pendingOps.clear();
    this.tempHidden.clear();
    this.pendingDeleteBatch.length = 0;
    this.pendingTypeReprDeletes.length = 0;
    this.editQueue = Promise.resolve();
    this.editQueueDepth = 0;
    this.lastFragmentRequestIndex = -1;
    this.isUndoRedo = false;
    this.overlay.clear();
    this.extractedWorldTransforms.clear();
    this.doc.typeReprIds.clear();
  }

  /**
   * Validate internal consistency. Throws on the first violation found.
   * Call in dev builds and tests to catch state corruption early.
   * Safe to call at any time — no side effects.
   */
  assertInvariants(): void {
    // Ensure dependentsOf is up-to-date before checking invariants
    this.ensureDependentsIndex();
    const errors: string[] = [];

    // 1. Every non-Normal vsm entry must have a contract
    const trackedStates = [
      VisState.Extracted, VisState.Restoring,
      VisState.FastUndo, VisState.Flushing, VisState.HistoryNav,
    ];
    for (const state of trackedStates) {
      for (const id of this.vsm.inState(state)) {
        if (!this.doc.contracts.has(id)) {
          errors.push(`vsm has ${VisState[state]} entry for "${id}" but contract is missing`);
        }
      }
    }

    // 2. Extracted elements must have overlays
    for (const id of this.vsm.inState(VisState.Extracted)) {
      if (!this.overlay.has(id)) {
        errors.push(`"${id}" is Extracted but has no overlay`);
      }
    }

    // 3. Extracted elements must have priorRelationships snapshot
    for (const id of this.vsm.inState(VisState.Extracted)) {
      if (!this.priorRelationships.has(id)) {
        errors.push(`"${id}" is Extracted but has no priorRelationships snapshot`);
      }
    }

    // 4. priorRelationships should only exist for Extracted/Restoring elements
    for (const id of this.priorRelationships.keys()) {
      const state = this.vsm.getState(id);
      if (state !== VisState.Extracted && state !== VisState.Restoring) {
        errors.push(`"${id}" has priorRelationships but is in state ${VisState[state]}`);
      }
    }

    // 5. dependentsOf reverse index matches forward relationships
    // Build expected from scratch and compare.
    // Skip relationships where the target was deleted — stale references
    // (e.g., cutTargets pointing to a removed element) are harmless and
    // get cleaned up asynchronously.
    const expectedDeps = new Map<ContractId, Set<ContractId>>();
    for (const [, contract] of this.doc.contracts) {
      const rels = this.registry.getRelationships(contract, this.doc);
      for (const rel of rels) {
        if (!this.doc.contracts.has(rel.targetId)) continue; // target deleted
        let set = expectedDeps.get(rel.targetId);
        if (!set) {
          set = new Set();
          expectedDeps.set(rel.targetId, set);
        }
        set.add(contract.id);
      }
    }
    // Check actual matches expected
    for (const [targetId, expectedSet] of expectedDeps) {
      const actual = this.dependentsOf.get(targetId);
      for (const depId of expectedSet) {
        if (!actual?.has(depId)) {
          errors.push(`dependentsOf["${targetId}"] missing "${depId}" (has relationship via registry)`);
        }
      }
    }
    // Check no extra entries in actual
    for (const [targetId, actualSet] of this.dependentsOf) {
      const expected = expectedDeps.get(targetId);
      for (const depId of actualSet) {
        if (!expected?.has(depId)) {
          errors.push(`dependentsOf["${targetId}"] has stale entry "${depId}" (no matching relationship)`);
        }
      }
    }

    // 6. draggingIds elements must be Extracted
    for (const id of this.overlay.draggingIds) {
      if (!this.isExtracted(id)) {
        errors.push(`"${id}" is in draggingIds but not Extracted`);
      }
    }

    // 7. dirty flag only on Extracted or Restoring elements
    for (const [, contract] of this.doc.contracts) {
      const state = this.vsm.getState(contract.id);
      if (this.vsm.isDirty(contract.id) && state !== VisState.Extracted && state !== VisState.Restoring) {
        errors.push(`"${contract.id}" is dirty but in state ${VisState[state]}`);
      }
    }

    // 8. pendingOps must reference existing contracts
    for (const id of this.pendingOps.keys()) {
      if (!this.doc.contracts.has(id)) {
        errors.push(`pendingOps has entry for "${id}" but contract is missing`);
      }
    }

    // 9. tempHidden must reference existing contracts
    for (const id of this.tempHidden) {
      if (!this.doc.contracts.has(id)) {
        errors.push(`tempHidden has entry for "${id}" but contract is missing`);
      }
    }

    // 10. Overlays without matching state: overlay exists but element is
    //     Normal and has no pending op (orphaned overlay — cleanup missed).
    //     Skip this check when a flush timer or async work is pending —
    //     drainPending clears pendingOps before the async onFlush removes
    //     the overlay, creating a harmless transient state.
    const asyncBusy = this.flushTimer !== null || this.editQueueDepth > 0 || this.modelTranslucent;
    if (!asyncBusy) {
      for (const id of this.overlay.ids) {
        const state = this.vsm.getState(id);
        if (state === VisState.Normal && !this.pendingOps.has(id)) {
          errors.push(`overlay exists for "${id}" but element is Normal with no pending op`);
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `FragmentSync invariant violations (${errors.length}):\n  - ${errors.join("\n  - ")}`
      );
    }
  }

  /**
   * Log full internal state to the console for debugging.
   * Call from browser console: `__bim.sync.debugDump()`
   */
  debugDump(): void {
    const states = new Map<string, { id: ContractId; dirty: boolean }[]>();
    for (const stateName of ["Extracted", "Restoring", "FastUndo", "Flushing", "HistoryNav"] as const) {
      const s = VisState[stateName as keyof typeof VisState];
      if (typeof s !== "number") continue;
      const ids = this.vsm.inState(s);
      if (ids.length > 0) {
        states.set(stateName, ids.map((id) => ({ id, dirty: this.vsm.isDirty(id) })));
      }
    }

    const deps: Record<string, string[]> = {};
    for (const [targetId, depSet] of this.dependentsOf) {
      deps[targetId] = [...depSet];
    }

    const pending: Record<string, string> = {};
    for (const [id, op] of this.pendingOps) {
      pending[id] = op.type;
    }

    const priorRels: Record<string, string[]> = {};
    for (const [id, rels] of this.priorRelationships) {
      priorRels[id] = [...rels];
    }

    const dump = {
      vsm: Object.fromEntries(states),
      vsmSize: this.vsm.size,
      overlays: this.overlay.ids,
      overlayCount: this.overlay.ids.length,
      draggingIds: [...this.overlay.draggingIds],
      pendingOps: pending,
      pendingOpsCount: this.pendingOps.size,
      dependentsOf: deps,
      priorRelationships: priorRels,
      lastFragmentRequestIndex: this.lastFragmentRequestIndex,
      isUndoRedo: this.isUndoRedo,
      flushTimerActive: this.flushTimer !== null,
      contracts: this.doc.contracts.size,
      fragmentIds: this.doc.fragmentIds.size,
      geoCacheSize: this.geoCache.size,
      geoCacheHits: this.geoCache.hits,
      geoCacheMisses: this.geoCache.misses,
    };

    console.group("FragmentSync debug dump");
    console.table({ summary: {
      contracts: dump.contracts,
      fragmentIds: dump.fragmentIds,
      vsmTracked: dump.vsmSize,
      overlays: dump.overlayCount,
      pendingOps: dump.pendingOpsCount,
      lastFragIndex: dump.lastFragmentRequestIndex,
      isUndoRedo: dump.isUndoRedo,
      flushTimer: dump.flushTimerActive,
      geoCache: `${dump.geoCacheSize} entries, ${dump.geoCacheHits} hits / ${dump.geoCacheMisses} misses`,
    }});
    if (states.size > 0) {
      console.group("VSM entries");
      for (const [state, entries] of states) {
        console.log(`${state}:`, entries);
      }
      console.groupEnd();
    }
    if (dump.overlays.length > 0) console.log("Overlays:", dump.overlays);
    if (dump.draggingIds.length > 0) console.log("Dragging:", dump.draggingIds);
    if (dump.pendingOpsCount > 0) console.log("Pending ops:", dump.pendingOps);
    if (Object.keys(deps).length > 0) console.log("dependentsOf:", deps);
    if (Object.keys(priorRels).length > 0) console.log("priorRelationships:", priorRels);
    console.groupEnd();

    return dump as any;
  }

  /**
   * Rebuild the reverse dependency index from all current contracts.
   * Call after loading a saved document to restore floor→wall mappings, etc.
   */
  rebuildDependentsIndex() {
    this.dependentsOf.clear();
    for (const [, contract] of this.doc.contracts) {
      this.updateDependentsIndex(contract);
    }
    this.dependentsIndexDirty = false;
  }

  /**
   * Rebuild the typeReprIds map from current fragmentIds + contracts.
   * Call after loading a saved document (if typeReprIds is missing) or after undo/redo.
   */
  rebuildTypeReprIds() {
    this.doc.typeReprIds.clear();
    for (const [contractId, ids] of this.doc.fragmentIds) {
      const contract = this.doc.contracts.get(contractId);
      if (!contract) continue;
      const typeId = (contract as any).typeId as ContractId | undefined;
      if (!typeId) continue;
      const def = this.registry.get(contract.kind);
      if (!def?.generateLocalGeometry) continue;

      const localResult = def.generateLocalGeometry(this.engine, contract, this.doc);
      if (!localResult) continue;

      let typeMap = this.doc.typeReprIds.get(typeId);
      if (!typeMap) {
        typeMap = new Map();
        this.doc.typeReprIds.set(typeId, typeMap);
      }

      for (let i = 0; i < localResult.parts.length && i < ids.samples.length; i++) {
        const hash = localResult.parts[i].geoHash;
        if (!typeMap.has(hash)) {
          const s = ids.samples[i];
          typeMap.set(hash, { reprId: s.reprId, ltId: s.ltId, matId: s.matId });
        }
        localResult.parts[i].geometry.dispose();
      }
    }
  }

  /** Rebuild the dependentsOf index if it's been marked dirty. */
  private ensureDependentsIndex() {
    if (this.dependentsIndexDirty) {
      this.rebuildDependentsIndex();
    }
  }

  /** Get dependents of an element, rebuilding the index if needed. */
  private getDependents(id: ContractId): Set<ContractId> | undefined {
    this.ensureDependentsIndex();
    return this.dependentsOf.get(id);
  }

  /** Force-flush all pending operations. */
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Drain any pending restore batch immediately
    if (this.restoreBatchTimer) {
      clearTimeout(this.restoreBatchTimer);
      this.restoreBatchTimer = null;
      this.flushRestoreBatch();
    }
    // Process any pending delete batch that was queued via microtask
    // but hasn't fired yet — without this, flush() can complete before
    // the delete requests reach editQueue, causing the undo entry to
    // record a fragment index that doesn't include the deletion.
    if (this.pendingDeleteBatch.length > 0) {
      const batch = this.pendingDeleteBatch.splice(0);
      this.enqueue(() => this.onDeleteBatch(batch));
    }
    this.drainPending();
    await this.editQueue;
  }

  /**
   * Extract an element from fragments into an overlay for fast editing.
   * Also extracts related elements (hosted children, connected peers, hosts).
   */
  extract(contractId: ContractId) {
    const toHide: ContractId[] = [];
    this.extractElement(contractId, toHide);

    const contract = this.doc.contracts.get(contractId);
    if (!contract) return;

    // Extract cascade: walk relationships
    const cascade = this.getExtractCascade(contractId);
    for (const relatedId of cascade) {
      this.extractElement(relatedId, toHide);
    }

    // Batch-hide all extracted elements in a single setVisible + update call
    if (toHide.length > 0) {
      this.enqueue(() => this.hideElements(toHide));
    }
  }

  // ── Batched restore ──────────────────────────────────────────────
  // Accumulates restore requests from rapid clicks and flushes them
  // in a single batch, avoiding sequential fragment writes + tile waits.
  private pendingRestoreContracts: AnyContract[] = [];
  private pendingRestoreIds: ContractId[] = [];
  private restoreBatchTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Restore extracted elements back to fragments.
   * Rapid calls are batched: IDs accumulate and the actual flush runs
   * once after a short debounce, consolidating multiple restores into one.
   * @param exclude IDs to skip (e.g., elements about to be re-extracted).
   */
  restore(contractIds: ContractId[], exclude?: Set<ContractId>) {
    for (const contractId of contractIds) {
      if (exclude?.has(contractId)) continue;
      if (!this.isExtracted(contractId)) continue;
      if (this.pendingRestoreIds.includes(contractId)) continue;
      this.vsm.transition(contractId, VisState.Restoring);
      const contract = this.doc.contracts.get(contractId);
      if (!contract) {
        this.vsm.clear(contractId);
        this.overlay.remove(contractId);
        continue;
      }
      this.pendingRestoreContracts.push(contract);
      this.pendingRestoreIds.push(contractId);

      // Restore cascade: related elements
      this.collectRestoreCascade(contract, this.pendingRestoreContracts, this.pendingRestoreIds, exclude);
    }

    // Safety sweep: catch any extracted orphan overlays
    const restoreSet = new Set(this.pendingRestoreIds);
    for (const id of this.overlay.ids) {
      if (restoreSet.has(id)) continue;
      if (exclude?.has(id)) continue;
      if (!this.isExtracted(id)) continue;
      this.vsm.transition(id, VisState.Restoring);
      const c = this.doc.contracts.get(id);
      if (c) {
        this.pendingRestoreContracts.push(c);
        this.pendingRestoreIds.push(id);
      }
    }

    // Debounce: batch rapid calls into one flush
    if (this.restoreBatchTimer) clearTimeout(this.restoreBatchTimer);
    this.restoreBatchTimer = setTimeout(() => this.flushRestoreBatch(), 16);
  }

  private flushRestoreBatch() {
    this.restoreBatchTimer = null;
    const restoreContracts = this.pendingRestoreContracts.splice(0);
    const restoreIds = this.pendingRestoreIds.splice(0);

    if (restoreIds.length === 0) return;

    for (const id of restoreIds) {
      this.pendingOps.delete(id);
    }

    this.enqueue(async () => {
      const dirty = restoreContracts.filter(
        (c) => !this.isExtracted(c.id) && this.doc.fragmentIds.has(c.id) && this.vsm.isDirty(c.id)
      );
      if (dirty.length > 0) {
        await this.onFlush([], dirty, true);
      }
      const localIds: number[] = [];
      for (const id of restoreIds) {
        if (this.isExtracted(id)) continue;
        const fragIds = this.doc.fragmentIds.get(id);
        if (fragIds !== undefined) localIds.push(fragIds.itemId);
      }
      if (localIds.length > 0) {
        const delta = this.getDeltaModel();
        if (delta) await delta.setVisible(localIds, true);

        const base = this.mgr.fragments.models.list.get(this.mgr.modelId);
        if (base?.setVisible) {
          const editedSet = delta
            ? new Set(await base.getEditedElements())
            : new Set<number>();
          const baseIds = localIds.filter((id) => !editedSet.has(id));
          if (baseIds.length > 0) await base.setVisible(baseIds, true);
        }

        await this.mgr.update(true);
      }
      await this.waitForTilesReady();
      for (const id of restoreIds) {
        if (!this.isExtracted(id)) {
          if (!this.pendingOps.has(id)) {
            this.overlay.remove(id);
          }
          if (this.vsm.getState(id) === VisState.Restoring) {
            this.vsm.transition(id, VisState.Normal);
            this.priorRelationships.delete(id);
          }
        }
      }
      this.drainPending();
    });
  }

  // ── Private: cascade helpers ─────────────────────────────────────

  /**
   * When an element changes, refresh related elements' overlays
   * and optionally schedule fragment writes.
   */
  private cascadeOnChange(
    contract: AnyContract,
    scheduleWrites: boolean,
    skipOverlays = false
  ) {
    if (this.cascadingIds.has(contract.id)) return;
    this.cascadingIds.add(contract.id);
    this.cascadeDepth++;
    try {
    const rels = this.registry.getRelationships(contract, this.doc);
    const currentIds = new Set(rels.map((r) => r.targetId));

    // Refresh currently related elements
    for (const rel of rels) {
      const related = this.doc.contracts.get(rel.targetId);
      if (!related) continue;
      // Data-only targets (type contracts) have no geometry/fragments — skip.
      if (this.registry.isDataOnly(related.kind)) continue;
      this.invalidateGeoCache(rel.targetId);
      if (!skipOverlays) {
        this.overlay.set(related);
      }
      if (this.isExtracted(rel.targetId)) {
        this.vsm.markDirty(rel.targetId);
      }
      if (scheduleWrites) {
        this.schedulePending(rel.targetId, "update", related);
      }
    }

    // Also refresh elements that WERE related before extraction but no longer are
    // (e.g., miter neighbor after wall moved away)
    const priorIds = this.priorRelationships.get(contract.id);
    if (priorIds) {
      for (const priorId of priorIds) {
        if (currentIds.has(priorId)) continue; // still related, already handled
        const related = this.doc.contracts.get(priorId);
        if (!related) continue;
        if (this.registry.isDataOnly(related.kind)) continue;
        this.invalidateGeoCache(priorId);
        if (!skipOverlays) {
          this.overlay.set(related);
        }
        if (this.isExtracted(priorId)) {
          this.vsm.markDirty(priorId);
        }
        if (scheduleWrites) {
          this.schedulePending(priorId, "update", related);
        }
      }
    }

    // Update prior relationships snapshot so that if relationships are
    // added then removed while extracted, the prior snapshot stays current.
    if (this.isExtracted(contract.id)) {
      const allPrior = new Set(priorIds ?? []);
      for (const id of currentIds) allPrior.add(id);
      this.priorRelationships.set(contract.id, [...allPrior]);
    }

    // Reverse cascade: refresh elements that depend on this element
    // (e.g., floor with connectedTo → wall)
    const dependents = this.getDependents(contract.id);
    if (dependents) {
      for (const depId of dependents) {
        if (currentIds.has(depId)) continue; // already handled above
        const dep = this.doc.contracts.get(depId);
        if (!dep) continue;
        // Data-only dependents (e.g., type contracts depending on a material):
        // they have no geometry, but their own dependents (instances) do.
        // Recurse through them without creating overlays or scheduling writes.
        if (this.registry.isDataOnly(dep.kind)) {
          this.cascadeOnChange(dep, scheduleWrites, skipOverlays);
          continue;
        }
        this.invalidateGeoCache(depId);
        if (!skipOverlays) {
          this.overlay.set(dep);
        }
        if (this.isExtracted(depId)) {
          this.vsm.markDirty(depId);
        }
        if (scheduleWrites) {
          this.schedulePending(depId, "update", dep);
        }
        // Recursive cascade: the dependent's own relationships may need
        // refreshing (e.g., window type change → window updated → host wall
        // needs new void geometry).
        this.cascadeOnChange(dep, scheduleWrites, skipOverlays);
      }
    }
    } finally {
      this.cascadeDepth--;
      if (this.cascadeDepth === 0) {
        this.cascadingIds.clear();
      }
    }
  }

  /** Invalidate geometry cache for an element and everything that depends on it. */
  private invalidateGeoCache(contractId: ContractId) {
    this.geoCache.invalidate(contractId);
  }

  /**
   * Get all element IDs that should be extracted alongside `id`.
   * - "hosts" → extract children, recurse into their relationships
   * - "connectedTo" → extract peer (don't recurse through their hosts)
   * - "hostedBy" → extract host, recurse into its relationships
   */
  /** Get IDs that would be cascade-extracted alongside the given element. */
  getExtractCascade(id: ContractId): ContractId[] {
    const result: ContractId[] = [];
    const visited = new Set<ContractId>([id]);
    this.collectExtract(id, result, visited);
    return result;
  }

  private collectExtract(
    id: ContractId,
    result: ContractId[],
    visited: Set<ContractId>
  ) {
    const contract = this.doc.contracts.get(id);
    if (!contract) return;

    const rels = this.registry.getRelationships(contract, this.doc);
    for (const rel of rels) {
      if (visited.has(rel.targetId)) continue;
      const behavior = this.registry.getRelationshipBehavior(rel.type);
      if (behavior.onExtract === "skip") continue;
      visited.add(rel.targetId);
      result.push(rel.targetId);

      if (behavior.onExtract === "recurse") {
        this.collectExtract(rel.targetId, result, visited);
      }
    }

    // Reverse dependents: extract elements that reference this one
    // (e.g., floor referencing this wall via connectedTo).
    // Don't recurse — we just need to hide their fragments.
    const dependents = this.getDependents(id);
    if (dependents) {
      for (const depId of dependents) {
        if (visited.has(depId)) continue;
        visited.add(depId);
        result.push(depId);
      }
    }
  }

  /**
   * Collect related elements that should be restored alongside a contract.
   * Uses RelationshipBehavior.onRestore to decide per relationship type:
   *   "recurse" → restore target + recurse into its relationships
   *   "include" → restore target (+ its hosted children) without further recursion
   *   "skip"    → don't restore
   */
  private collectRestoreCascade(
    contract: AnyContract,
    restoreContracts: AnyContract[],
    restoreIds: ContractId[],
    exclude?: Set<ContractId>
  ) {
    const rels = this.registry.getRelationships(contract, this.doc);
    for (const rel of rels) {
      if (exclude?.has(rel.targetId)) continue;
      if (restoreIds.includes(rel.targetId)) continue;
      const behavior = this.registry.getRelationshipBehavior(rel.type);
      if (behavior.onRestore === "skip") continue;

      if (behavior.onRestore === "recurse") {
        if (this.isExtracted(rel.targetId)) {
          this.vsm.transition(rel.targetId, VisState.Restoring);
          const target = this.doc.contracts.get(rel.targetId);
          if (target) {
            restoreContracts.push(target);
            restoreIds.push(rel.targetId);
            this.collectRestoreCascade(target, restoreContracts, restoreIds, exclude);
          }
        }
      } else {
        this.restoreWithHostedChildren(rel.targetId, restoreContracts, restoreIds, exclude);
      }
    }

    // Reverse dependents: restore elements that reference this one
    // (e.g., floor referencing this wall via connectedTo).
    // Mirrors collectExtract's reverse-dependent inclusion.
    const dependents = this.getDependents(contract.id);
    if (dependents) {
      for (const depId of dependents) {
        if (exclude?.has(depId)) continue;
        if (restoreIds.includes(depId)) continue;
        if (!this.isExtracted(depId)) continue;
        this.restoreWithHostedChildren(depId, restoreContracts, restoreIds, exclude);
      }
    }

    // Also restore old neighbors from prior snapshot that are no longer in current rels
    const priorIds = this.priorRelationships.get(contract.id);
    if (priorIds) {
      const currentTargets = new Set(rels.map((r) => r.targetId));
      for (const priorId of priorIds) {
        if (currentTargets.has(priorId)) continue;
        if (exclude?.has(priorId)) continue;
        if (restoreIds.includes(priorId)) continue;
        this.restoreWithHostedChildren(priorId, restoreContracts, restoreIds, exclude);
      }
    }

    // Clean up snapshot
    this.priorRelationships.delete(contract.id);
  }

  /**
   * Restore a related element and any of its children that have
   * onDelete === "cascade" behavior (i.e., hosted children).
   * Used for "include" restore behavior — no further recursion.
   */
  private restoreWithHostedChildren(
    targetId: ContractId,
    restoreContracts: AnyContract[],
    restoreIds: ContractId[],
    exclude?: Set<ContractId>
  ) {
    if (exclude?.has(targetId)) return;
    if (restoreIds.includes(targetId)) return;
    // Skip elements that were never extracted — nothing to restore.
    // Their pending ops (if any) should be preserved for drainPending.
    if (!this.isExtracted(targetId)) return;
    this.vsm.transition(targetId, VisState.Restoring);
    const target = this.doc.contracts.get(targetId);
    if (target) {
      restoreContracts.push(target);
      restoreIds.push(targetId);
      this.pendingOps.delete(targetId);
      // Also restore any extracted children that would cascade-delete with this element
      const targetRels = this.registry.getRelationships(target, this.doc);
      for (const childRel of targetRels) {
        const childBehavior = this.registry.getRelationshipBehavior(childRel.type);
        if (
          childBehavior.onDelete === "cascade" &&
          this.isExtracted(childRel.targetId) &&
          !restoreIds.includes(childRel.targetId)
        ) {
          this.vsm.transition(childRel.targetId, VisState.Restoring);
          const child = this.doc.contracts.get(childRel.targetId);
          if (child) {
            restoreContracts.push(child);
            restoreIds.push(childRel.targetId);
          }
          this.priorRelationships.delete(childRel.targetId);
        }
      }
    }
    this.priorRelationships.delete(targetId);
  }

  // ── Private: extract/visibility helpers ──────────────────────────

  private extractElement(id: ContractId, toHide: ContractId[]) {
    if (this.isExtracted(id)) return;
    this.vsm.transition(id, VisState.Extracted);
    const contract = this.doc.contracts.get(id);
    if (contract) {
      this.overlay.set(contract);
      const rels = this.registry.getRelationships(contract, this.doc);
      this.priorRelationships.set(id, rels.map((r) => r.targetId));

      // Snapshot GT for instanced elements so flush can skip no-op updates
      const def = this.registry.get(contract.kind);
      if (def?.generateLocalGeometry) {
        const result = def.generateLocalGeometry(this.engine, contract, this.doc);
        if (result) {
          this.extractedWorldTransforms.set(id, result.worldTransform.clone());
          for (const part of result.parts) part.geometry.dispose();
        }
      }
    }
    this.pendingOps.delete(id);
    toHide.push(id);
  }

  /**
   * Wait for the fragment tile system to finish processing after a
   * visibility change. Uses the library's onViewUpdated event with a
   * safety timeout fallback.
   */
  private waitForTilesReady(): Promise<void> {
    const baseModel = this.mgr.fragments.models.list.get(this.mgr.modelId);
    if (!baseModel?.onViewUpdated) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        baseModel.onViewUpdated.remove(done);
        resolve();
      };
      baseModel.onViewUpdated.add(done);
      // Safety fallback — if no tile cycle triggers (e.g., nothing changed)
      setTimeout(done, 200);
    });
  }

  private getDeltaModel() {
    const baseModel = this.mgr.fragments.models.list.get(this.mgr.modelId);
    if (!baseModel?.deltaModelId) return null;
    return this.mgr.fragments.models.list.get(baseModel.deltaModelId) ?? null;
  }

  private async hideElements(contractIds: ContractId[]) {
    const localIds: number[] = [];
    for (const id of contractIds) {
      const fragIds = this.doc.fragmentIds.get(id);
      if (fragIds !== undefined) localIds.push(fragIds.itemId);
    }
    if (localIds.length === 0) return;

    // Hide on delta model if it exists
    const delta = this.getDeltaModel();
    if (delta) {
      await delta.setVisible(localIds, false);
    }

    // Also hide on base model (needed after load when no delta exists yet)
    const base = this.mgr.fragments.models.list.get(this.mgr.modelId);
    if (base?.setVisible) {
      await base.setVisible(localIds, false);
    }

    await this.mgr.update(true);
  }

  // ── Private: pending ops / flush ─────────────────────────────────

  private schedulePending(
    id: ContractId,
    type: "create" | "update",
    contract: AnyContract
  ) {
    const existing = this.pendingOps.get(id);
    if (existing) {
      if (existing.type === "create") {
        this.pendingOps.set(id, { type: "create", contract });
      } else {
        this.pendingOps.set(id, { type: "update", contract });
      }
    } else {
      this.pendingOps.set(id, { type, contract });
    }

    // Don't start flush timer during drag — writes happen when drag ends
    if (this.overlay.draggingIds.size > 0) return;

    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.drainPending(), this.DEBOUNCE_MS);
  }

  private drainPending() {
    this.flushTimer = null;
    // Don't flush while any elements are extracted (selected). The overlay
    // provides the visual state; calling editor.edit() would rebuild the
    // delta and briefly flash extracted elements. Everything is flushed
    // on restore (deselect) instead.
    if (this.vsm.hasAny(VisState.Extracted)) return;
    if (this.overlay.draggingIds.size > 0) return;
    const ops = new Map(this.pendingOps);
    this.pendingOps.clear();

    const creates: AnyContract[] = [];
    const updates: AnyContract[] = [];
    for (const [id, op] of ops) {
      if (op.type === "create") {
        creates.push(op.contract);
      } else {
        updates.push(op.contract);
      }
    }

    this.enqueue(() => this.onFlush(creates, updates));
  }

  private generateGeometry(contract: AnyContract): THREE.BufferGeometry {
    const geo = this.geoCache.getOrGenerate(this.registry, this.engine, contract, this.doc);
    // 1. Merge nearly-identical vertices from boolean output (snaps positions
    //    that differ by ~1e-6 so the shell converter can deduplicate them).
    // 2. Convert to non-indexed so computeVertexNormals produces flat face
    //    normals instead of smooth averaged normals (the shell converter reads
    //    vertex normals to group coplanar triangles).
    const merged = BufferGeometryUtils.mergeVertices(geo, 1e-4);
    if (merged !== geo) geo.dispose();
    const flat = merged.toNonIndexed();
    merged.dispose();
    flat.computeVertexNormals();
    // Snap normals to a coarse grid so coplanar triangles get identical values.
    // computeVertexNormals uses cross products which produce slightly different
    // normals for different coplanar triangles due to floating-point arithmetic.
    // The shell converter groups triangles by plane ID (rounded normal + constant),
    // so even tiny normal differences break face merging.
    this.quantizeNormals(flat, 1e-4);
    // Shell converter requires an index buffer; add a sequential one.
    const vertexCount = flat.getAttribute("position").count;
    const indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indices[i] = i;
    flat.setIndex(new THREE.BufferAttribute(indices, 1));
    return flat;
  }

  /**
   * Snap each triangle's normal to a coarse grid so coplanar faces
   * share exactly the same normal vector. Operates on non-indexed geometry
   * where every 3 consecutive vertices form one triangle.
   */
  private quantizeNormals(geo: THREE.BufferGeometry, tolerance: number) {
    const normalAttr = geo.getAttribute("normal");
    const arr = normalAttr.array as Float32Array;
    const inv = 1 / tolerance;
    const v = new THREE.Vector3();

    for (let i = 0; i < arr.length; i += 9) {
      // Read the face normal from the first vertex of the triangle
      v.set(arr[i], arr[i + 1], arr[i + 2]);
      // Quantize: round each component to the grid, then re-normalize
      v.x = Math.round(v.x * inv) / inv;
      v.y = Math.round(v.y * inv) / inv;
      v.z = Math.round(v.z * inv) / inv;
      v.normalize();
      // Write the same snapped normal to all 3 vertices
      for (let j = 0; j < 3; j++) {
        arr[i + j * 3] = v.x;
        arr[i + j * 3 + 1] = v.y;
        arr[i + j * 3 + 2] = v.z;
      }
    }
    normalAttr.needsUpdate = true;
  }

  private async onFlush(
    creates: AnyContract[],
    updates: AnyContract[],
    skipOverlayRemoval = false
  ) {
    const editor = this.mgr.editor;
    const modelId = this.mgr.modelId;
    const geometries: THREE.BufferGeometry[] = [];

    // Build create requests
    const writer = new FragmentWriter();
    const createTempIds = new Map<ContractId, string>();

    // Track which creates introduced new type repr entries (for post-resolve storage)
    const newTypeReprEntries: { contractId: ContractId; typeId: ContractId; newSamples: { geoHash: string; sampleIndex: number }[] }[] = [];

    for (const contract of creates) {
      const def = this.registry.get(contract.kind);
      const attrs = { _category: { value: contract.kind }, _contractId: { value: contract.id } };

      let tempId: string;
      if (def?.generateLocalGeometry) {
        // Instanced path: type-level repr sharing
        const result = def.generateLocalGeometry(this.engine, contract, this.doc);
        if (!result) {
          // Fallback to unique path
          const worldGeo = this.generateGeometry(contract);
          geometries.push(worldGeo);
          tempId = writer.buildCreate(worldGeo, this.defaultMaterial, this.identityTransform, attrs, contract.kind);
          createTempIds.set(contract.id, tempId);
          continue;
        }

        const typeId = (contract as any).typeId as ContractId | undefined;
        const typeReprMap = typeId ? this.doc.typeReprIds.get(typeId) : undefined;
        const newSamples: { geoHash: string; sampleIndex: number }[] = [];

        // Build parts array, reusing existing type-level repr IDs where possible
        const parts: InstancedPart[] = result.parts.map((part, partIndex) => {
          const existingIds = typeReprMap?.get(part.geoHash);
          if (existingIds) {
            // Reuse existing repr/lt/mat from type
            part.geometry.dispose();
            return {
              geometry: part.geometry, // won't be used (existingIds set)
              geoHash: part.geoHash,
              material: part.material ?? this.defaultMaterial,
              existingIds,
            };
          }
          // New repr needed — track sample index for post-resolve storage
          newSamples.push({ geoHash: part.geoHash, sampleIndex: partIndex });
          geometries.push(part.geometry);
          return {
            geometry: part.geometry,
            geoHash: part.geoHash,
            material: part.material ?? this.defaultMaterial,
          };
        });

        if (typeId && newSamples.length > 0) {
          newTypeReprEntries.push({ contractId: contract.id, typeId, newSamples });
        }

        tempId = writer.buildCreateInstanced(result.worldTransform, parts, attrs, contract.kind);
      } else {
        // Unique path: world-space geometry, one representation per element
        const geo = this.generateGeometry(contract);
        geometries.push(geo);
        // Resolve material from type if available
        const typeId = (contract as any).typeId as ContractId | undefined;
        const typeContract = typeId ? this.doc.contracts.get(typeId) : undefined;
        const bodyMatId = (typeContract as any)?.materials?.body as ContractId | undefined;
        const mat = bodyMatId ? resolveMaterial(bodyMatId, this.doc, this.defaultMaterial) : this.defaultMaterial;
        tempId = writer.buildCreate(
          geo,
          mat,
          this.identityTransform,
          attrs,
          contract.kind
        );
      }
      createTempIds.set(contract.id, tempId);
    }

    const createRequests = writer.flush();

    // Collect update requests.
    // For instanced elements: update each sample's repr + mat once per ID,
    // and update each instance's global transform only if it actually changed.
    const updateRequests: EditRequest[] = [];
    const updatedReprIds = new Set<number>();
    const updatedMatIds = new Set<number>();
    for (const contract of updates) {
      const def = this.registry.get(contract.kind);

      if (def?.generateLocalGeometry) {
        const ids = this.doc.fragmentIds.get(contract.id);
        if (!ids) continue;

        // Generate local geometry + world transform for this instance
        const localResult = def.generateLocalGeometry(this.engine, contract, this.doc);
        if (!localResult) continue;

        // Update each sample's representation and material (deduplicated by ID)
        for (let i = 0; i < localResult.parts.length && i < ids.samples.length; i++) {
          const part = localResult.parts[i];
          const sample = ids.samples[i];
          if (!updatedReprIds.has(sample.reprId)) {
            updatedReprIds.add(sample.reprId);
            const reprData = GeomsFbUtils.representationFromGeometry(part.geometry);
            updateRequests.push({
              type: EditRequestType.UPDATE_REPRESENTATION,
              localId: sample.reprId,
              data: reprData,
            } as EditRequest);
            geometries.push(part.geometry);
          } else {
            part.geometry.dispose();
          }
          // Update material (deduplicated by matId — shared across instances)
          if (part.material && !updatedMatIds.has(sample.matId)) {
            updatedMatIds.add(sample.matId);
            updateRequests.push({
              type: EditRequestType.UPDATE_MATERIAL,
              localId: sample.matId,
              data: {
                r: part.material.color.r * 255,
                g: part.material.color.g * 255,
                b: part.material.color.b * 255,
                a: part.material.opacity * 255,
                renderedFaces: part.material.side === THREE.DoubleSide ? 1 : 0,
                stroke: 0,
              },
            } as EditRequest);
          }
        }

        // Global transform: update only if it changed since extraction
        const prevGt = this.extractedWorldTransforms.get(contract.id);
        if (!prevGt || !prevGt.equals(localResult.worldTransform)) {
          const gtData = GeomsFbUtils.transformFromMatrix(localResult.worldTransform);
          updateRequests.push({
            type: EditRequestType.UPDATE_GLOBAL_TRANSFORM,
            localId: ids.gtId,
            data: { ...gtData, itemId: ids.itemId },
          } as EditRequest);
        }

      } else {
        // Unique element: world-space geometry as before
        const result = this.prepareUpdate(contract);
        if (result) {
          updateRequests.push(...result.requests);
          geometries.push(result.geometry);
        }
      }
    }

    // Single editor.edit() call
    const allRequests = [...createRequests, ...updateRequests];
    if (allRequests.length > 0) {
      await editor.edit(modelId, allRequests);

      for (const [contractId, tempId] of createTempIds) {
        const ids = writer.resolveAllIds(tempId, createRequests);
        this.doc.fragmentIds.set(contractId, ids);
      }
      writer.clearTempIds();

      // Store newly created repr IDs in typeReprIds for cross-flush sharing
      for (const { contractId, typeId, newSamples } of newTypeReprEntries) {
        const ids = this.doc.fragmentIds.get(contractId);
        if (!ids) continue;
        let typeMap = this.doc.typeReprIds.get(typeId);
        if (!typeMap) {
          typeMap = new Map();
          this.doc.typeReprIds.set(typeId, typeMap);
        }
        // Store each new sample's resolved IDs by its exact sample index
        for (const { geoHash, sampleIndex } of newSamples) {
          const sample = ids.samples[sampleIndex];
          if (sample && !typeMap.has(geoHash)) {
            typeMap.set(geoHash, { reprId: sample.reprId, ltId: sample.ltId, matId: sample.matId });
          }
        }
      }

      // Track fragment history index
      await this.updateFragmentHistoryIndex();

      // editor.edit() rebuilds the delta model — re-hide extracted elements.
      await this.reHideExtracted();

      await this.mgr.update(true);
    }

    for (const geo of geometries) geo.dispose();
    // Extracted GT snapshots are only needed during the flush comparison
    for (const c of updates) this.extractedWorldTransforms.delete(c.id);
    if (!skipOverlayRemoval) {
      for (const c of [...creates, ...updates]) {
        // Don't remove overlays for elements that were extracted while
        // this flush was queued — they still need their overlay visible.
        // Also keep the overlay if a newer pending op exists (e.g., cascade
        // updated the overlay with correct miter while this flush was running).
        if (!this.isExtracted(c.id) && !this.pendingOps.has(c.id)) {
          this.overlay.remove(c.id);
        }
      }
    }
  }

  private prepareUpdate(
    contract: AnyContract
  ): { requests: EditRequest[]; geometry: THREE.BufferGeometry } | null {
    const ids = this.doc.fragmentIds.get(contract.id);
    if (!ids || ids.samples.length === 0) return null;

    const newGeo = this.generateGeometry(contract);
    const reprData = GeomsFbUtils.representationFromGeometry(newGeo);

    // Unique elements have exactly 1 sample
    const requests: EditRequest[] = [{
      type: EditRequestType.UPDATE_REPRESENTATION,
      localId: ids.samples[0].reprId,
      data: reprData,
    } as EditRequest];

    // Also update material if a type material is assigned
    const typeId = (contract as any).typeId as ContractId | undefined;
    const typeContract = typeId ? this.doc.contracts.get(typeId) : undefined;
    const bodyMatId = (typeContract as any)?.materials?.body as ContractId | undefined;
    const mat = bodyMatId ? resolveMaterial(bodyMatId, this.doc, this.defaultMaterial) : this.defaultMaterial;
    requests.push({
      type: EditRequestType.UPDATE_MATERIAL,
      localId: ids.samples[0].matId,
      data: {
        r: mat.color.r * 255,
        g: mat.color.g * 255,
        b: mat.color.b * 255,
        a: mat.opacity * 255,
        renderedFaces: mat.side === THREE.DoubleSide ? 1 : 0,
        stroke: 0,
      },
    } as EditRequest);

    return { requests, geometry: newGeo };
  }

  /**
   * Delete a batch of elements in a single editor.edit() call.
   * Also updates any extracted neighbors that were marked dirty by the
   * deletion (e.g. miter neighbors that need their corner geometry rebuilt).
   * Everything goes through one editor.edit() to avoid intermediate rebuilds.
   */
  private async onDeleteBatch(batch: { contractId: ContractId; ids: FragmentElementIds; isInstanced: boolean }[]) {
    const editor = this.mgr.editor;
    const modelId = this.mgr.modelId;
    const allRequests: EditRequest[] = [];
    const geometries: THREE.BufferGeometry[] = [];

    // For unique elements (no typeId), we still need to check shared resources.
    // For instanced elements, repr/lt/mat are owned by the type — never delete them here.
    const deletingIds = new Set(batch.map(b => b.contractId));
    const stillReferencedReprIds = new Set<number>();
    const stillReferencedLtIds = new Set<number>();
    const stillReferencedMatIds = new Set<number>();
    // Only build reference sets for unique elements (those without a type)
    for (const [contractId, ids] of this.doc.fragmentIds) {
      if (deletingIds.has(contractId)) continue;
      for (const s of ids.samples) {
        stillReferencedReprIds.add(s.reprId);
        stillReferencedLtIds.add(s.ltId);
        stillReferencedMatIds.add(s.matId);
      }
    }

    // 1. Collect delete requests
    for (const { contractId, ids, isInstanced } of batch) {
      this.doc.fragmentIds.delete(contractId);

      // Always delete unique-per-element entities: samples + gt + item
      for (const s of ids.samples) {
        allRequests.push({ type: EditRequestType.DELETE_SAMPLE, localId: s.sampleId } as EditRequest);
      }
      allRequests.push(
        { type: EditRequestType.DELETE_GLOBAL_TRANSFORM, localId: ids.gtId } as EditRequest,
        { type: EditRequestType.DELETE_ITEM, localId: ids.itemId } as EditRequest,
      );

      // For unique elements: delete repr/lt/mat if not referenced elsewhere
      // For instanced elements: repr/lt/mat are owned by the type — skip
      if (!isInstanced) {
        for (const s of ids.samples) {
          if (!stillReferencedReprIds.has(s.reprId)) {
            allRequests.push({ type: EditRequestType.DELETE_REPRESENTATION, localId: s.reprId } as EditRequest);
          }
          if (!stillReferencedLtIds.has(s.ltId)) {
            allRequests.push({ type: EditRequestType.DELETE_LOCAL_TRANSFORM, localId: s.ltId } as EditRequest);
          }
          if (!stillReferencedMatIds.has(s.matId)) {
            allRequests.push({ type: EditRequestType.DELETE_MATERIAL, localId: s.matId } as EditRequest);
          }
        }
      }
    }

    // 1b. Include type-owned repr/lt/mat deletes (stashed by type onRemoved)
    if (this.pendingTypeReprDeletes.length > 0) {
      for (const entry of this.pendingTypeReprDeletes) {
        allRequests.push(
          { type: EditRequestType.DELETE_REPRESENTATION, localId: entry.reprId } as EditRequest,
          { type: EditRequestType.DELETE_LOCAL_TRANSFORM, localId: entry.ltId } as EditRequest,
          { type: EditRequestType.DELETE_MATERIAL, localId: entry.matId } as EditRequest,
        );
      }
      this.pendingTypeReprDeletes.length = 0;
    }

    // 2. Collect update requests for dirty extracted neighbors
    const restoredIds: ContractId[] = [];
    for (const id of this.vsm.inState(VisState.Extracted)) {
      if (!this.vsm.isDirty(id)) continue;
      const contract = this.doc.contracts.get(id);
      if (!contract) continue;
      const result = this.prepareUpdate(contract);
      if (result) {
        allRequests.push(...result.requests);
        geometries.push(result.geometry);
      }
      restoredIds.push(id);
    }

    // Un-extract restored neighbors (dirty cleared by state transition)
    for (const id of restoredIds) {
      this.vsm.transition(id, VisState.Normal);
      this.priorRelationships.delete(id);
    }

    if (allRequests.length > 0) {
      await editor.edit(modelId, allRequests);
      await this.updateFragmentHistoryIndex();
      await this.reHideExtracted();
      await this.mgr.update(true);
    }

    // Remove overlays for restored neighbors (fragment now has correct geometry)
    for (const id of restoredIds) {
      this.overlay.remove(id);
    }

    for (const geo of geometries) geo.dispose();
  }

  private async updateFragmentHistoryIndex() {
    const { requests } = await this.mgr.editor.getModelRequests(this.mgr.modelId);
    this.lastFragmentRequestIndex = requests.length - 1;
  }

  private async reHideExtracted() {
    if (!this.vsm.hasAny(VisState.Extracted)) return;
    const reHideIds: number[] = [];
    for (const id of this.vsm.inState(VisState.Extracted)) {
      const fragIds = this.doc.fragmentIds.get(id);
      if (fragIds !== undefined) reHideIds.push(fragIds.itemId);
    }
    if (reHideIds.length > 0) {
      const delta = this.getDeltaModel();
      if (delta) await delta.setVisible(reHideIds, false);
      const base = this.mgr.fragments.models.list.get(this.mgr.modelId);
      if (base?.setVisible) await base.setVisible(reHideIds, false);
    }
  }
}
