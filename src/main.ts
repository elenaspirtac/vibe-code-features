import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { BimDocument } from "./core/document";
import { ElementRegistry } from "./core/registry";

import { UndoManager } from "./core/undo-manager";
import { getGeometryEngine } from "./generators/engine";
import { FragmentManager } from "./fragments/manager";
import { FragmentSync } from "./fragments/sync";
import { ToolManager, type Tool } from "./tools/tool-manager";
import { WallTool } from "./tools/wall-tool";
import { SelectTool } from "./tools/select-tool";
import { WindowTool } from "./tools/window-tool";
import { wallElement } from "./elements/wall";
import { windowElement } from "./elements/window";
import { floorElement } from "./elements/floor";
import { FloorTool } from "./tools/floor-tool";
import { createToolbar } from "./ui/toolbar";
import { PropertiesPanel } from "./ui/properties";
import { SidePanel } from "./ui/side-panel";
import { TypesTab } from "./ui/types-tab";
import { createSnapPanel } from "./ui/snap-panel";
import { generateStressTest } from "./utils/stress-test";
import { createWallType } from "./elements/wall-type";
import { createWindowType } from "./elements/window-type";
import { createColumnType } from "./elements/column-type";
import { TempDimensionRenderer } from "./ui/temp-dimensions";
import { SpatialIndex } from "./utils/spatial-index";
import { columnElement } from "./elements/column";
import { ColumnTool } from "./tools/column-tool";
import { MoveTool } from "./tools/move-tool";
import { wallTypeElement } from "./elements/wall-type";
import { windowTypeElement } from "./elements/window-type";
import { columnTypeElement } from "./elements/column-type";
import { levelElement, createLevel } from "./elements/level";
import { LevelsTab } from "./ui/levels-tab";
import { MaterialsTab } from "./ui/materials-tab";
import { doorElement } from "./elements/door";
import { doorTypeElement, createDoorType } from "./elements/door-type";
import { materialElement } from "./elements/material";
import { SnapGroupManager, syncLevelSnapGroups } from "./utils/snap-groups";
import { DoorTool } from "./tools/door-tool";
import { PasteTool } from "./tools/paste-tool";
import { ModelClipboard } from "./utils/clipboard";
import { dynamicElements, dynamicToolDefs } from "./dynamic-tools";
import { createAIPanel } from "./ui/ai-panel";
import { generateWindFarm } from "./utils/wind-farm";

async function main() {
  // --- Three.js Scene ---
  const container = document.getElementById("canvas-container")!;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );
  camera.position.set(15, 12, 15);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  // Grid + axes
  const grid = new THREE.GridHelper(100, 100, 0x444444, 0x333333);
  scene.add(grid);
  const axes = new THREE.AxesHelper(2);
  scene.add(axes);

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(10, 20, 10);
  scene.add(dirLight);

  // Resize — canvas fills remaining space beside the side panel
  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener("resize", onResize);
  // Initial size after layout settles
  requestAnimationFrame(onResize);

  // --- Status bar ---
  const statusBar = document.createElement("div");
  statusBar.id = "status-bar";
  statusBar.textContent = "Initializing...";
  document.body.appendChild(statusBar);

  // --- Geometry Engine ---
  statusBar.textContent = "Loading geometry engine (WASM)...";
  const engine = await getGeometryEngine();
  statusBar.textContent = "Geometry engine ready.";

  // --- Fragments ---
  statusBar.textContent = "Initializing fragments...";
  const fragMgr = await FragmentManager.create(scene, camera);
  statusBar.textContent = "Fragments ready.";

  // --- Registry ---
  const registry = new ElementRegistry();
  registry.register(wallElement);
  registry.register(wallTypeElement);
  registry.register(windowElement);
  registry.register(windowTypeElement);
  registry.register(floorElement);
  registry.register(columnElement);
  registry.register(columnTypeElement);
  registry.register(doorElement);
  registry.register(doorTypeElement);
  registry.register(levelElement);
  registry.register(materialElement);

  // --- Dynamic (AI-generated) elements ---
  for (const el of dynamicElements) {
    registry.register(el);
  }

  // --- Document + Sync ---
  const doc = new BimDocument();

  doc.registry = registry;

  // Spatial index: O(log n) broadphase for snap, dimensions, joints
  const spatialIndex = new SpatialIndex(doc);
  spatialIndex.connect();
  doc.spatialIndex = spatialIndex;

  // Cascade resolver: delegates to registry's declarative relationship behaviors
  doc.setCascadeResolver((id, d) => registry.resolveCascadeDelete(id, d));

  const sync = new FragmentSync(doc, fragMgr, engine, scene, registry);
  await sync.init();

  // --- Temporary Dimensions ---
  const tempDims = new TempDimensionRenderer(
    container,
    camera,
    renderer.domElement,
    doc,
    scene
  );

  // --- Default types ---
  const defaultWallType = createWallType({ height: 3.0, thickness: 0.2 });
  const defaultWindowType = createWindowType({ width: 1.2, height: 1.0, sillHeight: 1.0 });
  const defaultColumnType = createColumnType({ height: 3.0, width: 0.3 });
  const defaultDoorType = createDoorType({ width: 0.9, height: 2.1 });
  doc.add(defaultWallType);
  doc.add(defaultWindowType);
  doc.add(defaultColumnType);
  doc.add(defaultDoorType);

  // --- Default levels ---
  const level0 = createLevel("Level 0", 0);
  const level1 = createLevel("Level 1", 3);
  doc.add(level0);
  doc.add(level1);

  // --- Tools ---
  const toolMgr = new ToolManager(container, camera, scene);
  const wallTool = new WallTool(scene, doc, engine, toolMgr, sync, tempDims);
  wallTool.typeId = defaultWallType.id;
  const windowTool = new WindowTool(scene, doc, engine, camera, renderer.domElement, fragMgr, toolMgr);
  windowTool.typeId = defaultWindowType.id;
  const floorTool = new FloorTool(scene, doc, engine, toolMgr, sync);
  const columnTool = new ColumnTool(doc, scene, toolMgr);
  columnTool.typeId = defaultColumnType.id;
  const doorTool = new DoorTool(scene, doc, engine, camera, renderer.domElement, fragMgr, toolMgr);
  doorTool.typeId = defaultDoorType.id;
  const selectTool = new SelectTool(scene, camera, renderer.domElement, doc, fragMgr, toolMgr, controls, engine, sync, registry);
  const moveTool = new MoveTool(scene, doc, toolMgr, sync, registry, selectTool, controls);
  // Hide temp dimensions during move drag; restore on commit/cancel.
  moveTool.onDragStateChanged = (dragging) => {
    if (dragging) {
      tempDims.onSelectionChanged([]);
    } else {
      // Restore dimensions for the currently selected elements
      const sel = selectTool.getSelectedContractsAll();
      if (sel.length > 0) tempDims.onSelectionChanged(sel);
    }
  };

  // Hide temp dimensions during select-tool endpoint drag; restore on release.
  selectTool.onDragStateChanged = (dragging) => {
    if (dragging) {
      tempDims.onSelectionChanged([]);
    } else {
      const sel = selectTool.getSelectedContractsAll();
      if (sel.length > 0) tempDims.onSelectionChanged(sel);
    }
  };

  // --- Clipboard & Paste ---
  const clipboard = new ModelClipboard();
  const pasteTool = new PasteTool(scene, doc, toolMgr, sync, registry, selectTool, clipboard);

  // --- UI ---
  const sidePanel = new SidePanel();
  const typesTab = new TypesTab(doc, registry);
  const propsPanel = new PropertiesPanel(doc, registry);

  // Wire type selection → tools (generic: each tool declares its typeKind)
  // --- Dynamic (AI-generated) tools ---
  const dynamicToolInstances: Tool[] = dynamicToolDefs.map(
    ({ ToolClass }) => new ToolClass(doc, scene, toolMgr)
  );

  const allTools: Tool[] = [wallTool, windowTool, doorTool, floorTool, columnTool, selectTool, moveTool, pasteTool, ...dynamicToolInstances];
  typesTab.onBeforeTypeEdit = () => selectTool.clearSelection();
  typesTab.onSelectionChanged = (sel) => {
    for (const tool of allTools) {
      if (tool.typeKind) {
        tool.typeId = sel.get(tool.typeKind) ?? null;
      }
    }
  };

  // --- Snap Groups ---
  const snapGroupMgr = new SnapGroupManager();
  toolMgr.snapGroupManager = snapGroupMgr;

  // Wire levels → tools + grid + snap groups
  const levelsTab = new LevelsTab(doc);
  levelsTab.snapGroupManager = snapGroupMgr;
  levelsTab.onLevelChanged = (levelId, elevation) => {
    toolMgr.setActiveLevel(levelId, elevation);
    for (const tool of allTools) {
      tool.levelId = levelId;
    }
    grid.position.y = elevation;
    // Update membership + auto-enable adjacent (preserves user-toggled groups).
    syncLevelSnapGroups(doc, snapGroupMgr, levelId);
    levelsTab.refresh();
  };

  // Keep snap group membership up to date (don't reset toggles on element add/remove)
  doc.onAdded.add(() => syncLevelSnapGroups(doc, snapGroupMgr, toolMgr.activeLevelId, false));
  doc.onRemoved.add(() => syncLevelSnapGroups(doc, snapGroupMgr, toolMgr.activeLevelId, false));

  const materialsTab = new MaterialsTab(doc, registry);
  materialsTab.onBeforeEdit = () => selectTool.clearSelection();

  sidePanel.addTab("levels", "Levels", () => {
    levelsTab.render(sidePanel.content);
  });
  sidePanel.addTab("types", "Types", () => {
    typesTab.render(sidePanel.content);
  });
  sidePanel.addTab("materials", "Materials", () => {
    materialsTab.render(sidePanel.content);
  });
  sidePanel.addTab("properties", "Properties", () => {
    const selected = selectTool.getSelectedContract();
    if (selected) {
      propsPanel.show(selected, sidePanel.content);
    } else {
      propsPanel.showEmpty(sidePanel.content);
    }
  });

  // Auto-select defaults
  typesTab.autoSelect();
  levelsTab.autoSelect();
  syncLevelSnapGroups(doc, snapGroupMgr, toolMgr.activeLevelId);

  createToolbar(toolMgr, [
    { tool: wallTool, label: "Wall" },
    { tool: windowTool, label: "Window" },
    { tool: doorTool, label: "Door" },
    { tool: floorTool, label: "Floor" },
    { tool: columnTool, label: "Column" },
    { tool: selectTool, label: "Select" },
    { tool: moveTool, label: "Move" },
    ...dynamicToolDefs.map(({ label }, i) => ({ tool: dynamicToolInstances[i], label })),
  ]);

  // --- AI Panel ---
  createAIPanel();

  createSnapPanel();

  // --- Undo/Redo + UI ---
  {
    const toolbar = document.getElementById("toolbar")!;
    const undoMgr = new UndoManager(doc, sync);

    // Wire transaction recording
    doc.onTransactionCommit.add((record) => undoMgr.recordTransaction(record));
    // Clear selection when entering fast undo/redo
    undoMgr.onBeforeUndoRedo = () => selectTool.clearSelection();

    // Undo / Redo buttons
    const undoBtn = document.createElement("button");
    undoBtn.textContent = "Undo";
    undoBtn.disabled = true;
    undoBtn.addEventListener("click", () => undoMgr.undo());
    toolbar.appendChild(undoBtn);

    const redoBtn = document.createElement("button");
    redoBtn.textContent = "Redo";
    redoBtn.disabled = true;
    redoBtn.addEventListener("click", () => undoMgr.redo());
    toolbar.appendChild(redoBtn);

    undoMgr.onStateChanged.add(() => {
      undoBtn.disabled = !undoMgr.canUndo;
      redoBtn.disabled = !undoMgr.canRedo;
    });

    // --- Global keyboard shortcuts (Ctrl+Z/Y/C/V) ---
    window.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoMgr.undo();
      } else if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
        e.preventDefault();
        undoMgr.redo();
      } else if (e.key === "c") {
        e.preventDefault();
        const selected = selectTool.getSelectedContractsAll();
        if (selected.length > 0) {
          clipboard.copy(selected, doc, registry);
        }
      } else if (e.key === "v") {
        e.preventDefault();
        if (clipboard.hasContent) {
          toolMgr.setTool(pasteTool);
        }
      }
    });

    // Log toggle
    // --- Debug bar (second row below toolbar) ---
    const debugBar = document.createElement("div");
    debugBar.id = "debug-bar";
    document.body.appendChild(debugBar);

    // Log TXN toggle
    const logLabel = document.createElement("label");
    const logCb = document.createElement("input");
    logCb.type = "checkbox";
    logLabel.appendChild(logCb);
    logLabel.appendChild(document.createTextNode("Log TXN"));
    debugBar.appendChild(logLabel);

    let logListener: ((r: any) => void) | null = null;
    logCb.addEventListener("change", () => {
      if (logCb.checked) {
        logListener = (r: any) => console.log("TXN", r.mutations.length, "ops", r);
        doc.onTransactionCommit.add(logListener);
      } else if (logListener) {
        doc.onTransactionCommit.remove(logListener);
        logListener = null;
      }
    });

    // Auto-assert toggle
    let autoAssert = false;
    const assertLabel = document.createElement("label");
    const assertCb = document.createElement("input");
    assertCb.type = "checkbox";
    assertCb.checked = false;
    assertLabel.appendChild(assertCb);
    assertLabel.appendChild(document.createTextNode("Auto-Assert"));
    debugBar.appendChild(assertLabel);

    // Dump button
    const dumpBtn = document.createElement("button");
    dumpBtn.textContent = "Dump";
    dumpBtn.addEventListener("click", () => sync.debugDump());
    debugBar.appendChild(dumpBtn);

    // Stress test button
    const stressBtn = document.createElement("button");
    stressBtn.textContent = "Stress 10×10";
    stressBtn.addEventListener("click", () => {
      const sel = typesTab.getSelection();
      generateStressTest(doc, {
        wallTypeId: sel.get("wallType") ?? undefined,
        windowTypeId: sel.get("windowType") ?? undefined,
      });
    });
    debugBar.appendChild(stressBtn);

    // Cut button: first selected element cuts the rest
    const cutBtn = document.createElement("button");
    cutBtn.textContent = "Cut";
    cutBtn.addEventListener("click", () => {
      const all = selectTool.getSelectedContractsAll();
      if (all.length < 2) {
        statusBar.textContent = "Select a cutter, then shift-click target(s).";
        return;
      }
      sync.addCut(all[0].id, all.slice(1).map((t) => t.id));
      statusBar.textContent = `${all[0].kind} now cuts ${all.length - 1} element(s).`;
    });
    debugBar.appendChild(cutBtn);

    // Reset Cuts button: remove all cutTargets from selected elements
    const resetCutsBtn = document.createElement("button");
    resetCutsBtn.textContent = "Reset Cuts";
    resetCutsBtn.addEventListener("click", () => {
      const all = selectTool.getSelectedContractsAll();
      if (all.length === 0) {
        statusBar.textContent = "Select element(s) to reset cuts.";
        return;
      }
      let count = 0;
      for (const c of all) {
        const fresh = doc.contracts.get(c.id);
        if (fresh && ((fresh as Record<string, unknown>).cutTargets as string[] | undefined)?.length) {
          sync.removeCuts(c.id);
          count++;
        }
      }
      statusBar.textContent = count > 0
        ? `Cleared cuts on ${count} element(s).`
        : "No cuts to clear.";
    });
    debugBar.appendChild(resetCutsBtn);

    // Hide Selected button
    const hideBtn = document.createElement("button");
    hideBtn.textContent = "Hide Selected";
    hideBtn.addEventListener("click", () => {
      const all = selectTool.getSelectedContractsAll();
      if (all.length === 0) {
        statusBar.textContent = "Select element(s) to hide.";
        return;
      }
      const ids = all.map((c) => c.id);
      selectTool.clearSelection();
      sync.temporaryHide(ids);
      statusBar.textContent = `Hidden ${ids.length} element(s). Click "Show All" to reveal.`;
    });
    debugBar.appendChild(hideBtn);

    // Wind Farm button
    const windFarmBtn = document.createElement("button");
    windFarmBtn.textContent = "🌬️ Wind Farm 10×10";
    windFarmBtn.style.cssText = "background:#a6e3a1; color:#1e1e2e; font-weight:700; border:none;";
    windFarmBtn.addEventListener("click", () => {
      const bladeLength = 10;
      const rotorD = bladeLength * 2;
      const count = generateWindFarm(doc, camera, controls);
      statusBar.textContent =
        `🌬️ Offshore wind farm: ${count} turbines — ` +
        `spacing ${rotorD * 5}m × ${rotorD * 7}m (5D × 7D, Horns Rev standard, Danish Energy Agency).`;
    });
    debugBar.appendChild(windFarmBtn);

    // Show All button
    const showAllBtn = document.createElement("button");
    showAllBtn.textContent = "Show All";
    showAllBtn.addEventListener("click", () => {
      sync.showAllTemporary();
      statusBar.textContent = "All elements visible.";
    });
    debugBar.appendChild(showAllBtn);

    function runAssert(context: string) {
      if (!autoAssert) return;
      try {
        sync.assertInvariants();
      } catch (e: any) {
        statusBar.textContent = `✗ [${context}] ${e.message}`;
        console.error(`[${context}]`, e);
      }
    }

    assertCb.addEventListener("change", () => {
      autoAssert = assertCb.checked;
      if (autoAssert) {
        statusBar.textContent = "Auto-assert enabled.";
        runAssert("toggle-on");
      }
    });

    // Hook into all state-changing events
    doc.onTransactionCommit.add(() => runAssert("after-transaction"));
    undoMgr.onStateChanged.add(() => runAssert("after-undo-state-change"));

    // --- Save button ---
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      statusBar.textContent = "Saving...";
      try {
        // Deselect to restore all extracted elements to fragments
        selectTool.clearSelection();

        // Force-complete any pending operations
        undoMgr.finalizePendingGroup();
        await undoMgr.awaitRecording();
        await sync.flush();

        // Flatten edits: merge delta model into base
        await fragMgr.editor.save(fragMgr.modelId);

        // Give the worker time to rebuild the model after save
        await new Promise(r => setTimeout(r, 500));
        await fragMgr.update(true);

        // Get the fragment binary
        const buffer = await fragMgr.getBuffer();

        // Serialize document state (stamp each contract with its schema version)
        const docData = doc.toJSON((kind) => registry.getVersion(kind));

        // Encode binary as base64
        let binary = "";
        for (let i = 0; i < buffer.length; i++) {
          binary += String.fromCharCode(buffer[i]);
        }
        const fragBuffer = btoa(binary);

        // Combine into .bim JSON and download
        const bimFile = JSON.stringify({
          version: 1,
          contracts: docData.contracts,
          fragmentIds: docData.fragmentIds,
          typeReprIds: docData.typeReprIds,
          fragBuffer,
        });
        const blob = new Blob([bimFile], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "project.bim";
        a.click();
        URL.revokeObjectURL(url);

        statusBar.textContent = "Saved successfully.";
      } catch (e) {
        console.error("Save failed:", e);
        statusBar.textContent = "Save failed. See console.";
      }
    });
    toolbar.appendChild(saveBtn);

    // --- Load button ---
    const loadBtn = document.createElement("button");
    loadBtn.textContent = "Load";
    loadBtn.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".bim";
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        statusBar.textContent = "Loading...";
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (data.version !== 1) {
            throw new Error(`Unsupported .bim version: ${data.version}`);
          }

          // Deselect everything
          selectTool.clearSelection();

          // Wait for in-flight operations and reset undo state
          await undoMgr.awaitRecording();
          await sync.flush();
          undoMgr.reset();

          // Reset sync state (clears overlays, pending ops, timers)
          sync.reset();

          // Dispose old fragment model
          await fragMgr.disposeModel(scene);

          // Decode base64 -> Uint8Array
          const binary = atob(data.fragBuffer);
          const buffer = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            buffer[i] = binary.charCodeAt(i);
          }

          // Load new fragment model
          await fragMgr.loadModel(buffer, scene, camera);

          // Repopulate document maps (no events fired), migrating old schemas
          doc.loadFromJSON(
            { contracts: data.contracts, fragmentIds: data.fragmentIds, typeReprIds: data.typeReprIds },
            (contracts) => registry.migrateAll(contracts)
          );

          // Rebuild spatial index first (wall neighbor detection depends on it),
          // then rebuild the dependentsOf reverse index eagerly so it's correct
          // from the start. loadFromJSON doesn't fire events, so the incremental
          // path never runs — this explicit rebuild is the only opportunity.
          spatialIndex.rebuild();
          sync.rebuildDependentsIndex();
          // Rebuild type repr map if not present in save file (migration from old format)
          if (!data.typeReprIds) {
            sync.rebuildTypeReprIds();
          }

          // Re-select types and levels from loaded document
          typesTab.autoSelect();
          levelsTab.autoSelect();
          syncLevelSnapGroups(doc, snapGroupMgr, toolMgr.activeLevelId);
          const sel = typesTab.getSelection();
          for (const tool of allTools) {
            if (tool.typeKind) tool.typeId = sel.get(tool.typeKind) ?? null;
          }
          if (sidePanel.currentTab === "types") typesTab.refresh();
          if (sidePanel.currentTab === "levels") levelsTab.refresh();

          statusBar.textContent = "Loaded successfully.";
        } catch (e) {
          console.error("Load failed:", e);
          statusBar.textContent = "Load failed. See console.";
        }
      });
      input.click();
    });
    toolbar.appendChild(loadBtn);

    selectTool.onSelectionChanged = (contract) => {
      if (contract) {
        // Switch to properties tab and show the selected element
        sidePanel.switchTab("properties");
        propsPanel.show(contract, sidePanel.content);
        tempDims.onSelectionChanged([contract]);
      } else {
        // If on properties tab, show empty state
        if (sidePanel.currentTab === "properties") {
          propsPanel.showEmpty(sidePanel.content);
        }
        tempDims.onSelectionChanged([]);
        // Selection cleared — finalize the session record after restore
        // flushes fragments.
        undoMgr.finalizeSelectionRecord();
      }
      // Defer — restore enqueues async work that must complete first
      setTimeout(() => runAssert("after-selection-change"), 100);
    };

    // Update properties panel + temp dimensions when contract changes.
    // Skip during drag — tempDims.recompute() creates/destroys Three.js
    // lines + DOM labels on every update, causing progressive GC pressure.
    // Properties panel is also unnecessary while dragging.
    doc.onUpdated.add(({ contract }) => {
      if (sync.isDragging) return;
      if (
        selectTool.getSelectedContract()?.id === contract.id &&
        sidePanel.currentTab === "properties"
      ) {
        propsPanel.show(contract, sidePanel.content);
      }
      // Refresh types tab if a type was updated
      if (registry.isDataOnly(contract.kind) && sidePanel.currentTab === "types") {
        typesTab.refresh();
      }
      tempDims.onContractUpdated(contract);
    });
  }

  statusBar.textContent = "Ready. Select a tool to begin.";

  // --- Render Loop ---
  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    fragMgr.fragments.update();
    renderer.render(scene, camera);
  }
  animate();

  // Expose for debugging
  (window as any).__bim = {
    doc, fragMgr, engine, scene, sync, toolMgr,
    stressTest: (opts?: any) => generateStressTest(doc, opts),
    /** Ad-hoc boolean: make `cutterId` cut `targetId`. */
    cutGeometry: (cutterId: string, targetId: string) => {
      const cutter = doc.contracts.get(cutterId);
      if (!cutter) { console.error("Cutter not found:", cutterId); return; }
      const target = doc.contracts.get(targetId);
      if (!target) { console.error("Target not found:", targetId); return; }
      const existing = ((cutter as Record<string, unknown>).cutTargets as string[] | undefined) ?? [];
      if (existing.includes(targetId)) { console.log("Already cutting"); return; }
      doc.update(cutterId, { cutTargets: [...existing, targetId] });
      console.log(`${cutter.kind} ${cutterId.slice(0,8)} now cuts ${target.kind} ${targetId.slice(0,8)}`);
    },
  };
}

main().catch(console.error);

