import type { BimDocument } from "../core/document";
import type { ContractId, AnyContract } from "../core/contracts";
import type { ElementRegistry, ElementTypeDefinition } from "../core/registry";
import type { MaterialContract } from "../elements/material";

/** Map from type kind → selected type ID. */
export type TypeSelectionState = Map<string, ContractId | null>;

/**
 * Types tab — lists all type contracts, grouped by element kind.
 * Fully data-driven: renders from registry metadata, no hardcoded element kinds.
 */
export class TypesTab {
  private doc: BimDocument;
  private registry: ElementRegistry;
  private selection: TypeSelectionState = new Map();
  private expandedTypeId: ContractId | null = null;
  private container: HTMLElement | null = null;
  onSelectionChanged: ((sel: TypeSelectionState) => void) | null = null;
  /** Called before any type property change to clear element selection. */
  onBeforeTypeEdit: (() => void) | null = null;

  constructor(doc: BimDocument, registry: ElementRegistry) {
    this.doc = doc;
    this.registry = registry;
  }

  getSelection(): TypeSelectionState {
    return this.selection;
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
    for (const def of this.registry.getTypeKinds()) {
      this.renderGroup(def);
    }
  }

  private renderGroup(def: ElementTypeDefinition) {
    const types = this.getTypesOfKind(def.kind);
    const group = document.createElement("div");
    group.className = "type-group";

    const header = document.createElement("div");
    header.className = "type-group-header";
    const headerLabel = document.createElement("span");
    headerLabel.textContent = def.typeGroupLabel ?? def.kind;
    header.appendChild(headerLabel);

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ New";
    addBtn.addEventListener("click", () => this.createType(def));
    header.appendChild(addBtn);
    group.appendChild(header);

    for (const type of types) {
      group.appendChild(this.renderTypeItem(type, def));
    }

    if (types.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size: 12px; color: #666; padding: 4px 8px;";
      empty.textContent = "No types yet";
      group.appendChild(empty);
    }

    this.container!.appendChild(group);
  }

  private renderTypeItem(type: AnyContract, def: ElementTypeDefinition): HTMLElement {
    const isExpanded = type.id === this.expandedTypeId;
    const item = document.createElement("div");
    item.className = `type-item${isExpanded ? " selected" : ""}`;

    const name = document.createElement("div");
    name.className = "type-item-name";
    name.textContent = (type as any).name ?? type.id.slice(0, 8);
    item.appendChild(name);

    if (!isExpanded) {
      const params = document.createElement("div");
      params.className = "type-item-params";
      params.textContent = this.getParamSummary(type, def);
      item.appendChild(params);
    }

    item.addEventListener("click", () => {
      this.selection.set(def.kind, type.id);
      this.expandedTypeId = isExpanded ? null : type.id;
      this.rebuild();
      this.onSelectionChanged?.(this.selection);
    });

    if (isExpanded) {
      item.appendChild(this.renderEditFields(type, def));
    }

    return item;
  }

  private renderEditFields(type: AnyContract, def: ElementTypeDefinition): HTMLElement {
    const container = document.createElement("div");
    container.className = "type-edit-fields";

    // Clear element selection before any type edit to avoid
    // cascade interactions with the extract/restore state.
    let cleared = false;
    const ensureCleared = () => {
      if (cleared) return;
      cleared = true;
      this.onBeforeTypeEdit?.();
    };

    // Editable name
    this.addTextField(container, "Name", (type as any).name ?? "", (v) => {
      ensureCleared();
      this.doc.update(type.id, { name: v });
    });

    // Params from metadata (skip instance-only params — those only appear on instance properties)
    for (const param of def.typeParams ?? []) {
      if (param.category === "instance-only") continue;
      if (param.inputType === "number") {
        this.addField(container, param.label, (type as any)[param.key] ?? param.fallback,
          param.step ?? 0.1, (v) => {
            ensureCleared();
            this.doc.update(type.id, { [param.key]: v });
          });
      }
    }

    // Material slot dropdowns (from the type definition's materialSlots)
    const slots = def.materialSlots ?? [];
    if (slots.length > 0) {
      const matHeader = document.createElement("div");
      matHeader.style.cssText = "font-size: 11px; color: #888; margin-top: 6px; margin-bottom: 2px;";
      matHeader.textContent = "Materials";
      container.appendChild(matHeader);

      const typeMats: Record<string, ContractId> = (type as any).materials ?? {};
      for (const slot of slots) {
        this.addMaterialSelect(container, slot, typeMats[slot] ?? null, (matId) => {
          ensureCleared();
          const updated = { ...(this.doc.contracts.get(type.id) as any).materials ?? {} };
          if (matId) {
            updated[slot] = matId;
          } else {
            delete updated[slot];
          }
          this.doc.update(type.id, { materials: updated });
          this.rebuild();
        });
      }
    }

    // Actions: Duplicate + Delete
    const actions = document.createElement("div");
    actions.className = "type-actions";

    const dupBtn = document.createElement("button");
    dupBtn.textContent = "Duplicate";
    dupBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.duplicateType(type, def);
    });
    actions.appendChild(dupBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deleteType(type.id, def);
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

  private addField(container: HTMLElement, label: string, value: number, step: number, onChange: (v: number) => void) {
    const row = document.createElement("label");
    row.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(value);
    input.step = String(step);
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (!isNaN(v) && v > 0) onChange(v);
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(input);
    container.appendChild(row);
  }

  private addMaterialSelect(container: HTMLElement, slot: string, currentId: ContractId | null, onChange: (matId: ContractId | null) => void) {
    const row = document.createElement("label");
    row.textContent = slot.charAt(0).toUpperCase() + slot.slice(1);
    const select = document.createElement("select");
    select.style.cssText = "width: 120px;";

    // Default option
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "(Default)";
    if (!currentId) defaultOpt.selected = true;
    select.appendChild(defaultOpt);

    // All material contracts
    for (const [, c] of this.doc.contracts) {
      if (c.kind !== "material") continue;
      const mat = c as MaterialContract;
      const opt = document.createElement("option");
      opt.value = mat.id;
      opt.textContent = mat.name;
      if (mat.id === currentId) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener("change", () => {
      onChange(select.value || null);
    });
    select.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(select);
    container.appendChild(row);
  }

  private createType(def: ElementTypeDefinition) {
    if (!def.createDefault) return;
    this.onBeforeTypeEdit?.();
    const type = def.createDefault();
    this.doc.add(type);
    this.selection.set(def.kind, type.id);
    this.expandedTypeId = type.id;
    this.rebuild();
    this.onSelectionChanged?.(this.selection);
  }

  private duplicateType(type: AnyContract, def: ElementTypeDefinition) {
    if (!def.createDefault) return;
    this.onBeforeTypeEdit?.();
    const newType = def.createDefault();
    // Copy all type param values
    for (const param of def.typeParams ?? []) {
      (newType as any)[param.key] = (type as any)[param.key];
    }
    (newType as any).name = ((type as any).name ?? "Type") + " (copy)";
    if ((type as any).materials) {
      (newType as any).materials = { ...(type as any).materials };
    }
    this.doc.add(newType);
    this.selection.set(def.kind, newType.id);
    this.expandedTypeId = newType.id;
    this.rebuild();
    this.onSelectionChanged?.(this.selection);
  }

  private deleteType(id: ContractId, def: ElementTypeDefinition) {
    this.onBeforeTypeEdit?.();
    const instances = this.getInstancesOfType(id);
    if (instances.length > 0) {
      const otherTypes = this.getTypesOfKind(def.kind).filter(t => t.id !== id);
      if (otherTypes.length === 0) {
        alert(`Cannot delete: ${instances.length} element(s) use this type and no other type exists to reassign to.`);
        return;
      }
      // Reassign all instances to the first other type
      const targetId = otherTypes[0].id;
      this.doc.transaction(() => {
        for (const instId of instances) {
          this.doc.update(instId, { typeId: targetId });
        }
        this.doc.remove(id);
      });
    } else {
      this.doc.remove(id);
    }
    if (this.selection.get(def.kind) === id) {
      this.selection.set(def.kind, null);
    }
    this.expandedTypeId = null;
    this.autoSelect();
    this.rebuild();
    this.onSelectionChanged?.(this.selection);
  }

  autoSelect() {
    for (const def of this.registry.getTypeKinds()) {
      if (!this.selection.get(def.kind)) {
        const types = this.getTypesOfKind(def.kind);
        if (types.length > 0) this.selection.set(def.kind, types[0].id);
      }
    }
    this.onSelectionChanged?.(this.selection);
  }

  private getTypesOfKind(kind: string): AnyContract[] {
    const result: AnyContract[] = [];
    for (const [, c] of this.doc.contracts) {
      if (c.kind === kind) result.push(c);
    }
    return result;
  }

  private getInstancesOfType(typeId: ContractId): string[] {
    const ids: string[] = [];
    for (const [, c] of this.doc.contracts) {
      if ((c as any).typeId === typeId) ids.push(c.id);
    }
    return ids;
  }

  private getParamSummary(type: AnyContract, def: ElementTypeDefinition): string {
    return (def.typeParams ?? [])
      .map(p => {
        const v = (type as any)[p.key];
        if (v == null) return null;
        const prefix = p.summaryPrefix ?? p.label;
        const unit = p.summaryUnit ?? "";
        return `${prefix}: ${v}${unit}`;
      })
      .filter(Boolean)
      .join("  ");
  }
}
