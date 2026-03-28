# Side Panel + Type Management UI

## Goal

Add a full-height right side panel with tabs, starting with a **Types** tab for managing element types and a **Properties** tab (migrating the existing floating properties panel). Tools require a selected type before placing elements — like Revit's type selector.

## Layout Change

Current: floating `#properties-panel` at top-right (240px, appears on selection).
New: fixed right sidebar (`#side-panel`, ~280px wide) that's always visible, with tab buttons at the top.

```
┌──────────────────────────────────────────┬──────────┐
│                                          │ [Types]  │
│                                          │ [Props]  │
│           Canvas (flex: 1)               │──────────│
│                                          │          │
│                                          │  Panel   │
│                                          │  Content │
│                                          │          │
└──────────────────────────────────────────┴──────────┘
```

- `body` becomes `display: flex` with `#canvas-container` flex: 1 and `#side-panel` fixed width.
- Canvas no longer 100vw — it fills remaining space.
- Tab bar at top of side panel: "Types" | "Properties" (more later: Levels, etc.)

## Types Tab

Lists all type contracts in the document, grouped by element kind:

```
── Wall Types ──────────────
  [+] New Wall Type
  ● Generic - 200mm     ← selected (active for wall tool)
    H: 3.0  T: 0.20
  ○ Brick Facade - 300mm
    H: 3.0  T: 0.30
  [edit] [delete]

── Window Types ─────────────
  [+] New Window Type
  ● Standard - 1200x1000  ← selected
    W: 1.2  H: 1.0  Sill: 1.0
```

Interactions:
- **Click** a type → selects it as the active type for that element kind's tool
- **[+] New** → creates a type with defaults, opens inline edit
- **Edit** (on selected) → inline editable fields (same pattern as properties panel)
- **Delete** → removes type (only if no instances reference it, or warns)
- Editing a type field calls `doc.update(typeId, patch)` → cascade updates all instances

## Properties Tab

Migrates existing `PropertiesPanel` into a tab. Same behavior — shows when an element is selected, editable fields for the selected element's instance properties.

Additionally: shows a **Type** dropdown at the top so you can change which type an instance references (`typeId`). Changing the type triggers a `doc.update(instanceId, { typeId: newTypeId })` and cascades.

## Tool Changes

Tools get a `typeId` setter. When the wall tool creates a wall:

```typescript
const wall = createWall(start, end, { typeId: this.typeId });
// thickness/height come from the type via resolveTypeParams at geometry time
```

If no type is selected when the user tries to place an element, show a brief status message ("Select a wall type first").

The tool still needs `thickness` and `height` for the **preview** geometry (before the contract exists). It reads these from the active type contract:

```typescript
const type = doc.contracts.get(this.typeId);
const thickness = type?.thickness ?? 0.2;
const height = type?.height ?? 3.0;
```

## Default Types

On app startup (in main.ts), if the document has no types, create defaults:
- "Generic Wall - 200mm" (height: 3.0, thickness: 0.2)
- "Standard Window" (width: 1.2, height: 1.0, sillHeight: 1.0)

On file load, types come from the saved contracts.

## `typeId` Required

Make `typeId` required (not optional) on `WallContract` and `WindowContract`. The `createWall` / `createWindow` factory functions require it. `resolveTypeParams` can simplify — no need for the "no typeId" fallback path.

Instance contracts still hold the parameter fields (height, thickness, etc.) for serialization/fallback, but when `typeId` is set, the type values always win via `resolveTypeParams`.

## Files to Create/Modify

1. **`src/ui/side-panel.ts`** (NEW) — `SidePanel` class: creates the sidebar DOM, tab switching, hosts tab content
2. **`src/ui/types-tab.ts`** (NEW) — `TypesTab` class: lists types, CRUD, type selection per element kind
3. **`src/ui/properties.ts`** (MODIFY) — Refactor to render into a tab container instead of `#properties-panel`. Add type dropdown.
4. **`src/ui/styles.css`** (MODIFY) — Side panel layout, tab styles, type list styles
5. **`index.html`** (MODIFY) — Replace `#properties-panel` with `#side-panel`
6. **`src/tools/wall-tool.ts`** (MODIFY) — Read params from active type, require `typeId`
7. **`src/tools/window-tool.ts`** (MODIFY) — Same
8. **`src/core/contracts.ts`** (MODIFY) — Make `typeId` required
9. **`src/main.ts`** (MODIFY) — Wire side panel, create default types on startup, connect tools to type selection

## Implementation Order

1. Make `typeId` required in contracts, update `createWall`/`createWindow` signatures
2. Create `SidePanel` + `TypesTab` UI
3. Create default types on startup
4. Wire tools to read from active type
5. Migrate `PropertiesPanel` into a tab with type dropdown
6. Update CSS layout (body flex, sidebar, canvas resize)
7. Test: create types, place walls, edit type params, verify cascade
