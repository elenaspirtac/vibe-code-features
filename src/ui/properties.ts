import type { BimDocument } from "../core/document";
import type { AnyContract } from "../core/contracts";
import type { ElementRegistry, PropertyFieldHelpers } from "../core/registry";

export class PropertiesPanel {
  private doc: BimDocument;
  private registry: ElementRegistry;
  private container: HTMLElement | null = null;
  private currentContract: AnyContract | null = null;

  private pendingUpdates = new Map<string, { timer: ReturnType<typeof setTimeout>; patch: Record<string, unknown> }>();
  private INPUT_DEBOUNCE_MS = 60;

  constructor(doc: BimDocument, registry: ElementRegistry) {
    this.doc = doc;
    this.registry = registry;
  }

  private debouncedUpdate(id: string, patch: Record<string, unknown>) {
    const existing = this.pendingUpdates.get(id);
    if (existing) {
      clearTimeout(existing.timer);
      Object.assign(existing.patch, patch);
    } else {
      this.pendingUpdates.set(id, { timer: 0 as any, patch: { ...patch } });
    }
    const entry = this.pendingUpdates.get(id)!;
    entry.timer = setTimeout(() => {
      this.pendingUpdates.delete(id);
      this.doc.update(id, entry.patch);
    }, this.INPUT_DEBOUNCE_MS);
  }

  show(contract: AnyContract, container: HTMLElement) {
    this.currentContract = contract;
    this.container = container;
    this.render();
  }

  showEmpty(container: HTMLElement) {
    this.flush();
    this.currentContract = null;
    this.container = container;
    container.innerHTML = '<div style="color: #666; font-size: 13px;">No element selected</div>';
  }

  hide() {
    this.flush();
    this.currentContract = null;
    this.container = null;
  }

  private flush() {
    for (const [id, entry] of this.pendingUpdates) {
      clearTimeout(entry.timer);
      this.doc.update(id, entry.patch);
    }
    this.pendingUpdates.clear();
  }

  private render() {
    if (!this.currentContract || !this.container) return;
    const contract = this.currentContract;
    const typeKind = this.registry.getTypeKindFor(contract.kind);

    if (typeKind) {
      this.renderTypedElement(contract, typeKind);
    } else {
      // No type system — but element may still have custom properties
      this.container.innerHTML = "";
      const h3 = document.createElement("h3");
      h3.textContent = `${contract.kind.charAt(0).toUpperCase() + contract.kind.slice(1)} Properties`;
      this.container.appendChild(h3);

      const instanceDef = this.registry.get(contract.kind);
      if (instanceDef?.renderCustomProperties) {
        const helpers: PropertyFieldHelpers = {
          addField:        (c, l, v, s, min, max, cb) => this.addField(c, l, v, s, min, max, cb),
          addReadOnlyField:(c, l, v, h)               => this.addReadOnlyField(c, l, v, h),
          addSelectField:  (c, l, v, opts, cb)        => this.addSelectField(c, l, v, opts, cb),
          debouncedUpdate: (id, patch)                => this.debouncedUpdate(id, patch),
          doc: this.doc,
        };
        instanceDef.renderCustomProperties(contract, this.container, helpers);
      } else {
        const msg = document.createElement("div");
        msg.style.cssText = "color:#666;font-size:13px;";
        msg.textContent = "No editable properties";
        this.container.appendChild(msg);
      }
    }
  }

  private renderTypedElement(contract: AnyContract, typeKind: string) {
    if (!this.container) return;
    this.container.innerHTML = "";

    const h3 = document.createElement("h3");
    h3.textContent = `${contract.kind.charAt(0).toUpperCase() + contract.kind.slice(1)} Properties`;
    this.container.appendChild(h3);

    // Type selector
    const types = this.getTypesOfKind(typeKind);
    this.addTypeSelect(this.container, contract.id, (contract as any).typeId, types);

    // Typed params from registry metadata
    const typeDef = this.registry.get(typeKind);
    const typeContract = this.doc.contracts.get((contract as any).typeId);

    for (const param of typeDef?.typeParams ?? []) {
      if (param.category === "type-only") {
        const value = (typeContract as any)?.[param.key] ?? param.fallback;
        this.addReadOnlyField(this.container, param.label, value as number, "from type");
      } else if (param.category === "defaultable") {
        const hasOverride = (contract as any)[param.key] != null;
        const effective = (contract as any)[param.key] ?? (typeContract as any)?.[param.key] ?? param.fallback;
        const typeDefault = (typeContract as any)?.[param.key];
        this.addDefaultableField(
          this.container, param.label, effective as number,
          hasOverride, typeDefault as number | undefined,
          param.step ?? 0.1, param.min ?? 0, param.max ?? 100,
          (v) => this.debouncedUpdate(contract.id, { [param.key]: v }),
          () => this.doc.update(contract.id, { [param.key]: undefined })
        );
      } else if (param.category === "instance-only") {
        const value = (contract as any)[param.key] ?? param.fallback;
        this.addField(this.container, param.label, value as number,
          param.step ?? 0.1, param.min ?? 0, param.max ?? 100,
          (v) => this.debouncedUpdate(contract.id, { [param.key]: v }));
      }
    }

    // Element-specific custom fields (instance-only)
    const instanceDef = this.registry.get(contract.kind);
    if (instanceDef?.renderCustomProperties) {
      const helpers: PropertyFieldHelpers = {
        addField: (c, l, v, s, min, max, cb) => this.addField(c, l, v, s, min, max, cb),
        addReadOnlyField: (c, l, v, h) => this.addReadOnlyField(c, l, v, h),
        addSelectField: (c, l, v, opts, cb) => this.addSelectField(c, l, v, opts, cb),
        debouncedUpdate: (id, patch) => this.debouncedUpdate(id, patch),
        doc: this.doc,
      };
      instanceDef.renderCustomProperties(contract, this.container, helpers);
    }
  }

  // ── Field helpers ──────────────────────────────────────────────

  private addTypeSelect(container: HTMLElement, contractId: string, currentTypeId: string, types: AnyContract[]) {
    const label = document.createElement("label");
    label.textContent = "Type";
    const select = document.createElement("select");
    for (const t of types) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = (t as any).name ?? t.id.slice(0, 8);
      if (t.id === currentTypeId) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this.doc.update(contractId, { typeId: select.value });
    });
    label.appendChild(select);
    container.appendChild(label);
  }

  private addReadOnlyField(container: HTMLElement, labelText: string, value: number, hint?: string) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.value = value.toFixed(2);
    input.disabled = true;
    input.style.opacity = "0.6";
    label.appendChild(input);
    if (hint) {
      const span = document.createElement("span");
      span.style.cssText = "font-size: 10px; color: #666; margin-left: 4px;";
      span.textContent = hint;
      label.appendChild(span);
    }
    container.appendChild(label);
  }

  private addSelectField(container: HTMLElement, labelText: string, value: string | null, options: { id: string; label: string }[], onChange: (v: string | null) => void) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const select = document.createElement("select");
    // "None" option
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "— None —";
    if (!value) noneOpt.selected = true;
    select.appendChild(noneOpt);
    for (const opt of options) {
      const el = document.createElement("option");
      el.value = opt.id;
      el.textContent = opt.label;
      if (opt.id === value) el.selected = true;
      select.appendChild(el);
    }
    select.addEventListener("change", () => {
      onChange(select.value || null);
    });
    label.appendChild(select);
    container.appendChild(label);
  }

  private addField(container: HTMLElement, labelText: string, value: number, step: number, min: number, max: number, onChange: (v: number) => void) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(value);
    input.step = String(step);
    input.min = String(min);
    input.max = String(max);
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (!isNaN(v)) onChange(v);
    });
    label.appendChild(input);
    container.appendChild(label);
  }

  private addDefaultableField(
    container: HTMLElement,
    labelText: string,
    effectiveValue: number,
    hasOverride: boolean,
    typeDefault: number | undefined,
    step: number, min: number, max: number,
    onChange: (v: number) => void,
    onReset: () => void
  ) {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "margin-bottom: 8px;";

    const label = document.createElement("label");
    label.textContent = labelText;

    const input = document.createElement("input");
    input.type = "number";
    input.value = String(effectiveValue);
    input.step = String(step);
    input.min = String(min);
    input.max = String(max);
    if (!hasOverride) input.style.color = "#888";
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (!isNaN(v)) onChange(v);
      input.style.color = "";
      resetBtn.style.display = "inline";
    });
    label.appendChild(input);
    wrapper.appendChild(label);

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "reset";
    resetBtn.title = typeDefault != null ? `Reset to type default (${typeDefault})` : "Reset to type default";
    resetBtn.style.cssText = "font-size: 10px; padding: 1px 6px; margin-left: 4px; border: 1px solid #555; border-radius: 3px; background: #333; color: #aaa; cursor: pointer;";
    resetBtn.style.display = hasOverride ? "inline" : "none";
    resetBtn.addEventListener("click", () => onReset());
    wrapper.appendChild(resetBtn);

    container.appendChild(wrapper);
  }

  private getTypesOfKind(kind: string): AnyContract[] {
    const result: AnyContract[] = [];
    for (const [, c] of this.doc.contracts) {
      if (c.kind === kind) result.push(c);
    }
    return result;
  }
}
