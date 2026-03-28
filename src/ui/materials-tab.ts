import type { BimDocument } from "../core/document";
import type { ContractId, AnyContract } from "../core/contracts";
import type { ElementRegistry } from "../core/registry";
import { createMaterial, type MaterialContract } from "../elements/material";

/**
 * Materials tab — CRUD for global material contracts.
 */
export class MaterialsTab {
  private doc: BimDocument;
  private registry: ElementRegistry;
  private container: HTMLElement | null = null;
  private expandedId: ContractId | null = null;
  /** Called before edits so element selection can be cleared. */
  onBeforeEdit: (() => void) | null = null;

  constructor(doc: BimDocument, registry: ElementRegistry) {
    this.doc = doc;
    this.registry = registry;
  }

  render(container: HTMLElement) {
    this.container = container;
    this.rebuild();
  }

  refresh() {
    if (this.container) this.rebuild();
  }

  private rebuild() {
    if (!this.container) return;
    this.container.innerHTML = "";

    const header = document.createElement("div");
    header.className = "type-group-header";
    const label = document.createElement("span");
    label.textContent = "Materials";
    header.appendChild(label);
    const addBtn = document.createElement("button");
    addBtn.textContent = "+ New";
    addBtn.addEventListener("click", () => this.createMaterial());
    header.appendChild(addBtn);
    this.container.appendChild(header);

    const materials = this.getMaterials();
    for (const mat of materials) {
      this.container.appendChild(this.renderItem(mat));
    }

    if (materials.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size: 12px; color: #666; padding: 4px 8px;";
      empty.textContent = "No materials yet";
      this.container.appendChild(empty);
    }
  }

  private renderItem(mat: MaterialContract): HTMLElement {
    const isExpanded = mat.id === this.expandedId;
    const item = document.createElement("div");
    item.className = `type-item${isExpanded ? " selected" : ""}`;

    const row = document.createElement("div");
    row.style.cssText = "display: flex; align-items: center; gap: 8px;";

    // Color swatch
    const swatch = document.createElement("div");
    const [r, g, b] = mat.color;
    swatch.style.cssText = `width: 16px; height: 16px; border-radius: 3px; border: 1px solid #888; background: rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)});`;
    row.appendChild(swatch);

    const name = document.createElement("div");
    name.className = "type-item-name";
    name.textContent = mat.name;
    row.appendChild(name);

    if (!isExpanded) {
      const info = document.createElement("div");
      info.className = "type-item-params";
      info.textContent = `α=${mat.opacity}`;
      row.appendChild(info);
    }

    item.appendChild(row);

    item.addEventListener("click", () => {
      this.expandedId = isExpanded ? null : mat.id;
      this.rebuild();
    });

    if (isExpanded) {
      item.appendChild(this.renderEditFields(mat));
    }

    return item;
  }

  private renderEditFields(mat: MaterialContract): HTMLElement {
    const container = document.createElement("div");
    container.className = "type-edit-fields";

    let cleared = false;
    const ensureCleared = () => {
      if (cleared) return;
      cleared = true;
      this.onBeforeEdit?.();
    };

    // Name
    this.addTextField(container, "Name", mat.name, (v) => {
      ensureCleared();
      this.doc.update(mat.id, { name: v });
      this.rebuild();
    });

    // Color picker
    const colorRow = document.createElement("label");
    colorRow.textContent = "Color";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = rgbToHex(mat.color);
    // Apply only on final pick (focus out / picker close) to avoid
    // cascading fragment writes for every drag step.
    colorInput.addEventListener("change", () => {
      ensureCleared();
      this.doc.update(mat.id, { color: hexToRgb(colorInput.value) });
      this.rebuild();
    });
    colorInput.addEventListener("click", (e) => e.stopPropagation());
    colorRow.appendChild(colorInput);
    container.appendChild(colorRow);

    // Opacity
    this.addNumberField(container, "Opacity", mat.opacity, 0.1, 0, 1, (v) => {
      ensureCleared();
      this.doc.update(mat.id, { opacity: v });
    });

    // Double-sided
    const dsRow = document.createElement("label");
    dsRow.textContent = "Double Sided";
    const dsInput = document.createElement("input");
    dsInput.type = "checkbox";
    dsInput.checked = mat.doubleSided;
    dsInput.addEventListener("change", () => {
      ensureCleared();
      this.doc.update(mat.id, { doubleSided: dsInput.checked });
    });
    dsInput.addEventListener("click", (e) => e.stopPropagation());
    dsRow.appendChild(dsInput);
    container.appendChild(dsRow);

    // Stroke
    this.addNumberField(container, "Stroke", mat.stroke, 1, 0, 10, (v) => {
      ensureCleared();
      this.doc.update(mat.id, { stroke: v });
    });

    // Actions
    const actions = document.createElement("div");
    actions.className = "type-actions";

    const dupBtn = document.createElement("button");
    dupBtn.textContent = "Duplicate";
    dupBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.duplicateMaterial(mat);
    });
    actions.appendChild(dupBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deleteMaterial(mat.id);
    });
    actions.appendChild(deleteBtn);
    container.appendChild(actions);

    return container;
  }

  private addTextField(container: HTMLElement, label: string, value: string, onChange: (v: string) => void) {
    const row = document.createElement("label");
    row.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.style.cssText = "width: 120px;";
    input.addEventListener("change", () => {
      if (input.value.trim()) onChange(input.value.trim());
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(input);
    container.appendChild(row);
  }

  private addNumberField(container: HTMLElement, label: string, value: number, step: number, min: number, max: number, onChange: (v: number) => void) {
    const row = document.createElement("label");
    row.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(value);
    input.step = String(step);
    input.min = String(min);
    input.max = String(max);
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (!isNaN(v) && v >= min && v <= max) onChange(v);
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(input);
    container.appendChild(row);
  }

  private createMaterial() {
    this.onBeforeEdit?.();
    const mat = createMaterial();
    this.doc.add(mat);
    this.expandedId = mat.id;
    this.rebuild();
  }

  private duplicateMaterial(mat: MaterialContract) {
    this.onBeforeEdit?.();
    const newMat = createMaterial({
      name: mat.name + " (copy)",
      color: [...mat.color] as [number, number, number],
      opacity: mat.opacity,
      doubleSided: mat.doubleSided,
      stroke: mat.stroke,
    });
    this.doc.add(newMat);
    this.expandedId = newMat.id;
    this.rebuild();
  }

  private deleteMaterial(id: ContractId) {
    this.onBeforeEdit?.();
    // Null out material references on types that use this material
    for (const [, c] of this.doc.contracts) {
      const materials = (c as any).materials as Record<string, ContractId> | undefined;
      if (!materials) continue;
      const patch: Record<string, unknown> = {};
      let changed = false;
      const updated = { ...materials };
      for (const [slot, matId] of Object.entries(materials)) {
        if (matId === id) {
          delete updated[slot];
          changed = true;
        }
      }
      if (changed) {
        patch.materials = updated;
        this.doc.update(c.id, patch);
      }
    }
    this.doc.remove(id);
    if (this.expandedId === id) this.expandedId = null;
    this.rebuild();
  }

  private getMaterials(): MaterialContract[] {
    const result: MaterialContract[] = [];
    for (const [, c] of this.doc.contracts) {
      if (c.kind === "material") result.push(c as MaterialContract);
    }
    return result;
  }
}

function rgbToHex(color: [number, number, number]): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(color[0])}${toHex(color[1])}${toHex(color[2])}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}
