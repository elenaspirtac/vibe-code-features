import type { ContractId } from "../core/contracts";
import type { BimDocument } from "../core/document";
import { isLevel, type LevelContract } from "../elements/level";

/**
 * A snap group is a named set of elements at a common elevation.
 * Levels are one source of snap groups; future concepts (Kilometer Points,
 * reference planes) can register their own groups.
 */
export interface SnapGroup {
  /** Unique identifier (e.g., the level's contract ID). */
  id: string;
  /** Display name for UI (e.g., "Level 0"). */
  name: string;
  /** Y elevation of this group's elements in world space. */
  elevation: number;
  /** Element IDs belonging to this group. */
  memberIds: Set<ContractId>;
  /** Whether snap candidates from this group are currently active. */
  enabled: boolean;
}

/**
 * Manages snap groups and provides O(1) lookup for cross-group projection.
 * Level-agnostic — any system can register groups.
 */
export class SnapGroupManager {
  private groups = new Map<string, SnapGroup>();
  /** Reverse map: elementId → groupId for O(1) projection lookup. */
  private reverseMap = new Map<ContractId, string>();
  /** Groups the user has manually toggled — autoEnableAdjacent won't override these. */
  private userTouched = new Set<string>();

  /** Callback when group enabled state changes (for UI refresh). */
  onChanged: (() => void) | null = null;

  /** Register or update a snap group. */
  setGroup(id: string, name: string, elevation: number, memberIds: Set<ContractId>) {
    // Clear old reverse entries for this group
    const existing = this.groups.get(id);
    if (existing) {
      for (const eid of existing.memberIds) {
        if (this.reverseMap.get(eid) === id) this.reverseMap.delete(eid);
      }
    }

    const enabled = existing?.enabled ?? false;
    this.groups.set(id, { id, name, elevation, memberIds, enabled });

    // Rebuild reverse entries
    for (const eid of memberIds) {
      this.reverseMap.set(eid, id);
    }
  }

  /** Remove a snap group entirely. */
  removeGroup(id: string) {
    const group = this.groups.get(id);
    if (!group) return;
    for (const eid of group.memberIds) {
      if (this.reverseMap.get(eid) === id) this.reverseMap.delete(eid);
    }
    this.groups.delete(id);
  }

  /** Enable/disable a group for snapping. Marks it as user-touched. */
  setEnabled(id: string, enabled: boolean) {
    const group = this.groups.get(id);
    if (group) {
      group.enabled = enabled;
      this.userTouched.add(id);
      this.onChanged?.();
    }
  }

  /** Get all groups (for UI rendering). */
  getGroups(): SnapGroup[] {
    return [...this.groups.values()];
  }

  /**
   * For a given candidate element, return the Y delta to project it onto
   * the work plane, or null if the candidate should be skipped.
   *
   * - Returns `null` if the element belongs to a disabled group (skip it).
   * - Returns `0` if no group or same elevation (no projection needed).
   * - Returns the delta otherwise (add to candidate Y to project it).
   */
  getProjectionDelta(elementId: ContractId, workPlaneElevation: number): number | null {
    const groupId = this.reverseMap.get(elementId);
    if (groupId === undefined) return 0; // not in any group — allow, no projection

    const group = this.groups.get(groupId);
    if (!group) return 0;
    if (!group.enabled) return null; // group disabled — skip

    return workPlaneElevation - group.elevation;
  }

  /**
   * Auto-enable the active level and its immediate neighbors (by elevation).
   * Groups the user has manually toggled are left unchanged.
   * The active level is always enabled regardless.
   */
  autoEnableAdjacent(activeLevelId: string) {
    const sorted = [...this.groups.values()].sort((a, b) => a.elevation - b.elevation);
    const activeIdx = sorted.findIndex(g => g.id === activeLevelId);

    for (let i = 0; i < sorted.length; i++) {
      const group = sorted[i];
      if (group.id === activeLevelId) {
        // Active level is always enabled
        group.enabled = true;
      } else if (!this.userTouched.has(group.id)) {
        // Only set defaults for groups the user hasn't manually toggled
        group.enabled = (i === activeIdx - 1 || i === activeIdx + 1);
      }
    }
    this.onChanged?.();
  }

  /** Clear all groups (e.g., on document reload). */
  clear() {
    this.groups.clear();
    this.reverseMap.clear();
    this.userTouched.clear();
  }
}

// ── Level-specific helpers ─────────────────────────────────────────

/**
 * Rebuild snap groups from level contracts in the document.
 * Each level becomes a snap group containing elements with matching `levelId`.
 * Pass `autoEnable = true` on level change or initial load to reset toggles
 * to adjacent levels. Pass `false` on element add/remove to preserve user toggles.
 */
export function syncLevelSnapGroups(
  doc: BimDocument,
  mgr: SnapGroupManager,
  activeLevelId: string | null,
  autoEnable = true
) {
  // Collect levels
  const levels: LevelContract[] = [];
  for (const c of doc.contracts.values()) {
    if (isLevel(c)) levels.push(c);
  }

  // Group elements by levelId
  const levelMembers = new Map<string, Set<ContractId>>();
  for (const level of levels) {
    levelMembers.set(level.id, new Set());
  }
  for (const c of doc.contracts.values()) {
    const lid = (c as any).levelId as string | undefined;
    if (lid && levelMembers.has(lid)) {
      levelMembers.get(lid)!.add(c.id);
    }
  }

  // Register groups
  const currentGroupIds = new Set<string>();
  for (const level of levels) {
    currentGroupIds.add(level.id);
    mgr.setGroup(level.id, level.name, level.elevation, levelMembers.get(level.id)!);
  }

  // Remove stale groups (levels that were deleted)
  for (const group of mgr.getGroups()) {
    if (!currentGroupIds.has(group.id)) {
      mgr.removeGroup(group.id);
    }
  }

  // Auto-enable adjacent only when requested (level change, initial load)
  if (autoEnable && activeLevelId) {
    mgr.autoEnableAdjacent(activeLevelId);
  }
}
