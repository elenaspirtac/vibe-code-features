import * as THREE from "three";
import {
  EditRequestType,
  GeomsFbUtils,
  type EditRequest,
} from "@thatopen/fragments";

/** Fragment IDs for a single sample (sub-geometry). */
export interface SampleIds {
  sampleId: number;
  reprId: number;
  ltId: number;
  matId: number;
}

/** All fragment sub-entity localIds for a single element. */
export interface FragmentElementIds {
  itemId: number;
  gtId: number;
  samples: SampleIds[];
}

/** Shared resource IDs owned by a type (repr + lt + mat per geoHash). */
export interface SharedReprIds {
  reprId: number;
  ltId: number;
  matId: number;
}

/** Internal tracking of tempIds for a single sample. */
interface SampleTempIds {
  sampleTempId: string;
  reprRef: string; // tempId or stringified localId
  ltRef: string;
  matRef: string;
}

/** Internal tracking of tempIds for a full element. */
interface ElementTempIds {
  itemTempId: string;
  gtTempId: string;
  samples: SampleTempIds[];
}

/** Input for each sub-geometry part when creating an instanced element. */
export interface InstancedPart {
  geometry: THREE.BufferGeometry;
  geoHash: string;
  material: THREE.MeshLambertMaterial;
  /** If set, reuse these existing IDs instead of creating new repr/lt/mat. */
  existingIds?: SharedReprIds;
}

/**
 * Builds raw EditRequest arrays from THREE.js objects,
 * so creates and updates can be batched into a single editor.edit() call.
 */
export class FragmentWriter {
  private requests: EditRequest[] = [];
  private nextTempId = 0;
  /** Per-batch cache: geoHash → shared tempIds for repr, lt, mat. */
  private reprCache = new Map<string, { reprTempId: string; ltTempId: string; matTempId: string }>();
  /** Maps itemTempId → element temp IDs (item + gt + N samples). */
  private elementTempIds = new Map<string, ElementTempIds>();

  private tempId(): string {
    return (this.nextTempId++).toString();
  }

  /**
   * Build CREATE requests for a unique (non-instanced) element.
   * Creates item + gt + lt + repr + mat + sample (all unique).
   */
  buildCreate(
    geometry: THREE.BufferGeometry,
    material: THREE.MeshLambertMaterial,
    transform: THREE.Matrix4,
    attributes: Record<string, { value: string }>,
    category: string
  ): string {
    const itemTempId = this.tempId();
    const gtTempId = this.tempId();
    const ltTempId = this.tempId();
    const reprTempId = this.tempId();
    const matTempId = this.tempId();
    const sampleTempId = this.tempId();

    this.elementTempIds.set(itemTempId, {
      itemTempId, gtTempId,
      samples: [{ sampleTempId, reprRef: reprTempId, ltRef: ltTempId, matRef: matTempId }],
    });

    this.requests.push({
      type: EditRequestType.CREATE_ITEM,
      tempId: itemTempId,
      data: { data: attributes, category },
    } as EditRequest);

    const gtData = GeomsFbUtils.transformFromMatrix(transform);
    this.requests.push({
      type: EditRequestType.CREATE_GLOBAL_TRANSFORM,
      tempId: gtTempId,
      data: { ...gtData, itemId: itemTempId },
    } as EditRequest);

    this.requests.push({
      type: EditRequestType.CREATE_LOCAL_TRANSFORM,
      tempId: ltTempId,
      data: GeomsFbUtils.transformFromMatrix(new THREE.Matrix4()),
    } as EditRequest);

    this.requests.push({
      type: EditRequestType.CREATE_REPRESENTATION,
      tempId: reprTempId,
      data: GeomsFbUtils.representationFromGeometry(geometry),
    } as EditRequest);

    this.requests.push({
      type: EditRequestType.CREATE_MATERIAL,
      tempId: matTempId,
      data: {
        r: material.color.r * 255,
        g: material.color.g * 255,
        b: material.color.b * 255,
        a: material.opacity * 255,
        renderedFaces: material.side === THREE.DoubleSide ? 1 : 0,
        stroke: 0,
      },
    } as EditRequest);

    this.requests.push({
      type: EditRequestType.CREATE_SAMPLE,
      tempId: sampleTempId,
      data: {
        item: gtTempId,
        localTransform: ltTempId,
        representation: reprTempId,
        material: matTempId,
      },
    } as EditRequest);

    return itemTempId;
  }

  /**
   * Build CREATE requests for an instanced element with N sub-geometry parts.
   * Creates 1 item + 1 GT (unique per instance) + N samples.
   * For each part: reuses existing repr/lt/mat if provided, otherwise creates new
   * ones (with within-batch dedup via geoHash).
   */
  buildCreateInstanced(
    worldTransform: THREE.Matrix4,
    parts: InstancedPart[],
    attributes: Record<string, { value: string }>,
    category: string
  ): string {
    const itemTempId = this.tempId();
    const gtTempId = this.tempId();

    // 1. CREATE_ITEM (unique per instance)
    this.requests.push({
      type: EditRequestType.CREATE_ITEM,
      tempId: itemTempId,
      data: { data: attributes, category },
    } as EditRequest);

    // 2. CREATE_GLOBAL_TRANSFORM (unique per instance)
    const gtData = GeomsFbUtils.transformFromMatrix(worldTransform);
    this.requests.push({
      type: EditRequestType.CREATE_GLOBAL_TRANSFORM,
      tempId: gtTempId,
      data: { ...gtData, itemId: itemTempId },
    } as EditRequest);

    // 3. For each part, resolve or create repr/lt/mat, then create sample
    const sampleTempIds: SampleTempIds[] = [];

    for (const part of parts) {
      const sampleTempId = this.tempId();
      let reprRef: string | number;
      let ltRef: string | number;
      let matRef: string | number;

      if (part.existingIds) {
        // Reuse already-resolved localIds from typeReprIds
        reprRef = part.existingIds.reprId;
        ltRef = part.existingIds.ltId;
        matRef = part.existingIds.matId;
      } else {
        // Check batch cache
        const cached = this.reprCache.get(part.geoHash);
        if (cached) {
          reprRef = cached.reprTempId;
          ltRef = cached.ltTempId;
          matRef = cached.matTempId;
        } else {
          // Create new repr/lt/mat
          const ltTempId = this.tempId();
          const reprTempId = this.tempId();
          const matTempId = this.tempId();

          this.requests.push({
            type: EditRequestType.CREATE_LOCAL_TRANSFORM,
            tempId: ltTempId,
            data: GeomsFbUtils.transformFromMatrix(new THREE.Matrix4()),
          } as EditRequest);

          this.requests.push({
            type: EditRequestType.CREATE_REPRESENTATION,
            tempId: reprTempId,
            data: GeomsFbUtils.representationFromGeometry(part.geometry),
          } as EditRequest);

          this.requests.push({
            type: EditRequestType.CREATE_MATERIAL,
            tempId: matTempId,
            data: {
              r: part.material.color.r * 255,
              g: part.material.color.g * 255,
              b: part.material.color.b * 255,
              a: part.material.opacity * 255,
              renderedFaces: part.material.side === THREE.DoubleSide ? 1 : 0,
              stroke: 0,
            },
          } as EditRequest);

          this.reprCache.set(part.geoHash, { reprTempId, ltTempId, matTempId });
          reprRef = reprTempId;
          ltRef = ltTempId;
          matRef = matTempId;
        }
      }

      // CREATE_SAMPLE referencing shared repr/lt/mat + unique GT
      this.requests.push({
        type: EditRequestType.CREATE_SAMPLE,
        tempId: sampleTempId,
        data: {
          item: gtTempId,
          localTransform: ltRef,
          representation: reprRef,
          material: matRef,
        },
      } as EditRequest);

      sampleTempIds.push({
        sampleTempId,
        reprRef: String(reprRef),
        ltRef: String(ltRef),
        matRef: String(matRef),
      });
    }

    this.elementTempIds.set(itemTempId, { itemTempId, gtTempId, samples: sampleTempIds });
    return itemTempId;
  }

  /** Get all accumulated requests and reset internal state. */
  flush(): EditRequest[] {
    const result = this.requests;
    this.requests = [];
    this.nextTempId = 0;
    this.reprCache.clear();
    return result;
  }

  /**
   * After editor.edit() returns, resolve all sub-entity localIds for a given itemTempId.
   * editor.edit() mutates the request objects in-place, setting localId on each.
   */
  resolveAllIds(
    itemTempId: string,
    requests: EditRequest[]
  ): FragmentElementIds {
    const elem = this.elementTempIds.get(itemTempId);
    if (!elem) throw new Error(`No element temp IDs found for itemTempId ${itemTempId}`);

    // Build tempId → resolved localId lookup from all requests
    const resolved = new Map<string, number>();
    for (const req of requests) {
      const r = req as any;
      if (r.tempId !== undefined && r.localId !== undefined) {
        resolved.set(r.tempId, r.localId);
      }
    }

    const get = (ref: string, label: string): number => {
      // Check if it's an already-resolved localId (stringified number from typeReprIds)
      const fromRequests = resolved.get(ref);
      if (fromRequests !== undefined) return fromRequests;
      const asNum = Number(ref);
      if (!Number.isNaN(asNum)) return asNum;
      throw new Error(`Could not resolve ${label} localId for ref ${ref}`);
    };

    const samples: SampleIds[] = elem.samples.map(s => ({
      sampleId: get(s.sampleTempId, "sample"),
      reprId: get(s.reprRef, "representation"),
      ltId: get(s.ltRef, "localTransform"),
      matId: get(s.matRef, "material"),
    }));

    return {
      itemId: get(elem.itemTempId, "item"),
      gtId: get(elem.gtTempId, "globalTransform"),
      samples,
    };
  }

  /** Clear tempId tracking. Call after resolveAllIds is done for all elements. */
  clearTempIds() {
    this.elementTempIds.clear();
  }
}
