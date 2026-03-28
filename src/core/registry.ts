import * as THREE from "three";
import type { GeometryEngine } from "@thatopen/fragments";
import type { AnyContract, ContractId } from "./contracts";
import type { BimDocument } from "./document";
import type { ToolManager } from "../tools/tool-manager";
import {
  collectGenericCuts,
  applyBooleanOperands,
  type BooleanOperand,
} from "../utils/boolean-cuts";

// ── Relationship behavior (S.5 — declarative relationship schema) ──

/**
 * Declares how a relationship type behaves across the five cascade systems.
 *
 * Instead of sync.ts hardcoding `if (rel.type === "hosts") { ... }`,
 * each relationship type registers its behavior here. Adding a new
 * relationship type means one call to `registry.registerRelationshipType()`
 * — no changes to sync.ts needed.
 */
export interface RelationshipBehavior {
  /**
   * Extract cascade: what to do when the source element is selected.
   * - "recurse" → extract target AND recurse into its relationships
   * - "include" → extract target but don't recurse further
   * - "skip"    → don't extract target
   */
  onExtract: "recurse" | "include" | "skip";

  /**
   * Restore cascade: what to do when the source element is deselected.
   * - "recurse" → restore target AND recurse into its relationships
   * - "include" → restore target (+ its hosted children) but don't recurse further
   * - "skip"    → don't restore target
   */
  onRestore: "recurse" | "include" | "skip";

  /**
   * Delete cascade: when the source element is deleted, delete the target?
   * - "cascade" → delete target too (e.g., delete wall → delete hosted windows)
   * - "skip"    → leave target alive (e.g., disconnect peer, don't delete)
   */
  onDelete: "cascade" | "skip";

  /**
   * Change cascade: when the source element's geometry changes, refresh target?
   * - "refresh" → regenerate target's overlay + schedule fragment write
   * - "skip"    → ignore (target doesn't depend on source's geometry)
   */
  onChange: "refresh" | "skip";
}

// ── Built-in relationship types ─────────────────────────────────────

/**
 * Default behaviors for the three built-in relationship types.
 * These encode the knowledge that was previously hardcoded in sync.ts.
 */
export const BUILTIN_RELATIONSHIP_BEHAVIORS: Record<string, RelationshipBehavior> = {
  /**
   * "hosts" — parent owns child (wall → window).
   * Select wall → extract window (recurse into window's rels).
   * Deselect wall → restore window (recurse).
   * Delete wall → delete window.
   * Wall geometry changes → refresh window geometry.
   */
  hosts: {
    onExtract: "recurse",
    onRestore: "recurse",
    onDelete: "cascade",
    onChange: "refresh",
  },

  /**
   * "hostedBy" — child lives on parent (window → wall).
   * Select window → extract host wall (recurse into wall's rels).
   * Deselect window → restore host wall (recurse).
   * Delete window → DON'T delete wall.
   * Window changes → refresh wall (e.g., boolean cut update).
   */
  hostedBy: {
    onExtract: "recurse",
    onRestore: "recurse",
    onDelete: "skip",
    onChange: "refresh",
  },

  /**
   * "connectedTo" — peer link (wall ↔ miter neighbor, floor → wall).
   * Select wall → extract neighbor (don't recurse into neighbor's hosts).
   * Deselect wall → restore neighbor (+ its hosted children, no further recursion).
   * Delete wall → DON'T delete neighbor.
   * Wall geometry changes → refresh neighbor (miter joint update).
   */
  connectedTo: {
    onExtract: "include",
    onRestore: "include",
    onDelete: "skip",
    onChange: "refresh",
  },

  /**
   * "cuts" — ad-hoc boolean cut (column → slab, beam → wall, etc.).
   * Select cutter → DON'T extract the cut target.
   * Deselect cutter → DON'T restore target.
   * Delete cutter → DON'T delete target (target regenerates without the void).
   * Cutter changes → refresh target (void moves/resizes).
   */
  cuts: {
    onExtract: "skip",
    onRestore: "skip",
    onDelete: "skip",
    onChange: "refresh",
  },

  /**
   * "instanceOf" — instance references its type (window → windowType).
   * Select instance → DON'T extract the type.
   * Deselect instance → DON'T restore the type.
   * Delete instance → DON'T delete the type.
   * Instance changes → DON'T refresh the type.
   *
   * The reverse direction (type → instances) is handled by the
   * dependentsOf index: type change cascades to all instances via onUpdated.
   */
  instanceOf: {
    onExtract: "skip",
    onRestore: "skip",
    onDelete: "skip",
    onChange: "skip",
  },

  /**
   * "usesMaterial" — type references a material contract.
   * All skip except onChange: refresh — material edit cascades to type,
   * then type cascades to instances via dependentsOf.
   */
  usesMaterial: {
    onExtract: "skip",
    onRestore: "skip",
    onDelete: "skip",
    onChange: "refresh",
  },

  /**
   * "belongsToLevel" — element's base is on this level (wall → level).
   * All skip. Level elevation cascade is handled explicitly by LevelsTab
   * (not through cascadeOnChange) to avoid re-entrant doc.update storms.
   */
  belongsToLevel: {
    onExtract: "skip",
    onRestore: "skip",
    onDelete: "skip",
    onChange: "skip",
  },

  /**
   * "constrainedToLevel" — element's top is constrained to a level.
   * All skip. Same as belongsToLevel — cascade handled by LevelsTab.
   */
  constrainedToLevel: {
    onExtract: "skip",
    onRestore: "skip",
    onDelete: "skip",
    onChange: "skip",
  },
};

// ── Relationship types ─────────────────────────────────────────────

export interface ElementRelationship {
  /**
   * Relationship type name. Built-in: "hosts", "hostedBy", "connectedTo".
   * New types can be registered via `registry.registerRelationshipType()`.
   */
  type: string;
  targetId: ContractId;
}

// ── Handles interface ──────────────────────────────────────────────

export interface ElementHandles {
  contract: AnyContract;
  activeTarget: string | null;

  checkHit(
    event: PointerEvent,
    toolMgr: ToolManager,
    camera: THREE.PerspectiveCamera
  ): boolean;
  onDrag(groundPoint: THREE.Vector3, event: PointerEvent): void;
  onDragEnd(): void;
  updateFromContract(contract: AnyContract): void;
  dispose(): void;

  /** Optional: endpoint coordinate before drag started (for shared-corner detection). */
  getPreDragEndpoint?(): [number, number, number] | null;

  /** Optional: additional IDs to exclude from snapping (e.g. other selected walls). */
  snapExcludeIds?: ContractId[];
}

// ── Element type definition ────────────────────────────────────────

/**
 * A migration function that transforms a contract from version N to N+1.
 * Receives the raw serialized contract (may have missing/extra fields)
 * and returns the migrated contract.
 */
export type ContractMigration = (contract: Record<string, unknown>) => Record<string, unknown>;

/**
 * Describes a single parameter on a type contract for generic UI rendering.
 */
export interface TypeParamDescriptor {
  /** Contract key (e.g. "height", "thickness"). */
  key: string;
  /** Display label in UI. */
  label: string;
  /** "type-only": always from type, read-only on instance.
   *  "defaultable": type provides default, instance can override.
   *  "instance-only": only on instance, not shown on type. */
  category: "type-only" | "defaultable" | "instance-only";
  /** Input type for rendering. */
  inputType: "number" | "text";
  /** For number inputs. */
  step?: number;
  min?: number;
  max?: number;
  /** Fallback value when type contract is missing. */
  fallback: number | string;
  /** Short prefix for summary display (e.g. "H" for height). */
  summaryPrefix?: string;
  /** Unit suffix for summary (e.g. "m"). */
  summaryUnit?: string;
}

/**
 * Helper functions passed to renderCustomProperties for instance-only fields.
 */
export interface PropertyFieldHelpers {
  addField(container: HTMLElement, label: string, value: number, step: number, min: number, max: number, onChange: (v: number) => void): void;
  addReadOnlyField(container: HTMLElement, label: string, value: number, hint?: string): void;
  addSelectField(container: HTMLElement, label: string, value: string | null, options: { id: string; label: string }[], onChange: (v: string | null) => void): void;
  debouncedUpdate(id: string, patch: Record<string, unknown>): void;
  doc: BimDocument;
}

export interface ElementTypeDefinition {
  kind: string;

  /**
   * When true, this element kind has no geometry and no fragment representation.
   * Used for type contracts (e.g. wallType, windowType) that hold shared
   * parameters but don't appear in the 3D scene. The sync layer skips
   * overlay creation and fragment writes for data-only elements.
   */
  dataOnly?: boolean;

  /**
   * Keys that are metadata (don't affect geometry or cascading).
   * When a data-only type is updated and ALL changed keys are in this
   * list, the cascade to instances is skipped (e.g. renaming a type).
   */
  metadataKeys?: string[];

  // ── Type system metadata ────────────────────────────────────────

  /** For type kinds: the instance kind this type serves (e.g. wallType → "wall"). */
  instanceKind?: string;

  /** For instance kinds: the type kind (e.g. wall → "wallType"). */
  typeKind?: string;

  /** Param descriptors for type contracts. Drives TypesTab and PropertiesPanel generically. */
  typeParams?: TypeParamDescriptor[];

  /** Factory: create a new type contract with default values. */
  createDefault?: () => AnyContract;

  /** Display name for the type group in TypesTab (e.g. "Wall Types"). */
  typeGroupLabel?: string;

  /** Named sub-geometry slots for material assignment (e.g. ["frame", "glass"]). */
  materialSlots?: string[];

  /** Render instance-only fields in the properties panel (optional).
   *  Called after generic type params are rendered. */
  renderCustomProperties?: (
    contract: AnyContract,
    container: HTMLElement,
    helpers: PropertyFieldHelpers
  ) => void;

  // ── Geometry instancing ──────────────────────────────────────────

  /** Return local-space sub-geometries + shared world transform for instancing.
   *  Each part has a geoHash for deduplication — parts with the same hash
   *  share a single fragment representation across all instances.
   *  Return null to fall back to world-space generateGeometry (unique elements). */
  generateLocalGeometry?(
    engine: GeometryEngine,
    contract: AnyContract,
    doc: BimDocument
  ): {
    worldTransform: THREE.Matrix4;
    parts: Array<{
      geometry: THREE.BufferGeometry;
      geoHash: string;
      material?: THREE.MeshLambertMaterial;
    }>;
  } | null;

  /**
   * Current schema version for this element kind (default: 1).
   * Increment when the contract shape changes, and add a migration
   * for the previous version.
   */
  version?: number;

  /**
   * Migration functions keyed by source version.
   * `migrations[1]` migrates from v1 → v2, `migrations[2]` from v2 → v3, etc.
   * Migrations run in sequence on load: v1 → v2 → v3 → ... → current.
   */
  migrations?: Record<number, ContractMigration>;

  /** Pure geometry generator. `skipBooleans` skips expensive cuts during drag. */
  generateGeometry(
    engine: GeometryEngine,
    contract: AnyContract,
    doc: BimDocument,
    options?: { skipBooleans?: boolean }
  ): THREE.BufferGeometry;

  /** Return all relationships for this element in the current model state. */
  getRelationships(
    contract: AnyContract,
    doc: BimDocument
  ): ElementRelationship[];

  /** Cleanup when this element is removed (e.g., remove window from host's list). */
  onRemove?(contract: AnyContract, doc: BimDocument): void;

  /** Create interactive handles for editing this element (optional). */
  createHandles?(
    scene: THREE.Scene,
    doc: BimDocument,
    engine: GeometryEngine,
    contract: AnyContract,
    camera: THREE.PerspectiveCamera,
    container: HTMLElement
  ): ElementHandles | null;

  /**
   * Return snap target points for this element (optional, 3.4b).
   * Used by the snap system for generic element snapping.
   */
  getSnapPoints?(
    contract: AnyContract,
    doc?: BimDocument
  ): { position: THREE.Vector3; type: "endpoint" | "midpoint" | "center" }[];

  /**
   * Return boolean operands specific to this element type (optional).
   * E.g., wall returns miter cut boxes + T-junction cut boxes + window voids.
   * Generic ad-hoc cuts from "cuts" relationships are collected automatically
   * by the registry — don't include them here.
   */
  getBooleanOperands?(
    engine: GeometryEngine,
    contract: AnyContract,
    doc: BimDocument
  ): BooleanOperand[];

  /**
   * Return the void mesh this element subtracts when it cuts another element
   * via a "cuts" relationship (optional).
   * E.g., a column returns its full extrusion; a window returns its void box.
   */
  getVoidGeometry?(
    engine: GeometryEngine,
    contract: AnyContract,
    doc: BimDocument
  ): THREE.Mesh | null;

  // ── Extensibility hooks ───────────────────────────────────────

  /**
   * Return linear edges for this element (optional).
   * Used by snap, spatial-index, joints, temp-dimensions, and select-tool.
   * A wall returns its centerline; a beam would return its axis.
   */
  getLinearEdges?(
    contract: AnyContract,
    doc: BimDocument
  ): LinearEdge[];

  /**
   * Return axis-aligned bounding box for spatial indexing (optional).
   * If not provided, computed from getLinearEdges or getSnapPoints.
   */
  getSpatialBounds?(
    contract: AnyContract,
    doc: BimDocument
  ): { min: [number, number, number]; max: [number, number, number] } | null;

  /**
   * Return the position of a named endpoint (optional).
   * Used by floor boundary resolution to locate referenced endpoints
   * on any element type (not just walls).
   */
  getEndpointPosition?(
    contract: AnyContract,
    endpointId: string,
    doc: BimDocument
  ): [number, number, number] | null;

  /**
   * Apply a translation delta to this element's contract (optional).
   * Returns the updated contract, or null if the element should not be
   * directly moved (e.g. hosted elements that move with their host).
   */
  applyTranslation?(
    contract: AnyContract,
    delta: [number, number, number]
  ): AnyContract | null;

  /**
   * Remap internal ID references for copy/paste (optional, 1.18).
   * Given a contract and an oldId→newId map, return a new contract with
   * all internal references updated. References not in the map should be
   * cleared (e.g. T-junction to a wall outside the copied set) or kept
   * (e.g. typeId, levelId — shared, not cloned).
   */
  remapIds?(
    contract: AnyContract,
    idMap: ReadonlyMap<ContractId, ContractId>
  ): AnyContract;
}

/**
 * A linear edge declared by an element for snap, joints, dimensions.
 */
export interface LinearEdge {
  /** Unique name for this edge's start (e.g., "start"). */
  startId: string;
  /** Unique name for this edge's end (e.g., "end"). */
  endId: string;
  start: [number, number, number];
  end: [number, number, number];
  /** Half-width expansion for spatial bounds (e.g., wall thickness / 2). */
  expansion?: number;
}

// ── Registry ───────────────────────────────────────────────────────

export class ElementRegistry {
  private types = new Map<string, ElementTypeDefinition>();
  private relationshipBehaviors = new Map<string, RelationshipBehavior>();

  constructor() {
    // Register built-in relationship types
    for (const [name, behavior] of Object.entries(BUILTIN_RELATIONSHIP_BEHAVIORS)) {
      this.relationshipBehaviors.set(name, behavior);
    }
  }

  register(def: ElementTypeDefinition) {
    this.types.set(def.kind, def);
  }

  /**
   * Register a new relationship type with its cascade behavior.
   * This is the S.5 extension point: adding a new relationship type
   * requires zero changes to sync.ts.
   */
  registerRelationshipType(name: string, behavior: RelationshipBehavior) {
    this.relationshipBehaviors.set(name, behavior);
  }

  /**
   * Get the cascade behavior for a relationship type.
   * Falls back to a safe default (include on extract/restore, skip delete, refresh on change)
   * for unregistered types — so a typo won't crash the system.
   */
  getRelationshipBehavior(type: string): RelationshipBehavior {
    return this.relationshipBehaviors.get(type) ?? {
      onExtract: "include",
      onRestore: "include",
      onDelete: "skip",
      onChange: "refresh",
    };
  }

  get(kind: string): ElementTypeDefinition | undefined {
    return this.types.get(kind);
  }

  /** Returns true if this element kind is data-only (no geometry, no fragments). */
  isDataOnly(kind: string): boolean {
    return this.types.get(kind)?.dataOnly === true;
  }

  /** True when ALL keys in the patch are metadata (non-geometric). */
  isMetadataOnly(kind: string, patchKeys: string[]): boolean {
    const meta = this.types.get(kind)?.metadataKeys;
    if (!meta || meta.length === 0) return false;
    return patchKeys.every((k) => meta.includes(k));
  }

  /** Get all registered type definitions (dataOnly elements with instanceKind). */
  getTypeKinds(): ElementTypeDefinition[] {
    return [...this.types.values()].filter(d => d.dataOnly && d.instanceKind);
  }

  /** Given an instance kind, get its type kind string. */
  getTypeKindFor(instanceKind: string): string | undefined {
    return this.types.get(instanceKind)?.typeKind;
  }

  generateGeometry(
    engine: GeometryEngine,
    contract: AnyContract,
    doc: BimDocument,
    options?: { skipBooleans?: boolean }
  ): THREE.BufferGeometry {
    const def = this.types.get(contract.kind);
    if (!def) throw new Error(`Unknown element type: ${contract.kind}`);

    // 1. Base geometry (no booleans)
    let geo = def.generateGeometry(engine, contract, doc, options);

    if (options?.skipBooleans) return geo;

    // 2. Element-specific boolean operands (wall: miters, T-junctions, window voids)
    const operands: BooleanOperand[] = [];
    if (def.getBooleanOperands) {
      operands.push(...def.getBooleanOperands(engine, contract, doc));
    }

    // 3. Generic ad-hoc cuts from "cuts" relationships targeting this element
    const genericCuts = collectGenericCuts(engine, contract.id, doc, this);
    operands.push(...genericCuts);

    // 4. Apply all boolean operations
    if (operands.length > 0) {
      geo = applyBooleanOperands(engine, geo, operands);
    }

    return geo;
  }

  getRelationships(
    contract: AnyContract,
    doc: BimDocument
  ): ElementRelationship[] {
    const def = this.types.get(contract.kind);
    if (!def) return [];
    return def.getRelationships(contract, doc);
  }

  /**
   * Resolve delete cascade: given an element being deleted, return IDs
   * that should also be deleted based on relationship behaviors.
   */
  resolveCascadeDelete(
    id: ContractId,
    doc: BimDocument
  ): ContractId[] {
    const contract = doc.contracts.get(id);
    if (!contract) return [];
    const rels = this.getRelationships(contract, doc);
    const toDelete: ContractId[] = [];
    for (const rel of rels) {
      const behavior = this.getRelationshipBehavior(rel.type);
      if (behavior.onDelete === "cascade") {
        toDelete.push(rel.targetId);
      }
    }
    return toDelete;
  }

  // ── Schema migration (S.7) ───────────────────────────────────────

  /**
   * Get the current schema version for an element kind.
   * Returns 1 if the type doesn't declare a version (backward compatible).
   */
  getVersion(kind: string): number {
    return this.types.get(kind)?.version ?? 1;
  }

  /**
   * Migrate a raw serialized contract from `fromVersion` to the current version.
   * Runs migrations in sequence: fromVersion → fromVersion+1 → ... → current.
   * Returns the migrated contract. If no migration is needed, returns the
   * contract unchanged.
   *
   * Throws if a required migration is missing (gap in the chain).
   */
  migrateContract(
    raw: Record<string, unknown>,
    fromVersion: number
  ): Record<string, unknown> {
    const kind = raw.kind as string;
    const def = this.types.get(kind);
    if (!def) return raw; // unknown type — pass through unchanged

    const currentVersion = def.version ?? 1;
    if (fromVersion >= currentVersion) return raw; // already current

    let contract = raw;
    for (let v = fromVersion; v < currentVersion; v++) {
      const migrate = def.migrations?.[v];
      if (!migrate) {
        throw new Error(
          `Missing migration for "${kind}" from v${v} to v${v + 1}. ` +
          `Current version is ${currentVersion}.`
        );
      }
      contract = migrate(contract);
    }
    return contract;
  }

  /**
   * Migrate an array of serialized contracts (as stored in .bim files).
   * Each contract tuple is [id, contractData]. The contractData may have
   * a `_v` field indicating its schema version (defaults to 1 if absent).
   * Returns migrated tuples with `_v` updated to current version.
   */
  migrateAll(
    contracts: [ContractId, Record<string, unknown>][]
  ): [ContractId, Record<string, unknown>][] {
    return contracts.map(([id, raw]) => {
      const fromVersion = (raw._v as number) ?? 1;
      const migrated = this.migrateContract(raw, fromVersion);
      const currentVersion = this.getVersion(migrated.kind as string);
      // Stamp with current version
      migrated._v = currentVersion;
      return [id, migrated];
    });
  }
}
