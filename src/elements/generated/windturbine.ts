/**
 * Wind Turbine Element — Siemens Gamesa SG-series inspired
 * Modelled after the SG 14-222 DD offshore turbine visual profile.
 *
 * Key visual traits replicated:
 *  - Tapered steel tower (wide base → narrow top) in RAL 7035 light grey
 *  - Streamlined nacelle with angled nose & rounded spine (DD / direct-drive proportions)
 *  - Large conical spinner / nose-cone characteristic of Siemens Gamesa
 *  - Three IntegralBlade®-style blades: NACA-profile cross-section, gradual taper,
 *    ~15° twist root-to-tip, upward pre-bend (pre-deflection) for tower clearance
 *  - Blade root cylinders (boot fairings)
 *  - Red safety tip markers
 *  - Monopile transition flare at tower base
 */

import * as THREE from "three";
import type { ElementTypeDefinition } from "../../core/registry";
import type { BaseContract, ContractId } from "../../core/contracts";
import type { BimDocument } from "../../core/document";
import { resolveMaterial } from "../../utils/material-resolve";

// ── Contract ──────────────────────────────────────────────────────────────────

/** Foundation structural type — affects base geometry visually. */
export type FoundationType = "monopile" | "tripod" | "gravity" | "jacket";

export interface WindTurbineContract extends BaseContract {
  kind: "windturbine";

  // ── Geometry ──────────────────────────────────────────────────────────────
  base: [number, number, number];
  towerHeight: number;
  bladeLength: number;
  numBlades: number;
  rotationAngle: number;

  // ── Material overrides (optional — falls back to default palette) ─────────
  materials?: {
    tower?:      ContractId;
    nacelle?:    ContractId;
    blades?:     ContractId;
    foundation?: ContractId;
  };

  // ── BIM Properties (P1–P8) ───────────────────────────────────────────────

  /** P1 — Rated power output in megawatts (MW). Ref: SG 14-222 DD = 14 MW. */
  ratedPowerMW: number;

  /** P2 — Foundation structural type. Affects base geometry.
   *  monopile: single steel pipe (most common offshore DK)
   *  tripod:   three-legged steel structure (deep water)
   *  jacket:   lattice frame (deepest water)
   *  gravity:  wide concrete base (shallow water) */
  foundationType: FoundationType;

  /** P3 — Turbine manufacturer. */
  manufacturer: string;

  /** P4 — Turbine model designation. */
  modelName: string;

  /** P5 — Wind speed at which turbine begins generating electricity (m/s). */
  cutInSpeedMs: number;

  /** P6 — Wind speed at which rated power is achieved (m/s). */
  ratedSpeedMs: number;

  /** P7 — Wind speed at which turbine shuts down for storm protection (m/s). */
  cutOutSpeedMs: number;

  /** P8 — Water/ground depth at installation site (m). Offshore context. */
  siteDepthM: number;
}

/** Estimated Annual Energy Production in MWh (calculated, not stored). */
export function calcAEP(c: WindTurbineContract): number {
  // Danish offshore capacity factor ≈ 48 % (Danish Energy Agency 2023)
  const capacityFactor = 0.48;
  return Math.round(c.ratedPowerMW * 8760 * capacityFactor);
}

/** Estimated households powered per year (Danish avg: 4,000 kWh/household). */
export function calcHouseholds(c: WindTurbineContract): number {
  return Math.round((calcAEP(c) * 1000) / 4000);
}

export function createWindTurbine(
  base: [number, number, number],
  options?: Partial<Omit<WindTurbineContract, "id" | "kind" | "base">>
): WindTurbineContract {
  return {
    id: crypto.randomUUID(),
    kind: "windturbine",
    base,
    // Geometry
    towerHeight:    options?.towerHeight    ?? 20,
    bladeLength:    options?.bladeLength    ?? 10,
    numBlades:      options?.numBlades      ?? 3,
    rotationAngle:  options?.rotationAngle  ?? 0,
    // BIM Properties — defaults based on Siemens Gamesa SG 14-222 DD
    ratedPowerMW:   options?.ratedPowerMW   ?? 14,
    foundationType: options?.foundationType ?? "monopile",
    manufacturer:   options?.manufacturer   ?? "Siemens Gamesa",
    modelName:      options?.modelName      ?? "SG 14-222 DD",
    cutInSpeedMs:   options?.cutInSpeedMs   ?? 3,
    ratedSpeedMs:   options?.ratedSpeedMs   ?? 13,
    cutOutSpeedMs:  options?.cutOutSpeedMs  ?? 25,
    siteDepthM:     options?.siteDepthM     ?? 30,
  };
}

// ── Siemens Gamesa colour palette ─────────────────────────────────────────────

const C_TOWER   = 0xEAEAEA; // RAL 7035 light grey — tower shell
const C_NACELLE = 0xD8D8D8; // RAL 7036 platinum grey — nacelle body
const C_BLADE   = 0xEFEFEF; // IntegralBlade® off-white
const C_SPINNER = 0xDCDCDC; // nose-cone mid grey
const C_ROOT    = 0xC8C8C8; // blade root boot — slightly darker
const C_TIP     = 0xCC2222; // safety red tip marker

const C_FOUNDATION = 0xB0A898; // concrete / steel grey for foundations

const MAT: Record<string, THREE.MeshLambertMaterial> = {
  tower:      new THREE.MeshLambertMaterial({ color: C_TOWER }),
  nacelle:    new THREE.MeshLambertMaterial({ color: C_NACELLE }),
  blade:      new THREE.MeshLambertMaterial({ color: C_BLADE, side: THREE.DoubleSide }),
  spinner:    new THREE.MeshLambertMaterial({ color: C_SPINNER }),
  root:       new THREE.MeshLambertMaterial({ color: C_ROOT }),
  tip:        new THREE.MeshLambertMaterial({ color: C_TIP }),
  foundation: new THREE.MeshLambertMaterial({ color: C_FOUNDATION }),
};

// ── Geometry helpers ──────────────────────────────────────────────────────────

/** Tapered steel tower with monopile flare at base. */
function buildTower(h: number): THREE.BufferGeometry {
  const rb = h * 0.065;
  const rt = h * 0.030;
  const geo = new THREE.CylinderGeometry(rt, rb, h, 32, 1);
  geo.translate(0, h / 2, 0);
  const flare = new THREE.CylinderGeometry(rb * 1.25, rb * 1.4, h * 0.04, 32, 1);
  flare.translate(0, h * 0.02, 0);
  return mergeGeos([geo, flare]);
}

/** Foundation geometries — visually distinct per type. */
function buildFoundation(h: number, type: FoundationType): THREE.BufferGeometry {
  const rb = h * 0.065; // tower base radius

  if (type === "monopile") {
    // Single steel pile driven into seabed
    const pile = new THREE.CylinderGeometry(rb * 1.1, rb * 1.2, h * 0.5, 24);
    pile.translate(0, -h * 0.25, 0);
    return pile;
  }

  if (type === "tripod") {
    // Three diagonal legs spreading outward
    const parts: THREE.BufferGeometry[] = [];
    const legR   = rb * 0.35;
    const spread = h * 0.28;
    const legH   = h * 0.38;
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2;
      const leg = new THREE.CylinderGeometry(legR, legR * 1.1, legH, 10);
      leg.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 6));
      leg.applyMatrix4(new THREE.Matrix4().makeRotationY(angle));
      leg.translate(
        Math.sin(angle) * spread * 0.5,
        -legH * 0.3,
        Math.cos(angle) * spread * 0.5
      );
      parts.push(leg);
      // Foot pile
      const foot = new THREE.CylinderGeometry(legR * 0.9, legR, h * 0.15, 10);
      foot.translate(Math.sin(angle) * spread, -h * 0.3, Math.cos(angle) * spread);
      parts.push(foot);
    }
    // Central column stub
    const col = new THREE.CylinderGeometry(rb * 0.9, rb * 0.9, h * 0.12, 20);
    col.translate(0, -h * 0.06, 0);
    parts.push(col);
    return mergeGeos(parts);
  }

  if (type === "jacket") {
    // Four-legged lattice — simplified with cylinders
    const parts: THREE.BufferGeometry[] = [];
    const legR   = rb * 0.22;
    const topS   = rb * 1.4;   // top spread
    const botS   = rb * 3.2;   // bottom spread (wider at seabed)
    const jacketH = h * 0.55;
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const tx = Math.sin(angle) * topS, tz = Math.cos(angle) * topS;
      const bx = Math.sin(angle) * botS, bz = Math.cos(angle) * botS;
      // Diagonal leg (top to bottom)
      const dx = bx - tx, dz = bz - tz, dy = -jacketH;
      const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const leg = new THREE.CylinderGeometry(legR, legR, len, 8);
      const mid = new THREE.Vector3((tx+bx)/2, -jacketH/2, (tz+bz)/2);
      leg.translate(mid.x, mid.y, mid.z);
      const dir = new THREE.Vector3(dx, dy, dz).normalize();
      const axis = new THREE.Vector3(0,1,0).cross(dir).normalize();
      const ang  = Math.acos(new THREE.Vector3(0,1,0).dot(dir));
      if (axis.length() > 0.001) leg.applyMatrix4(new THREE.Matrix4().makeRotationAxis(axis, ang));
      parts.push(leg);
    }
    // Horizontal braces at 3 levels
    for (let lvl = 0; lvl < 3; lvl++) {
      const t   = (lvl + 0.5) / 3;
      const s   = topS + (botS - topS) * t;
      const y   = -jacketH * t;
      const brace = new THREE.CylinderGeometry(legR * 0.6, legR * 0.6, s * 2.83, 6);
      brace.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
      brace.translate(0, y, 0);
      parts.push(brace);
    }
    return mergeGeos(parts);
  }

  // gravity — wide concrete base sitting on seabed
  const cone = new THREE.CylinderGeometry(rb * 3.5, rb * 4.5, h * 0.08, 32);
  cone.translate(0, -h * 0.04, 0);
  const slab = new THREE.CylinderGeometry(rb * 4.5, rb * 4.5, h * 0.04, 32);
  slab.translate(0, -h * 0.10, 0);
  return mergeGeos([cone, slab]);
}

/** Streamlined nacelle — DD (direct-drive) proportions.
 *  Elongated box with rounded nose via a lathe cross-section cap. */
function buildNacelle(towerTopR: number): THREE.BufferGeometry {
  const w  = towerTopR * 3.8;   // width  (side-to-side)
  const h  = towerTopR * 2.4;   // height
  const dB = towerTopR * 8.0;   // body length (rear)
  const dN = towerTopR * 1.8;   // nose extension length

  // Main body — slightly tapered toward rear
  const body = new THREE.BoxGeometry(w, h, dB);
  body.translate(0, 0, -dB / 2 + dN / 2);

  // Rounded nose (half-ellipsoid approx via sphere + clip)
  const nose = new THREE.SphereGeometry(w * 0.52, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  nose.rotateX(-Math.PI / 2);
  nose.translate(0, 0, dN / 2);

  // Roof spine ridge (aerodynamic dorsal fin shape)
  const ridge = new THREE.BoxGeometry(w * 0.18, h * 0.22, dB * 0.85);
  ridge.translate(0, h / 2 + h * 0.11, -dB * 0.08);

  return mergeGeos([body, nose, ridge]);
}

/** Conical spinner — large, characteristic of Siemens Gamesa DD turbines. */
function buildSpinner(r: number): THREE.BufferGeometry {
  const geo = new THREE.ConeGeometry(r, r * 2.8, 24);
  geo.rotateX(Math.PI / 2);   // point forward (+Z)
  return geo;
}

/** Blade root cylinder (boot fairing). */
function buildBladeRoot(len: number, r: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(r, r * 1.15, len, 16);
  geo.translate(0, len / 2, 0);
  return geo;
}

/** Red safety tip band. */
function buildTipMarker(bladeLen: number): THREE.BufferGeometry {
  const tipLen = bladeLen * 0.06;
  const geo = new THREE.BoxGeometry(0.12, tipLen, 0.06);
  geo.translate(0, bladeLen - tipLen / 2, 0);
  return geo;
}

/**
 * Main blade geometry — NACA-inspired airfoil cross-section, tapering chord,
 * ~15° twist from root to tip, upward pre-bend (pre-deflection).
 */
function buildBlade(length: number): THREE.BufferGeometry {
  const SEGS = 16;                    // span-wise segments
  const PROF = 10;                    // profile points per side

  /** Simplified NACA 4-series upper/lower y at normalised x ∈ [0,1]. */
  function nacaY(x: number, t: number): number {
    return t / 0.2 * (
      0.2969 * Math.sqrt(x) -
      0.1260 * x -
      0.3516 * x * x +
      0.2843 * x * x * x -
      0.1015 * x * x * x * x
    );
  }

  /** Build one cross-section polygon (closed loop of 2*PROF points).
   *  chord: total chord width, t: max thickness ratio. */
  function sectionPoints(chord: number, t: number): [number, number][] {
    const pts: [number, number][] = [];
    // Upper surface  (x: LE→TE)
    for (let i = 0; i <= PROF; i++) {
      const x = i / PROF;
      pts.push([x * chord - chord / 2,  nacaY(x, t) * chord]);
    }
    // Lower surface (x: TE→LE)
    for (let i = PROF; i >= 0; i--) {
      const x = i / PROF;
      pts.push([x * chord - chord / 2, -nacaY(x, t) * chord * 0.6]);
    }
    return pts;
  }

  const positions: number[] = [];
  const normals:   number[] = [];

  function addTri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ) {
    const ab = new THREE.Vector3(bx - ax, by - ay, bz - az);
    const ac = new THREE.Vector3(cx - ax, cy - ay, cz - az);
    const n  = new THREE.Vector3().crossVectors(ab, ac).normalize();
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    normals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
  }

  // Root is cut off — blade starts after root cylinder
  const rootLen = length * 0.12;

  for (let si = 0; si < SEGS; si++) {
    const t0 = si / SEGS;
    const t1 = (si + 1) / SEGS;

    // Span positions (Y axis, blade extends upward before rotation)
    const y0 = rootLen + t0 * (length - rootLen);
    const y1 = rootLen + t1 * (length - rootLen);

    // Chord distribution: wide at root, narrow at tip (Betz optimum-inspired)
    const chord0 = length * (0.09 - 0.07 * t0);
    const chord1 = length * (0.09 - 0.07 * t1);

    // Thickness-to-chord ratio: thick at root, thin at tip
    const thick0 = 0.28 - 0.18 * t0;
    const thick1 = 0.28 - 0.18 * t1;

    // Twist: +15° at root → 0° at tip (leading edge faces upwind more at root)
    const twist0 = (15 * (1 - t0)) * Math.PI / 180;
    const twist1 = (15 * (1 - t1)) * Math.PI / 180;

    // Pre-bend: blade curves away from tower (forward in X)
    const bend0 = length * 0.08 * t0 * t0;
    const bend1 = length * 0.08 * t1 * t1;

    const sec0 = sectionPoints(chord0, thick0);
    const sec1 = sectionPoints(chord1, thick1);

    const nPts = sec0.length;

    // Transform section points to 3D world positions
    function xform(pts: [number, number][], y: number, twist: number, bend: number): THREE.Vector3[] {
      return pts.map(([px, pz]) => {
        const rx =  px * Math.cos(twist) - pz * Math.sin(twist);
        const rz =  px * Math.sin(twist) + pz * Math.cos(twist);
        return new THREE.Vector3(rx + bend, y, rz);
      });
    }

    const pts0 = xform(sec0, y0, twist0, bend0);
    const pts1 = xform(sec1, y1, twist1, bend1);

    // Connect cross-sections with quads → triangles
    for (let pi = 0; pi < nPts - 1; pi++) {
      const a = pts0[pi], b = pts0[pi + 1];
      const c = pts1[pi + 1], d = pts1[pi];
      addTri(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      addTri(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    }

    // Cap the leading / trailing edge loop
    const a = pts0[nPts - 1], b = pts0[0];
    const c = pts1[0], d = pts1[nPts - 1];
    addTri(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    addTri(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal",   new THREE.Float32BufferAttribute(normals,   3));
  return geo;
}

// ── Assemble all parts ────────────────────────────────────────────────────────

interface TurbinePart {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshLambertMaterial;
  geoHash: string;
}

function assembleTurbine(c: WindTurbineContract): TurbinePart[] {
  const { towerHeight: H, bladeLength: BL, numBlades, rotationAngle } = c;

  const towerTopR  = H * 0.030;
  const nacelleLen = towerTopR * 10;
  const spinnerR   = towerTopR * 2.2;
  const rootLen    = BL * 0.12;
  const rootR      = BL * 0.040;

  // Hub centre position (top of tower + half-nacelle height offset)
  const nacelleH     = towerTopR * 2.4;
  const hubY         = H + nacelleH * 0.5;
  const hubZ         = nacelleLen * 0.55;  // slightly forward of nacelle centre

  const parts: TurbinePart[] = [];

  // 0. Foundation (type-dependent geometry)
  const foundation = buildFoundation(H, c.foundationType ?? "monopile");
  parts.push({ geometry: foundation, material: MAT.foundation, geoHash: `foundation:${H}:${c.foundationType}` });

  // 1. Tower
  const tower = buildTower(H);
  parts.push({ geometry: tower, material: MAT.tower, geoHash: `tower:${H}` });

  // 2. Nacelle
  const nacelle = buildNacelle(towerTopR);
  nacelle.translate(0, hubY, 0);
  parts.push({ geometry: nacelle, material: MAT.nacelle, geoHash: `nacelle:${H}` });

  // 3. Spinner (nose cone)
  const spinner = buildSpinner(spinnerR);
  spinner.translate(0, hubY, hubZ + spinnerR);
  parts.push({ geometry: spinner, material: MAT.spinner, geoHash: `spinner:${H}` });

  // 4. Blades + root cylinders + tip markers
  for (let i = 0; i < numBlades; i++) {
    const angle = rotationAngle + (i / numBlades) * Math.PI * 2;
    const cosA = Math.cos(angle), sinA = Math.sin(angle);

    // Blade root cylinder
    const root = buildBladeRoot(rootLen, rootR);
    // Rotate root cylinder to blade direction
    root.applyMatrix4(new THREE.Matrix4().makeRotationZ(angle));
    root.translate(0, hubY, hubZ);
    parts.push({ geometry: root, material: MAT.root, geoHash: `root${i}:${H}:${angle}` });

    // Main blade
    const blade = buildBlade(BL);
    // Blade built along +Y; rotate around Z to point outward, then offset to hub
    blade.applyMatrix4(new THREE.Matrix4().makeRotationZ(angle));
    blade.translate(
      sinA * rootLen * 0.8,   // offset from hub centre (root starts outside spinner)
      hubY + cosA * rootLen * 0.8,
      hubZ
    );
    parts.push({ geometry: blade, material: MAT.blade, geoHash: `blade${i}:${BL}:${angle}` });

    // Tip marker
    const tip = buildTipMarker(BL);
    tip.applyMatrix4(new THREE.Matrix4().makeRotationZ(angle));
    tip.translate(
      sinA * (rootLen + BL) * 0.92,
      hubY + cosA * (rootLen + BL) * 0.92,
      hubZ
    );
    parts.push({ geometry: tip, material: MAT.tip, geoHash: `tip${i}:${BL}:${angle}` });
  }

  return parts;
}

// ── Element definition ────────────────────────────────────────────────────────

export const windturbineElement: ElementTypeDefinition = {
  kind: "windturbine",

  /** Material slots — shown in the Materials tab */
  materialSlots: ["tower", "nacelle", "blades", "foundation"],

  generateGeometry(_engine, contract) {
    const c = contract as WindTurbineContract;
    const parts = assembleTurbine(c);
    const t = new THREE.Matrix4().makeTranslation(...c.base);
    const geos = parts.map(p => { p.geometry.applyMatrix4(t); return p.geometry; });
    return mergeGeos(geos);
  },

  generateLocalGeometry(_engine, contract, doc) {
    const c = contract as WindTurbineContract;
    const parts = assembleTurbine(c);

    // Bake world position directly into each geometry — most robust approach
    const translation = new THREE.Matrix4().makeTranslation(...c.base);
    for (const p of parts) {
      p.geometry.applyMatrix4(translation);
    }

    // ── Resolve material overrides ──────────────────────────────────────────
    // Each part's geoHash starts with a slot prefix; use it to look up override.
    type MatSlot = "tower" | "nacelle" | "blades" | "foundation";
    const mats: Record<MatSlot, ContractId | undefined> = {
      tower:      c.materials?.tower,
      nacelle:    c.materials?.nacelle,
      blades:     c.materials?.blades,
      foundation: c.materials?.foundation,
    };
    const slotOf = (hash: string): MatSlot | null => {
      if (hash.startsWith("tower"))      return "tower";
      if (hash.startsWith("nacelle"))    return "nacelle";
      if (hash.startsWith("spinner"))    return "nacelle";   // spinner shares nacelle slot
      if (hash.startsWith("blade") || hash.startsWith("root") || hash.startsWith("tip")) return "blades";
      if (hash.startsWith("foundation")) return "foundation";
      return null;
    };

    return {
      worldTransform: new THREE.Matrix4(), // identity — position already baked in
      parts: parts.map(p => {
        const slot = slotOf(p.geoHash);
        const matId = slot ? mats[slot] : undefined;
        const resolvedMat = resolveMaterial(matId, doc, p.material);
        return {
          geometry: p.geometry,
          // unique hash per instance so fragment system doesn't share/override position
          geoHash:  `${p.geoHash}@${c.id}`,
          material: resolvedMat,
        };
      }),
    };
  },

  getRelationships() { return []; },

  getSnapPoints(contract) {
    const c = contract as WindTurbineContract;
    return [
      { position: new THREE.Vector3(...c.base),                                               type: "endpoint" as const },
      { position: new THREE.Vector3(c.base[0], c.base[1] + c.towerHeight, c.base[2]),        type: "endpoint" as const },
    ];
  },

  renderCustomProperties(contract, container, helpers) {
    const c = contract as WindTurbineContract;

    // ── Section header helper ─────────────────────────────────────
    const section = (title: string, color = "#cba6f7") => {
      const h = document.createElement("div");
      h.style.cssText = `font-size:11px; font-weight:700; color:${color};
        text-transform:uppercase; letter-spacing:1px;
        margin: 10px 0 4px; border-bottom: 1px solid #313244; padding-bottom:2px;`;
      h.textContent = title;
      container.appendChild(h);
    };

    const textField = (label: string, value: string, key: string) => {
      const wrap = document.createElement("label");
      wrap.textContent = label;
      const inp = document.createElement("input");
      inp.type = "text"; inp.value = value;
      inp.style.cssText = "width:100%; box-sizing:border-box;";
      inp.addEventListener("input", () =>
        helpers.debouncedUpdate(c.id, { [key]: inp.value }));
      wrap.appendChild(inp);
      container.appendChild(wrap);
    };

    const badge = (label: string, value: string, color = "#a6e3a1") => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin:3px 0;";
      const lbl = document.createElement("span");
      lbl.style.cssText = "font-size:12px; color:#cdd6f4;";
      lbl.textContent = label;
      const val = document.createElement("span");
      val.style.cssText = `font-size:12px; font-weight:700; color:${color};
        background:#313244; border-radius:4px; padding:1px 6px;`;
      val.textContent = value;
      row.appendChild(lbl); row.appendChild(val);
      container.appendChild(row);
    };

    // ── P1 & P2 — Geometry ────────────────────────────────────────
    section("📐 Geometry");
    helpers.addField(container, "Tower Height (m)", c.towerHeight,
      1, 5, 200, v => helpers.debouncedUpdate(c.id, { towerHeight: v }));
    helpers.addField(container, "Blade Length (m)", c.bladeLength,
      0.5, 2, 120, v => helpers.debouncedUpdate(c.id, { bladeLength: v }));
    badge("Rotor Diameter", `${(c.bladeLength * 2).toFixed(0)} m`, "#89b4fa");
    badge("Hub Height", `${(c.towerHeight + c.bladeLength * 0.065).toFixed(1)} m`, "#89b4fa");

    // ── P3 — Power ────────────────────────────────────────────────
    section("⚡ Power & Performance", "#f9e2af");
    helpers.addField(container, "Rated Power (MW)", c.ratedPowerMW,
      0.5, 0.5, 20, v => helpers.debouncedUpdate(c.id, { ratedPowerMW: v }));
    helpers.addField(container, "Cut-in Speed (m/s)", c.cutInSpeedMs,
      0.5, 1, 10, v => helpers.debouncedUpdate(c.id, { cutInSpeedMs: v }));
    helpers.addField(container, "Rated Speed (m/s)", c.ratedSpeedMs,
      0.5, 5, 20, v => helpers.debouncedUpdate(c.id, { ratedSpeedMs: v }));
    helpers.addField(container, "Cut-out Speed (m/s)", c.cutOutSpeedMs,
      1, 15, 40, v => helpers.debouncedUpdate(c.id, { cutOutSpeedMs: v }));
    // Calculated stats (read-only)
    badge("AEP (MWh/year)", calcAEP(c).toLocaleString(), "#a6e3a1");
    badge("Households powered", calcHouseholds(c).toLocaleString(), "#a6e3a1");

    // ── P4 — Foundation ───────────────────────────────────────────
    section("🏗️ Foundation", "#fab387");
    helpers.addSelectField(container, "Foundation Type",
      c.foundationType,
      [
        { id: "monopile", label: "Monopile — single steel pile (most common)" },
        { id: "tripod",   label: "Tripod — three-legged structure" },
        { id: "jacket",   label: "Jacket — lattice frame (deep water)" },
        { id: "gravity",  label: "Gravity — concrete base (shallow water)" },
      ],
      v => helpers.debouncedUpdate(c.id, { foundationType: v ?? "monopile" })
    );
    helpers.addField(container, "Site Water Depth (m)", c.siteDepthM,
      1, 5, 100, v => helpers.debouncedUpdate(c.id, { siteDepthM: v }));

    // ── P5 — Identity ─────────────────────────────────────────────
    section("🏷️ Manufacturer", "#cba6f7");
    textField("Manufacturer", c.manufacturer, "manufacturer");
    textField("Model Name",   c.modelName,    "modelName");

    // ── Materials ─────────────────────────────────────────────────
    section("🎨 Materials", "#89dceb");
    // Collect all material contracts from the document
    const matOptions: { id: string; label: string }[] = [];
    for (const [, contract] of helpers.doc.contracts) {
      if (contract.kind === "material") {
        matOptions.push({
          id: contract.id,
          label: (contract as any).name ?? contract.id.slice(0, 8),
        });
      }
    }
    const matSlots: Array<{ key: keyof NonNullable<WindTurbineContract["materials"]>; label: string }> = [
      { key: "tower",      label: "Tower" },
      { key: "nacelle",    label: "Nacelle & Spinner" },
      { key: "blades",     label: "Blades" },
      { key: "foundation", label: "Foundation" },
    ];
    for (const slot of matSlots) {
      helpers.addSelectField(
        container,
        slot.label,
        c.materials?.[slot.key] ?? null,
        matOptions,
        (v) => {
          const updated = { ...(c.materials ?? {}) };
          if (v) {
            updated[slot.key] = v as ContractId;
          } else {
            delete updated[slot.key];
          }
          helpers.debouncedUpdate(c.id, { materials: updated });
        }
      );
    }
    if (matOptions.length === 0) {
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:11px; color:#6c7086; margin:4px 0 8px;";
      hint.textContent = "No materials yet — create them in the Materials tab first.";
      container.appendChild(hint);
    }

    // ── Danish code reference ─────────────────────────────────────
    const note = document.createElement("div");
    note.style.cssText = `font-size:10px; color:#6c7086; margin-top:10px;
      border-top:1px solid #313244; padding-top:6px; line-height:1.5;`;
    note.innerHTML = `🇩🇰 <b>Danish Energy Agency</b><br>
      Offshore spacing: 5D cross-wind × 7D along-wind<br>
      Ref: Horns Rev 1/2 (Ørsted) — 560m @ D=80m`;
    container.appendChild(note);
  },

  applyTranslation(contract, delta) {
    const c = contract as WindTurbineContract;
    return {
      ...c,
      base: [c.base[0] + delta[0], c.base[1] + delta[1], c.base[2] + delta[2]] as [number, number, number],
    };
  },

  remapIds(contract) { return { ...contract }; },
};

// ── Utility: merge BufferGeometries ──────────────────────────────────────────

function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  for (const g of geos) {
    g.computeVertexNormals();
    total += (g.attributes.position as THREE.BufferAttribute).count;
  }

  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let off = 0;

  for (const g of geos) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const n = g.attributes.normal   as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      pos[(off + i) * 3]     = p.getX(i);
      pos[(off + i) * 3 + 1] = p.getY(i);
      pos[(off + i) * 3 + 2] = p.getZ(i);
      nor[(off + i) * 3]     = n.getX(i);
      nor[(off + i) * 3 + 1] = n.getY(i);
      nor[(off + i) * 3 + 2] = n.getZ(i);
    }
    off += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal",   new THREE.BufferAttribute(nor, 3));
  return out;
}
