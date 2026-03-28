---
name: thatopen
description: "Guide for building BIM web applications with That Open Company's open-source libraries: @thatopen/fragments, @thatopen/components, @thatopen/components-front, @thatopen/ui, @thatopen/ui-obc, and web-ifc. Use this skill whenever the user is working with IFC files, BIM models, 3D building visualization, or any of these packages. Also trigger when the user mentions fragments, BIM, IFC, building models, architectural visualization, Three.js with construction/building data, or wants to create a web app that displays or edits 3D building geometry. Even if they just say 'load a model' or 'show the building' in the context of a project that uses these libraries, use this skill."
---

# That Open Engine — BIM Web Development Guide

You are helping developers build web applications using That Open Company's open-source BIM (Building Information Modeling) libraries. These libraries let you load, display, edit, and interact with 3D building models (IFC files) in the browser.

## The Ecosystem

There are two tiers of usage. Pick whichever fits the project:

### Tier 1: High-Level (Components)
Best for: quickly standing up a BIM viewer with batteries-included tools (measurements, clipping, highlighting, property panels).

| Package | Purpose |
|---------|---------|
| `@thatopen/components` | Core framework — scene, camera, renderer, IFC loading, classification, visibility |
| `@thatopen/components-front` | Browser-only extras — post-processing, highlighting, outlining, measurements |
| `@thatopen/ui` | Framework-agnostic Web Components for UI (panels, toolbars, tables, buttons) |
| `@thatopen/ui-obc` | Pre-wired UI panels that plug into Components |

### Tier 2: Low-Level (Fragments + web-ifc directly)
Best for: custom authoring tools, geometry generation, maximum control over rendering and editing.

| Package | Purpose |
|---------|---------|
| `@thatopen/fragments` | High-performance fragment-based model rendering, IFC→binary conversion, editing API |
| `web-ifc` | WebAssembly IFC parser/writer, geometry engine (extrusions, sweeps, booleans) |
| `three` | 3D rendering (peer dependency of everything) |

Both tiers share the same underlying fragment format and Three.js rendering.

---

## Installation

### Tier 1 (Components)
```bash
npm install @thatopen/components @thatopen/components-front @thatopen/fragments @thatopen/ui @thatopen/ui-obc three camera-controls web-ifc
```

### Tier 2 (Fragments + web-ifc)
```bash
npm install @thatopen/fragments three web-ifc
```

### Peer dependency versions
- `three` >= 0.175
- `web-ifc` >= 0.0.74
- `camera-controls` >= 3.1.2 (only needed for Tier 1)

---

## Tier 1: Components Setup

This is the standard pattern. Every Components-based app follows these steps.

```typescript
import * as OBC from "@thatopen/components";
import * as OBCF from "@thatopen/components-front";
import * as BUI from "@thatopen/ui";
import * as THREE from "three";

// 1. Initialize the UI system (must come before using any <bim-*> tags)
BUI.Manager.init();

// 2. Create the components engine
const components = new OBC.Components();

// 3. Create a 3D world (scene + camera + renderer)
const worlds = components.get(OBC.Worlds);
const world = worlds.create<
  OBC.SimpleScene,
  OBC.SimpleCamera,
  OBC.SimpleRenderer
>();

const container = document.getElementById("viewer")!;
world.scene = new OBC.SimpleScene(components);
world.renderer = new OBC.SimpleRenderer(components, container);
world.camera = new OBC.SimpleCamera(components);
world.scene.setup(); // adds default lights

// 4. Start the render loop
components.init();

// 5. Initialize fragments with a Web Worker for background processing
const fragments = components.get(OBC.FragmentsManager);
const workerFile = await fetch(
  "https://thatopen.github.io/engine_fragment/resources/worker.mjs"
);
const workerBlob = new Blob([await workerFile.text()], {
  type: "text/javascript",
});
fragments.init(URL.createObjectURL(workerBlob));

// 6. Wire camera updates → fragment LOD/culling
world.camera.controls.addEventListener("update", () =>
  fragments.core.update()
);

// 7. Auto-add loaded models to the scene + fix z-fighting
fragments.core.onModelLoaded.add((model) => {
  model.useCamera(world.camera.three);
  world.scene.three.add(model.object);
});
fragments.models.materials.list.onItemSet.add(([_id, material]) => {
  if (material instanceof THREE.MeshLambertMaterial) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
  }
});
```

### Loading IFC Files (Components)

```typescript
const ifcLoader = components.get(OBC.IfcLoader);
await ifcLoader.setup({ autoSetWasm: true });

// From a file input
const file = inputElement.files[0];
const buffer = await file.arrayBuffer();
const model = await ifcLoader.load(new Uint8Array(buffer));

// From a URL
const response = await fetch("model.ifc");
const data = await response.arrayBuffer();
const model = await ifcLoader.load(new Uint8Array(data));
```

### Loading Pre-converted Fragments

Fragment files (.frag) load 10x+ faster than IFC. Convert once, load many times.

```typescript
const response = await fetch("model.frag");
const buffer = await response.arrayBuffer();
const model = await fragments.core.load(new Uint8Array(buffer), {
  modelId: "my-model",
  camera: world.camera.three,
});
world.scene.three.add(model.object);
```

---

## Tier 2: Direct Fragments + web-ifc Setup

When you don't need the Components framework (e.g., building a custom authoring tool):

```typescript
import * as FRAGS from "@thatopen/fragments";
import * as THREE from "three";

// Create scene, camera, renderer with plain Three.js
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, w / h, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ canvas });

// Initialize FragmentsModels with worker
const fragmentsModels = new FRAGS.FragmentsModels();
// ... load worker same way as above, or serve worker.mjs locally

// Load a model
const model = await fragmentsModels.load(buffer, {
  modelId: "model-1",
  camera,
});
scene.add(model.object);

// Update on camera changes
function animate() {
  requestAnimationFrame(animate);
  fragmentsModels.update();
  renderer.render(scene, camera);
}
```

### IFC → Fragments Conversion (Lower-Level)

```typescript
const importer = new FRAGS.IfcImporter();
importer.wasm = {
  absolute: true,
  path: "https://unpkg.com/web-ifc@0.0.74/",
};

const ifcBuffer = await fetch("model.ifc").then((r) => r.arrayBuffer());
const fragBuffer = await importer.process({
  bytes: new Uint8Array(ifcBuffer),
});
const model = await fragmentsModels.load(fragBuffer, { modelId: "converted" });
```

### web-ifc Geometry Engine

For creating geometry programmatically (walls, extrusions, sweeps, booleans):

```typescript
import { IfcAPI } from "web-ifc";

const ifcApi = new IfcAPI();
ifcApi.SetWasmPath("path/to/wasm/");
await ifcApi.Init();

// Use via FRAGS.GeometryEngine for high-level ops
const engine = new FRAGS.GeometryEngine();
engine.api = ifcApi;

const geo = new THREE.BufferGeometry();
engine.getExtrusion(geo, { profile, direction, depth });
engine.getWall(geo, wallData);
engine.getSweep(geo, sweepData);
engine.getBooleanOperation(geo, boolData);
```

### web-ifc: Reading IFC Properties

```typescript
import { IfcAPI, IFCWALL, IFCPROJECT } from "web-ifc";

const ifcApi = new IfcAPI();
await ifcApi.Init();

const modelID = ifcApi.OpenModel(ifcBytes);

// Get all walls
const wallIDs = ifcApi.GetLineIDsWithType(modelID, IFCWALL);
for (let i = 0; i < wallIDs.size(); i++) {
  const wall = ifcApi.GetLine(modelID, wallIDs.get(i), true); // true = flatten refs
  console.log(wall.Name?.value, wall.GlobalId?.value);
}

// Get spatial structure (project → site → building → storey → elements)
const structure = await ifcApi.properties.getSpatialStructure(modelID);

// Get property sets for an element
const psets = await ifcApi.properties.getPropertySets(modelID, elementID);

// Get materials
const mats = await ifcApi.properties.getMaterialsProperties(modelID, elementID);

// Stream geometry (memory-efficient for large models)
ifcApi.StreamAllMeshes(modelID, (mesh) => {
  for (let i = 0; i < mesh.geometries.size(); i++) {
    const placed = mesh.geometries.get(i);
    const geo = ifcApi.GetGeometry(modelID, placed.geometryExpressID);
    const verts = ifcApi.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
    const indices = ifcApi.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
  }
});

ifcApi.CloseModel(modelID);
```

---

## UI Components (@thatopen/ui)

Framework-agnostic Web Components. Work with any framework (React, Vue, Svelte) or plain HTML. Always call `BUI.Manager.init()` before rendering.

### Available Components

| Tag | Purpose |
|-----|---------|
| `<bim-viewport>` | Full-screen 3D viewport container |
| `<bim-grid>` | CSS Grid layout with named areas |
| `<bim-panel>` | Collapsible side panel |
| `<bim-panel-section>` | Section within a panel |
| `<bim-toolbar>` | Horizontal/vertical toolbar |
| `<bim-toolbar-section>` | Section within toolbar |
| `<bim-toolbar-group>` | Grouped buttons in toolbar |
| `<bim-button>` | Button with icon + label |
| `<bim-text-input>` | Text input field |
| `<bim-number-input>` | Numeric input (optional slider) |
| `<bim-checkbox>` | Checkbox toggle |
| `<bim-dropdown>` | Dropdown selector |
| `<bim-option>` | Option for dropdown/selector |
| `<bim-selector>` | Custom selector |
| `<bim-color-input>` | Color picker |
| `<bim-label>` | Text label with optional icon |
| `<bim-icon>` | Icon (uses Iconify — e.g., `mdi:home`, `solar:alarm-bold`) |
| `<bim-tabs>` / `<bim-tab>` | Tabbed interface |
| `<bim-table>` | Data table with filter, group, sort, export |
| `<bim-context-menu>` | Context menu |
| `<bim-chart>` | Chart.js wrapper |

### Declarative HTML

```html
<bim-toolbar>
  <bim-toolbar-section label="File">
    <bim-button label="Open" icon="mdi:folder-open"></bim-button>
    <bim-button label="Save" icon="mdi:content-save"></bim-button>
  </bim-toolbar-section>
  <bim-toolbar-section label="Tools">
    <bim-button label="Measure" icon="mdi:ruler"></bim-button>
    <bim-button label="Clip" icon="mdi:box-cutter"></bim-button>
  </bim-toolbar-section>
</bim-toolbar>

<bim-panel label="Properties">
  <bim-panel-section label="General">
    <bim-text-input label="Name" value="Wall 1"></bim-text-input>
    <bim-number-input label="Height" value="3" suffix="m"></bim-number-input>
    <bim-checkbox label="Visible" checked></bim-checkbox>
  </bim-panel-section>
</bim-panel>
```

### Programmatic Creation (Lit-style templates)

```typescript
import * as BUI from "@thatopen/ui";

const panel = BUI.Component.create<BUI.Panel>(() => {
  return BUI.html`
    <bim-panel label="Settings">
      <bim-panel-section label="Display">
        <bim-checkbox
          label="Show edges"
          @change=${(e: Event) => {
            const checked = (e.target as BUI.Checkbox).checked;
            // toggle edges
          }}
        ></bim-checkbox>
        <bim-number-input
          label="Opacity"
          min="0" max="1" step="0.1" value="1"
          @change=${(e: Event) => {
            const val = (e.target as BUI.NumberInput).value;
          }}
        ></bim-number-input>
      </bim-panel-section>
    </bim-panel>
  `;
});
document.body.append(panel);
```

### Grid Layout

The grid component uses CSS Grid template syntax for app layouts:

```typescript
const grid = document.createElement("bim-grid") as BUI.Grid;

grid.layouts = {
  main: {
    template: `
      "toolbar toolbar" auto
      "sidebar viewport" 1fr
      / 300px 1fr
    `,
    elements: {
      toolbar: toolbarElement,
      sidebar: panelElement,
      viewport: viewportElement,
    },
  },
};

grid.layout = "main";
document.body.append(grid);
```

### Table with Data

```typescript
const table = document.createElement("bim-table") as BUI.Table;

table.data = [
  { data: { Name: "Wall 1", Type: "Generic", Height: 3.0 } },
  { data: { Name: "Window 1", Type: "Fixed", Height: 1.2 } },
];

// Custom cell rendering
table.dataTransform = {
  Height: (value) => BUI.html`<bim-label>${value}m</bim-label>`,
};

// Filtering
table.queryString = "Name=Wall";

// Grouping
table.groupedBy = ["Type"];
```

### Themes

```html
<html class="bim-ui-light">  <!-- or bim-ui-dark -->
```

Toggle at runtime: `BUI.Manager.toggleTheme()`.

---

## Components API Reference

### Core (@thatopen/components — imported as OBC)

**Access pattern:** all components are singletons accessed via `components.get(ComponentClass)`.

| Component | What it does |
|-----------|-------------|
| `OBC.Components` | Main engine. Call `.init()` to start the render loop. |
| `OBC.Worlds` | Create/manage multiple 3D worlds (scene+camera+renderer). |
| `OBC.SimpleScene` | Basic Three.js scene with configurable lights. |
| `OBC.SimpleCamera` | Orbit camera with `camera-controls`. Access `.controls` for manipulation. |
| `OBC.SimpleRenderer` | WebGL renderer. Modes: CONTINUOUS or MANUAL. |
| `OBC.OrthoPerspectiveCamera` | Switchable ortho/perspective with orbit, first-person, plan modes. |
| `OBC.FragmentsManager` | Load/manage fragment models. `.core` is the `FragmentsModels` instance. |
| `OBC.IfcLoader` | Convert IFC to fragments. Call `.setup({ autoSetWasm: true })` first. |
| `OBC.Classifier` | Group elements by entity type, spatial structure, material, etc. |
| `OBC.Hider` | Show/hide elements: `hider.set(visible, fragmentIdMap)`. |
| `OBC.BoundingBoxer` | Calculate bounding boxes for element selections. |
| `OBC.Clipper` | Create and manage clipping planes. |
| `OBC.Views` | Generate 2D section/plan views from 3D model. |
| `OBC.Raycasters` | Per-world raycasting. `raycasters.get(world).castRay()`. |
| `OBC.Grids` | Grid display. |

### Front (@thatopen/components-front — imported as OBCF)

| Component | What it does |
|-----------|-------------|
| `OBCF.PostproductionRenderer` | Replaces SimpleRenderer. Adds edge detection, AO, gloss, SMAA. |
| `OBCF.Highlighter` | Highlight elements with custom colors on hover/select. |
| `OBCF.Outliner` | Draw 3D outlines around elements. |
| `OBCF.LengthMeasurement` | Interactive distance measurement. |
| `OBCF.AreaMeasurement` | Interactive area measurement. |
| `OBCF.AngleMeasurement` | Interactive angle measurement. |
| `OBCF.VolumeMeasurement` | Volume measurement. |
| `OBCF.Marker` | 2D labels/markers anchored to 3D positions. |

---

## Fragments API Reference

### FragmentsModels (main entry point)

```typescript
const fm = new FRAGS.FragmentsModels(workerURL?);

fm.load(buffer, { modelId, camera })   // → Promise<FragmentsModel>
fm.update(force?)                       // Call on camera change for LOD
fm.dispose()                            // Clean up everything
fm.disposeModel(modelId)                // Dispose single model
fm.onModelLoaded                        // Event<FragmentsModel>
fm.models                               // MeshManager — .list has all models
fm.editor                               // Editor for creating/modifying elements
```

### FragmentsModel (single model)

```typescript
model.object          // THREE.Object3D — add to scene
model.modelId         // string
model.box             // THREE.Box3 bounding box
model.useCamera(cam)  // Enable frustum culling

// Sub-managers:
model.visibility      // .show(ids), .hide(ids)
model.highlight       // .add(ids), .remove(ids), .clear()
model.raycast         // .cast(raycaster) — hit testing
model.materials       // Material management
model.section         // Clipping plane management
model.data            // Metadata queries
model.items           // Item management, .setMaterial(ids, mat)
```

### Editor

```typescript
const editor = fm.editor;

editor.edit(modelId, actions, config?)  // Apply edit actions
editor.save(modelId)                    // Persist changes
editor.reset(modelId)                   // Discard unsaved changes
editor.createMaterial(modelId, mat)     // Register a material
editor.createLocalTransform(modelId, m) // Register a transform
editor.createShell(modelId, geo)        // Register shell geometry
```

### IfcImporter

```typescript
const importer = new FRAGS.IfcImporter();
importer.wasm = { path: "url/to/wasm/", absolute: true };
importer.process({ bytes, progressCallback? })  // → Promise<ArrayBuffer>
```

---

## Common Interaction Patterns

### Raycasting (click to select)

```typescript
// Components way
const raycasters = components.get(OBC.Raycasters);
const caster = raycasters.get(world);

window.addEventListener("click", () => {
  const result = caster.castRay();
  if (result) {
    console.log("Hit object:", result.object);
    console.log("Face index:", result.faceIndex);
  }
});

// Fragments way (lower-level)
const raycaster = new THREE.Raycaster();
// ... set from camera + mouse
const hit = await model.raycast.cast(raycaster);
if (hit) console.log("Hit item:", hit.id);
```

### Highlighting

```typescript
const highlighter = components.get(OBCF.Highlighter);
highlighter.setup({ world });

// Auto-highlight on hover/click
highlighter.events.select.onHighlight.add((data) => {
  console.log("Selected fragments:", data);
});

highlighter.events.hover.onHighlight.add((data) => {
  console.log("Hovered:", data);
});
```

### Classification + Visibility

```typescript
const classifier = components.get(OBC.Classifier);
const hider = components.get(OBC.Hider);

// Classify by IFC entity type
classifier.byEntity(model);

// Find all walls
const walls = classifier.find({ entities: ["IFCWALL"] });

// Toggle visibility
hider.set(false, walls); // hide walls
hider.set(true, walls);  // show walls
```

### Measurements

```typescript
const length = components.get(OBCF.LengthMeasurement);
length.world = world;
length.enabled = true;

// User clicks two points → measurement appears
// To create programmatically:
await length.create();

// Delete all measurements
length.deleteAll();
```

---

## Important Gotchas

1. **Always call `BUI.Manager.init()`** before any `<bim-*>` elements are created. Without it, Web Components won't register.

2. **Always call `components.init()`** to start the animation loop. Nothing renders without it.

3. **Fragment worker is required.** `FragmentsModels` does heavy processing in a Web Worker. You must provide a worker URL.

4. **`fragments.core.update()` on camera changes.** Without this, tile LOD and frustum culling won't work — you'll see missing geometry or no model at all.

5. **`model.useCamera(camera)`** after loading. Required for per-model frustum culling.

6. **Add `model.object` to the scene.** Models don't appear until you do `scene.three.add(model.object)` (Components) or `scene.add(model.object)` (plain Three.js).

7. **polygonOffset on materials.** Without the polygon offset fix, you'll see z-fighting (flickering surfaces). Apply it to all `MeshLambertMaterial` instances.

8. **web-ifc WASM files.** When using web-ifc directly, you need `web-ifc.wasm` accessible at runtime. Either copy to your public folder or point to a CDN. For Vite: `cp node_modules/web-ifc/web-ifc.wasm public/wasm/`.

9. **Memory management.** Always dispose models when done: `fragments.core.disposeModel(modelId)` or `fragments.core.dispose()`. Fragment models hold GPU resources.

10. **IFC loading is slow; Fragments loading is fast.** For production, convert IFC to .frag once and serve the fragment file. IFC→Fragments conversion can take seconds to minutes for large models.

---

## Quick Start Template

A minimal working app:

```html
<!DOCTYPE html>
<html class="bim-ui-dark">
<head>
  <style>
    body { margin: 0; height: 100vh; }
    #viewer { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="viewer"></div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

```typescript
// main.ts
import * as OBC from "@thatopen/components";
import * as BUI from "@thatopen/ui";
import * as THREE from "three";

BUI.Manager.init();

const components = new OBC.Components();
const worlds = components.get(OBC.Worlds);
const world = worlds.create<
  OBC.SimpleScene,
  OBC.SimpleCamera,
  OBC.SimpleRenderer
>();

world.scene = new OBC.SimpleScene(components);
world.renderer = new OBC.SimpleRenderer(components, document.getElementById("viewer")!);
world.camera = new OBC.SimpleCamera(components);
world.scene.setup();
components.init();

// Fragments setup
const fragments = components.get(OBC.FragmentsManager);
const wf = await fetch("https://thatopen.github.io/engine_fragment/resources/worker.mjs");
fragments.init(URL.createObjectURL(new Blob([await wf.text()], { type: "text/javascript" })));

world.camera.controls.addEventListener("update", () => fragments.core.update());

fragments.core.onModelLoaded.add((model) => {
  model.useCamera(world.camera.three);
  world.scene.three.add(model.object);
});
fragments.models.materials.list.onItemSet.add(([_, m]) => {
  if (m instanceof THREE.MeshLambertMaterial) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = 1;
    m.polygonOffsetUnits = 1;
  }
});

// Load IFC
const ifcLoader = components.get(OBC.IfcLoader);
await ifcLoader.setup({ autoSetWasm: true });

// Example: load from file input
document.getElementById("file-input")?.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const buffer = await file.arrayBuffer();
  await ifcLoader.load(new Uint8Array(buffer));
});
```

---

## Source Code Locations

The libraries live in sibling repos. When you need to look up implementation details, read examples, or check types:

| Library | Local Path | Key Source Files |
|---------|-----------|-----------------|
| Fragments | `../engine_fragment/packages/fragments/src/` | `FragmentsModels/index.ts`, `Importers/IfcImporter/index.ts`, `GeometryEngine/index.ts` |
| Components Core | `../engine_components/packages/core/src/` | `core/Components/`, `fragments/FragmentsManager/`, `fragments/IfcLoader/` |
| Components Front | `../engine_components/packages/front/src/` | `core/PostproductionRenderer/`, `fragments/Highlighter/` |
| UI Core | `../engine_ui-components/packages/core/src/` | `components/`, `core/Manager/` |
| web-ifc | `../engine_web-ifc/src/ts/` | `web-ifc-api.ts`, `helpers/properties.ts` |

Each library has `example.ts` files next to the source — these are the most reliable usage reference.
