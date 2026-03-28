/**
 * Wind Farm Generator
 * Places a grid of wind turbines — offshore wind farm layout.
 * Turbines are spaced ~7× rotor diameter apart (industry standard).
 */
import * as THREE from "three";
import type { BimDocument } from "../core/document";
import { createWindTurbine } from "../elements/generated/windturbine";

export interface WindFarmOptions {
  rows?: number;
  cols?: number;
  spacingX?: number;
  spacingZ?: number;
  elevation?: number;
  towerHeight?: number;
  bladeLength?: number;
  staggerRows?: boolean;
}

export function generateWindFarm(
  doc: BimDocument,
  camera: THREE.PerspectiveCamera,
  controls: any,
  opts: WindFarmOptions = {}
) {
  const {
    rows        = 10,
    cols        = 10,
    elevation   = 0,
    towerHeight = 20,
    bladeLength = 10,
    staggerRows = false,
  } = opts;

  // ── Danish offshore spacing — Horns Rev standard ──────────────────────────
  // Source: Horns Rev 1/2 (Ørsted) & Danish Energy Agency guidelines
  // Rule: 5D cross-wind × 7D along prevailing wind (SW in Denmark)
  // D = rotor diameter = bladeLength × 2
  const rotorDiameter = bladeLength * 2;
  const spacingX = opts.spacingX ?? rotorDiameter * 5;   // cross-wind:  5D
  const spacingZ = opts.spacingZ ?? rotorDiameter * 7;   // along-wind:  7D (SW prevailing)

  // Centre the farm on the scene origin
  const totalW = (cols - 1) * spacingX;
  const totalD = (rows - 1) * spacingZ;
  const originX = -totalW / 2;
  const originZ = -totalD / 2;

  doc.transaction(() => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const stagger = staggerRows && r % 2 === 1 ? spacingX / 2 : 0;
        const x = originX + c * spacingX + stagger;
        const z = originZ + r * spacingZ;
        const yaw = (Math.random() - 0.5) * 0.3;

        const turbine = createWindTurbine([x, elevation, z], {
          towerHeight,
          bladeLength,
          rotationAngle: yaw,
        });
        doc.add(turbine);
      }
    }
  });

  // ── Auto-zoom camera to see the full farm ─────────────────────────────────
  const farmDiagonal = Math.sqrt(totalW * totalW + totalD * totalD) + bladeLength * 2;
  const camDist  = Math.max(farmDiagonal * 1.2, towerHeight * 2.5);
  const camHeight = towerHeight * 2.0;

  camera.position.set(camDist * 0.7, camHeight, camDist * 0.7);
  camera.lookAt(0, towerHeight * 0.4, 0);

  if (controls?.target) {
    controls.target.set(0, towerHeight * 0.4, 0);
    controls.update();
  }

  return rows * cols;
}
