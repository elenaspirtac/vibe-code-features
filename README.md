# 🏗️ bim-authoring

> 🚧 **Work in progress** — this is a starting point, not a finished product. Fork it, break it, rebuild it. The goal is to give you a foundation to build the next big authoring tool on top of.

**A web-based BIM authoring engine for the browser.** Place walls, windows, doors, columns, and floors in a live 3D scene — geometry is always derived from data, never hand-edited.

Built for the [AEC Hackathon Copenhagen 2026](https://www.aechackathon.com/) 🇩🇰

---

## 💡 Why this exists

Most BIM tools treat geometry as the source of truth. This one doesn't. Every element is a lightweight **contract** — a wall is just two points, a height, and a thickness. Geometry is a *consequence* of that data, rebuilt deterministically via WASM. Change a parameter, and the 3D model updates. Undo it, and it reverts. Save it, and you get a tiny JSON file.

This means you can:

- **Extend it in an afternoon** — add a new element type in 3 files
- **Trust undo/redo** — full transaction history with cascade support
- **Stay fast** — instant Three.js overlays while fragment geometry builds in the background

## 🚀 Quick start

```bash
npm install
npm run copy-wasm
npm run dev
```

Open [localhost:3000](http://localhost:3000). Start clicking.

## 🛠️ What you can do

| Tool | How it works |
|------|-------------|
| **Wall** | Two clicks set start and end points. Snaps to grid, angles, and nearby endpoints. |
| **Window / Door** | Hover over a wall, click to place. Automatically cuts a void in the host wall. |
| **Column** | Click anywhere on the ground plane. Drag the handle to reposition. |
| **Floor** | Click wall endpoints or free points to draw a boundary polygon. |
| **Select** | Click to select, Shift+click for multi-select. Drag handles to edit. Delete to remove (cascades to hosted elements). |
| **Move** | Two-click move with stretch targets for connected walls. |

**Keyboard shortcuts:** Ctrl+Z / Ctrl+Y for undo/redo, Ctrl+C / Ctrl+V for copy/paste, Delete to remove.

## 🏛️ Architecture

```
User Action → Tool → BimDocument.add/update/remove
                          ↓
                    Events fire (onAdded / onUpdated / onRemoved)
                          ↓
              ┌───────────┴───────────┐
              ↓                       ↓
     Three.js Overlay          Transaction Record
     (instant feedback)         (undo/redo stack)
              ↓
     FragmentSync (debounced)
              ↓
     Fragment Geometry Rebuild
     (persistent, GPU-optimized)
```

**Core idea:** contracts in, geometry out. The `BimDocument` is the single source of truth. Everything else — rendering, history, persistence — reacts to contract changes via events.

### Type / Instance system

Types hold shared parameters (wall height, door width). Instances reference a type and add placement data. Change a type → all instances update. This is enforced at the data level, not the UI level.

### Relationships

Elements know about each other: `hosts`, `hostedBy`, `connectedTo`, `instanceOf`, `belongsToLevel`, `usesMaterial`. Delete a wall → its windows and doors cascade-delete automatically within the same transaction.

## 🧩 Adding your own element

The system is built for extension. A new element type needs **3 files**:

1. **`src/elements/beam.ts`** — contract interface + element definition (data shape, geometry generation, relationships, snap points)
2. **`src/tools/beam-tool.ts`** — mouse interaction logic (click placement, preview, snapping)
3. **`src/handles/beam-handles.ts`** — drag handles for editing (optional)

Then register it in `main.ts`:

```ts
import { beamElement } from "./elements/beam";
import { BeamTool } from "./tools/beam-tool";

registry.register(beamElement);
const beamTool = new BeamTool(doc, scene, toolMgr);
```

Selection, undo/redo, save/load, and snapping work automatically — they're generic.

See [`guides/GETTING_STARTED.md`](guides/GETTING_STARTED.md) for a worked Beam example, or [`guides/CREATE_YOUR_OWN_ELEMENT.md`](guides/CREATE_YOUR_OWN_ELEMENT.md) for a full Door walkthrough with type/instance patterns and material slots.

## ⚙️ Tech stack

| | |
|---|---|
| **Three.js** | Real-time 3D rendering, raycasting, overlays |
| **@thatopen/fragments** | Tile-based BIM visualization (delta models, GPU-optimized) |
| **web-ifc (WASM)** | Deterministic geometry generation (extrusions, boolean cuts) |
| **RBush** | R-tree spatial indexing for O(log n) broadphase queries |
| **TypeScript + Vite** | Strict types, fast builds, HMR |

## 📜 Scripts

```bash
npm run dev          # Dev server on port 3000 with HMR
npm run build        # Production build (tsc + vite)
npm run copy-wasm    # Copy web-ifc WASM to public/ (run once after install)
npm test             # Run unit tests
npm run test:watch   # Watch mode
```

## 📁 File structure

```
src/
├── core/           # BimDocument, contracts, transactions, undo, events
├── elements/       # Wall, window, door, column, floor, level, material
├── generators/     # Geometry creation via web-ifc (profiles, booleans)
├── fragments/      # Fragment sync, overlays, visibility, persistence
├── tools/          # Placement & editing tools (wall, window, select, move...)
├── handles/        # Drag handles for interactive editing
├── utils/          # Snapping, spatial index, clipboard, geometry cache
├── ui/             # Toolbar, side panel, property inspector, tabs
└── main.ts         # Bootstrap
```

## 🤖 Claude Code skill included

This repo ships with a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill at `.claude/skills/thatopen/SKILL.md` — a comprehensive guide for building BIM web apps with all of [That Open Company](https://thatopen.com/)'s open-source libraries:

| Package | What it gives you |
|---------|-------------------|
| `@thatopen/fragments` | High-performance fragment-based model rendering and editing |
| `@thatopen/components` | Batteries-included BIM framework (loading, classification, clipping, measurements) |
| `@thatopen/components-front` | Browser extras — post-processing, highlighting, outlining |
| `@thatopen/ui` | Framework-agnostic Web Components (`<bim-panel>`, `<bim-table>`, `<bim-toolbar>`, ...) |
| `@thatopen/ui-obc` | Pre-wired UI panels that plug into Components |
| `web-ifc` | WASM IFC parser/writer and geometry engine |

When you use Claude Code in this repo, it automatically knows how to work with these libraries — setup patterns, API surfaces, common gotchas, and all. Just ask it to build something and it'll use the right APIs.

📚 Full documentation for the ecosystem: [docs.thatopen.com](https://docs.thatopen.com/)

## 📄 License

MIT
