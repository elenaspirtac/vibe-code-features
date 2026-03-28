import type { BimDocument } from "../core/document";
import type { ContractId } from "../core/contracts";
import { createLevel, isLevel } from "../elements/level";
import type { LevelContract } from "../elements/level";
import type { SnapGroupManager } from "../utils/snap-groups";

/**
 * Levels tab — lists all levels, allows switching active level,
 * creating/editing/deleting levels.
 */
export class LevelsTab {
  private doc: BimDocument;
  private container: HTMLElement | null = null;
  private activeLevelId: ContractId | null = null;

  /** Fires when the user switches levels. */
  onLevelChanged: ((levelId: ContractId | null, elevation: number) => void) | null = null;

  /** Snap group manager — set externally to enable cross-level snap toggles. */
  snapGroupManager: SnapGroupManager | null = null;

  constructor(doc: BimDocument) {
    this.doc = doc;
  }

  /** Get the active level ID. */
  getActiveLevelId(): ContractId | null {
    return this.activeLevelId;
  }

  /** Render into the given container. */
  render(container: HTMLElement) {
    this.container = container;
    this.rebuild();
  }

  refresh() {
    if (this.container) this.rebuild();
  }

  /** Auto-select the first level if none active. */
  autoSelect() {
    if (!this.activeLevelId) {
      const levels = this.getLevels();
      if (levels.length > 0) {
        this.activeLevelId = levels[0].id;
        this.onLevelChanged?.(levels[0].id, levels[0].elevation);
      }
    }
  }

  private rebuild() {
    if (!this.container) return;
    this.container.innerHTML = "";

    const levels = this.getLevels();

    // Header
    const header = document.createElement("div");
    header.className = "type-group-header";
    const label = document.createElement("span");
    label.textContent = "Levels";
    header.appendChild(label);

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ New";
    addBtn.addEventListener("click", () => this.createLevel(levels));
    header.appendChild(addBtn);
    this.container.appendChild(header);

    // Level items
    for (const level of levels) {
      this.container.appendChild(this.renderLevelItem(level));
    }
  }

  private renderLevelItem(level: LevelContract): HTMLElement {
    const isActive = level.id === this.activeLevelId;
    const item = document.createElement("div");
    item.className = `type-item${isActive ? " selected" : ""}`;

    const name = document.createElement("div");
    name.className = "type-item-name";
    name.textContent = level.name;
    item.appendChild(name);

    const params = document.createElement("div");
    params.className = "type-item-params";
    params.textContent = `Elevation: ${level.elevation}m`;
    item.appendChild(params);

    // Snap group toggle for non-active levels
    if (!isActive && this.snapGroupManager) {
      const group = this.snapGroupManager.getGroups().find(g => g.id === level.id);
      const snapRow = document.createElement("div");
      snapRow.style.cssText = "display: flex; align-items: center; gap: 4px; margin-top: 2px; font-size: 11px; color: #888;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = group?.enabled ?? false;
      cb.style.cssText = "margin: 0;";
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        this.snapGroupManager?.setEnabled(level.id, cb.checked);
      });
      const cbLabel = document.createElement("span");
      cbLabel.textContent = "Snap";
      snapRow.appendChild(cb);
      snapRow.appendChild(cbLabel);
      item.appendChild(snapRow);
    }

    // Click to activate
    item.addEventListener("click", () => {
      this.activeLevelId = level.id;
      this.onLevelChanged?.(level.id, level.elevation);
      this.rebuild();
    });

    // Edit fields when active
    if (isActive) {
      const fields = document.createElement("div");
      fields.className = "type-edit-fields";

      // Name
      const nameRow = document.createElement("label");
      nameRow.textContent = "Name";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = level.name;
      nameInput.style.cssText = "width: 120px;";
      nameInput.addEventListener("change", () => {
        if (nameInput.value.trim()) this.doc.update(level.id, { name: nameInput.value.trim() });
      });
      nameInput.addEventListener("click", (e) => e.stopPropagation());
      nameRow.appendChild(nameInput);
      fields.appendChild(nameRow);

      // Elevation
      const elevRow = document.createElement("label");
      elevRow.textContent = "Elevation";
      const elevInput = document.createElement("input");
      elevInput.type = "number";
      elevInput.value = String(level.elevation);
      elevInput.step = "0.1";
      elevInput.addEventListener("change", () => {
        const v = parseFloat(elevInput.value);
        if (!isNaN(v)) {
          const delta = v - level.elevation;
          this.doc.transaction(() => {
            this.doc.update(level.id, { elevation: v });
            if (delta !== 0) this.cascadeLevelElevation(level.id, v, delta);
          });
          this.onLevelChanged?.(level.id, v);
        }
      });
      elevInput.addEventListener("click", (e) => e.stopPropagation());
      elevRow.appendChild(elevInput);
      fields.appendChild(elevRow);

      // Delete button
      const actions = document.createElement("div");
      actions.className = "type-actions";
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "danger";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteLevel(level.id);
      });
      actions.appendChild(deleteBtn);
      fields.appendChild(actions);

      item.appendChild(fields);
    }

    return item;
  }

  private createLevel(existingLevels: LevelContract[]) {
    // Default elevation: highest level + 3m, or 0 if no levels
    const maxElevation = existingLevels.reduce((max, l) => Math.max(max, l.elevation), -Infinity);
    const elevation = existingLevels.length > 0 ? maxElevation + 3 : 0;
    const name = `Level ${existingLevels.length}`;

    const level = createLevel(name, elevation);
    this.doc.add(level);
    this.activeLevelId = level.id;
    this.onLevelChanged?.(level.id, elevation);
    this.rebuild();
  }

  private deleteLevel(id: ContractId) {
    const levels = this.getLevels();
    if (levels.length <= 1) {
      alert("Cannot delete the last level.");
      return;
    }
    this.doc.remove(id);
    if (this.activeLevelId === id) {
      const remaining = this.getLevels();
      if (remaining.length > 0) {
        this.activeLevelId = remaining[0].id;
        this.onLevelChanged?.(remaining[0].id, remaining[0].elevation);
      } else {
        this.activeLevelId = null;
        this.onLevelChanged?.(null, 0);
      }
    }
    this.rebuild();
  }

  /**
   * Shift elements on a level when its elevation changes.
   * Handled here (not in cascadeOnChange) because doc.update inside
   * a cascade hook causes re-entrant event storms with connected elements.
   */
  private cascadeLevelElevation(levelId: ContractId, newElevation: number, delta: number) {
    for (const [, c] of this.doc.contracts) {
      // Base level: shift Y coordinates
      if ((c as any).levelId === levelId) {
        const patch: Record<string, unknown> = {};
        const start = (c as any).start as [number, number, number] | undefined;
        const end = (c as any).end as [number, number, number] | undefined;
        if (start && end) {
          patch.start = [start[0], start[1] + delta, start[2]];
          patch.end = [end[0], end[1] + delta, end[2]];
        }
        const base = (c as any).base as [number, number, number] | undefined;
        if (base) {
          patch.base = [base[0], base[1] + delta, base[2]];
        }
        if (typeof (c as any).elevation === "number") {
          patch.elevation = ((c as any).elevation as number) + delta;
        }
        if (Object.keys(patch).length > 0) {
          this.doc.update(c.id, patch);
        }
      }

      // Top constraint: recalculate height
      if ((c as any).topLevelId === levelId && (c as any).levelId) {
        const baseLevel = this.doc.contracts.get((c as any).levelId) as LevelContract | undefined;
        if (baseLevel && isLevel(baseLevel)) {
          const newHeight = newElevation - baseLevel.elevation;
          if (newHeight > 0) {
            this.doc.update(c.id, { height: newHeight });
          }
        }
      }
    }
  }

  private getLevels(): LevelContract[] {
    const result: LevelContract[] = [];
    for (const [, c] of this.doc.contracts) {
      if (isLevel(c)) result.push(c);
    }
    result.sort((a, b) => a.elevation - b.elevation);
    return result;
  }
}
