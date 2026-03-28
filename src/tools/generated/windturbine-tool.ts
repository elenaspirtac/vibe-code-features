import * as THREE from "three";
import type { Tool, ToolManager } from "../tool-manager";
import type { BimDocument } from "../../core/document";
import type { ContractId } from "../../core/contracts";
import { snapPoint, SnapIndicator, recordStickySnap } from "../../utils/snap";
import { createWindTurbine } from "../../elements/generated/windturbine";

// Siemens Gamesa preview materials (semi-transparent)
const PREVIEW_TOWER   = new THREE.MeshLambertMaterial({ color: 0xEAEAEA, transparent: true, opacity: 0.55 });
const PREVIEW_NACELLE = new THREE.MeshLambertMaterial({ color: 0xD8D8D8, transparent: true, opacity: 0.55 });
const PREVIEW_BLADE   = new THREE.MeshLambertMaterial({ color: 0xEFEFEF, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
const PREVIEW_SPINNER = new THREE.MeshLambertMaterial({ color: 0xDCDCDC, transparent: true, opacity: 0.55 });
const PREVIEW_TIP     = new THREE.MeshLambertMaterial({ color: 0xCC2222, transparent: true, opacity: 0.7 });

export class WindTurbineTool implements Tool {
  name = "windturbine";
  typeId: ContractId | null = null;
  levelId: ContractId | null = null;

  private doc: BimDocument;
  private scene: THREE.Scene;
  private toolMgr: ToolManager;
  private snapIndicator: SnapIndicator;
  private preview: THREE.Group | null = null;
  private animFrame: number | null = null;
  private bladeAngle = 0;

  constructor(doc: BimDocument, scene: THREE.Scene, toolMgr: ToolManager) {
    this.doc = doc;
    this.scene = scene;
    this.toolMgr = toolMgr;
    this.snapIndicator = new SnapIndicator(scene);
  }

  activate() {
    document.body.style.cursor = "crosshair";
    this.startAnimation();
  }

  deactivate() {
    document.body.style.cursor = "default";
    this.snapIndicator.hide();
    this.clearPreview();
    this.stopAnimation();
  }

  onPointerDown(event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (event.button !== 0 || !intersection) return;

    const result = snapPoint(intersection, this.doc, {
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    const pos = result.position;

    const turbine = createWindTurbine([pos.x, pos.y, pos.z]);
    if (this.levelId) (turbine as any).levelId = this.levelId;
    this.clearPreview();
    this.doc.add(turbine);
  }

  onPointerMove(_event: PointerEvent, intersection: THREE.Vector3 | null) {
    if (!intersection) {
      this.snapIndicator.hide();
      this.clearPreview();
      return;
    }

    const result = snapPoint(intersection, this.doc, {
      elevation: this.toolMgr.workPlane.origin.y,
      snapGroupManager: this.toolMgr.snapGroupManager ?? undefined,
    });
    recordStickySnap(result);
    this.snapIndicator.update(result);
    this.toolMgr.setCursorPosition(result.position);
    this.updatePreview(result.position);
  }

  onPointerUp() {}
  onKeyDown() {}

  // ── Animated preview ──────────────────────────────────────────────────────

  private startAnimation() {
    const animate = () => {
      this.bladeAngle += 0.02;
      if (this.preview) {
        const hub = this.preview.getObjectByName("hub");
        if (hub) hub.rotation.z = this.bladeAngle;
      }
      this.animFrame = requestAnimationFrame(animate);
    };
    this.animFrame = requestAnimationFrame(animate);
  }

  private stopAnimation() {
    if (this.animFrame !== null) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  private updatePreview(pos: THREE.Vector3) {
    const H = 20, BL = 10, numBlades = 3;
    const tRT = H * 0.030, tRB = H * 0.065;
    const nacelleH = tRT * 2.4, nacelleLen = tRT * 10;
    const spinnerR = tRT * 2.2;
    const hubY = H + nacelleH * 0.5;
    const hubZ = nacelleLen * 0.55;

    if (!this.preview) {
      this.preview = new THREE.Group();

      // Tower (tapered)
      const towerGeo = new THREE.CylinderGeometry(tRT, tRB, H, 24);
      towerGeo.translate(0, H / 2, 0);
      this.preview.add(new THREE.Mesh(towerGeo, PREVIEW_TOWER));

      // Nacelle (streamlined box)
      const nacelleGeo = new THREE.BoxGeometry(tRT * 3.8, nacelleH, nacelleLen);
      nacelleGeo.translate(0, hubY, 0);
      this.preview.add(new THREE.Mesh(nacelleGeo, PREVIEW_NACELLE));

      // Spinner (conical nose)
      const spinnerGeo = new THREE.ConeGeometry(spinnerR, spinnerR * 2.8, 20);
      spinnerGeo.rotateX(Math.PI / 2);
      spinnerGeo.translate(0, hubY, hubZ + spinnerR);
      this.preview.add(new THREE.Mesh(spinnerGeo, PREVIEW_SPINNER));

      // Hub group — rotates in animation
      const hub = new THREE.Group();
      hub.name = "hub";
      hub.position.set(0, hubY, hubZ);

      for (let i = 0; i < numBlades; i++) {
        const angle = (i / numBlades) * Math.PI * 2;

        // Root cylinder
        const rootGeo = new THREE.CylinderGeometry(BL * 0.038, BL * 0.044, BL * 0.12, 12);
        rootGeo.translate(0, BL * 0.06, 0);
        const rootMesh = new THREE.Mesh(rootGeo, PREVIEW_TOWER);
        rootMesh.rotation.z = angle;
        rootMesh.position.set(Math.sin(angle) * BL * 0.06, Math.cos(angle) * BL * 0.06, 0);
        hub.add(rootMesh);

        // Blade — tapered box approximation
        const bladeGeo = buildPreviewBlade(BL);
        const bladeMesh = new THREE.Mesh(bladeGeo, PREVIEW_BLADE);
        bladeMesh.rotation.z = angle;
        bladeMesh.position.set(Math.sin(angle) * BL * 0.1, Math.cos(angle) * BL * 0.1, 0);
        hub.add(bladeMesh);

        // Red tip
        const tipGeo = new THREE.BoxGeometry(0.15, BL * 0.06, 0.07);
        tipGeo.translate(0, BL * 0.93, 0);
        const tipMesh = new THREE.Mesh(tipGeo, PREVIEW_TIP);
        tipMesh.rotation.z = angle;
        tipMesh.position.set(Math.sin(angle) * BL * 0.1, Math.cos(angle) * BL * 0.1, 0);
        hub.add(tipMesh);
      }

      this.preview.add(hub);
      this.preview.renderOrder = 5;
      this.scene.add(this.preview);
    }

    this.preview.position.set(pos.x, pos.y, pos.z);
  }

  private clearPreview() {
    if (this.preview) {
      this.scene.remove(this.preview);
      this.preview.traverse(obj => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      });
      this.preview = null;
    }
  }
}

// ── Simple blade geometry for preview ────────────────────────────────────────

function buildPreviewBlade(length: number): THREE.BufferGeometry {
  const rootW = 0.6, tipW = 0.05, thick = 0.1;
  const geo = new THREE.BufferGeometry();
  const verts = [
    // Front face (tapered quad → 2 tris)
    -rootW / 2, 0,      thick / 2,
     rootW / 2, 0,      thick / 2,
     tipW  / 2, length, thick / 2,

    -rootW / 2, 0,      thick / 2,
     tipW  / 2, length, thick / 2,
    -tipW  / 2, length, thick / 2,

    // Back face
    -rootW / 2, 0,      -thick / 2,
     tipW  / 2, length, -thick / 2,
     rootW / 2, 0,      -thick / 2,

    -rootW / 2, 0,      -thick / 2,
    -tipW  / 2, length, -thick / 2,
     tipW  / 2, length, -thick / 2,
  ];
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  return geo;
}
