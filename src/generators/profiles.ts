import * as THREE from "three";
import type { GeometryEngine } from "@thatopen/fragments";

// ---------------------------------------------------------------------------
// Profile point generators
// ---------------------------------------------------------------------------
// Each returns a flat array of 3D points [x1,y1,z1, x2,y2,z2, ...]
// lying in the XZ plane (Y=0), centered at the origin.
// These are ready to pass to engine.getExtrusion({ profilePoints }).
// ---------------------------------------------------------------------------

/**
 * Rectangular profile centered at origin, in the XZ plane.
 *
 * ```
 *   (-w/2, 0, -d/2) ---- (w/2, 0, -d/2)
 *         |                      |
 *   (-w/2, 0,  d/2) ---- (w/2, 0,  d/2)
 * ```
 */
export function rectangleProfile(width: number, depth: number): number[] {
  const hw = width / 2;
  const hd = depth / 2;
  // CCW when viewed from above (+Y)
  return [
    -hw, 0, -hd,
     hw, 0, -hd,
     hw, 0,  hd,
    -hw, 0,  hd,
  ];
}

/**
 * Circular profile centered at origin, in the XZ plane.
 * @param radius - Circle radius
 * @param segments - Number of segments (default 24)
 */
export function circleProfile(radius: number, segments = 24): number[] {
  const pts: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    pts.push(
      Math.cos(angle) * radius,
      0,
      Math.sin(angle) * radius
    );
  }
  return pts;
}

/**
 * L-shaped angle profile, in the XZ plane.
 * One leg along +X, one along +Z, corner at origin.
 *
 * ```
 *  (0,0,h)
 *    |  |
 *    |  (t,0,t)
 *    |       |
 *  (0,0,0)--(w,0,0)
 * ```
 *
 * @param width - Horizontal leg length
 * @param height - Vertical leg length
 * @param thickness - Leg thickness
 */
export function lProfile(
  width: number,
  height: number,
  thickness: number
): number[] {
  // CCW outline of the L
  return [
    0, 0, 0,
    width, 0, 0,
    width, 0, thickness,
    thickness, 0, thickness,
    thickness, 0, height,
    0, 0, height,
  ];
}

/**
 * T-shaped profile, centered horizontally, in the XZ plane.
 *
 * @param flangeWidth - Total width of the top flange
 * @param depth - Total depth (flange + web)
 * @param flangeThickness - Thickness of the horizontal flange
 * @param webThickness - Thickness of the vertical web
 */
export function tProfile(
  flangeWidth: number,
  depth: number,
  flangeThickness: number,
  webThickness: number
): number[] {
  const hw = flangeWidth / 2;
  const hweb = webThickness / 2;
  // CCW outline
  return [
    -hw,   0, depth,
     hw,   0, depth,
     hw,   0, depth - flangeThickness,
     hweb, 0, depth - flangeThickness,
     hweb, 0, 0,
    -hweb, 0, 0,
    -hweb, 0, depth - flangeThickness,
    -hw,   0, depth - flangeThickness,
  ];
}

/**
 * C-shaped channel profile, in the XZ plane.
 *
 * @param width - Overall width (flange length)
 * @param depth - Overall depth
 * @param flangeThickness - Thickness of top/bottom flanges
 * @param webThickness - Thickness of the vertical web
 */
export function cProfile(
  width: number,
  depth: number,
  flangeThickness: number,
  webThickness: number
): number[] {
  // CCW outline of C (open on the right side)
  return [
    0, 0, 0,
    width, 0, 0,
    width, 0, flangeThickness,
    webThickness, 0, flangeThickness,
    webThickness, 0, depth - flangeThickness,
    width, 0, depth - flangeThickness,
    width, 0, depth,
    0, 0, depth,
  ];
}

/**
 * H/I-beam profile (symmetric), in the XZ plane, centered at origin.
 *
 * @param flangeWidth - Total flange width
 * @param depth - Total depth (height of cross section)
 * @param flangeThickness - Thickness of each flange
 * @param webThickness - Thickness of the web
 */
export function hProfile(
  flangeWidth: number,
  depth: number,
  flangeThickness: number,
  webThickness: number
): number[] {
  const hw = flangeWidth / 2;
  const hd = depth / 2;
  const hweb = webThickness / 2;
  const ft = flangeThickness;
  // CCW outline
  return [
    -hw,   0, -hd,
     hw,   0, -hd,
     hw,   0, -hd + ft,
     hweb, 0, -hd + ft,
     hweb, 0,  hd - ft,
     hw,   0,  hd - ft,
     hw,   0,  hd,
    -hw,   0,  hd,
    -hw,   0,  hd - ft,
    -hweb, 0,  hd - ft,
    -hweb, 0, -hd + ft,
    -hw,   0, -hd + ft,
  ];
}

// ---------------------------------------------------------------------------
// Custom profile from 2D points
// ---------------------------------------------------------------------------

/**
 * Convert an array of 2D points [x, z] into a flat 3D profile array
 * in the XZ plane (Y=0). Useful for arbitrary custom cross-sections.
 *
 * @param points - Array of [x, z] pairs defining the profile outline (CCW)
 */
export function customProfile(points: [number, number][]): number[] {
  const flat: number[] = [];
  for (const [x, z] of points) {
    flat.push(x, 0, z);
  }
  return flat;
}

// ---------------------------------------------------------------------------
// High-level extrusion helper
// ---------------------------------------------------------------------------

export interface ExtrudeProfileOptions {
  /** Flat 3D profile points in the XZ plane (use the profile generators above) */
  profile: number[];
  /** World position to place the extrusion base at */
  position: [number, number, number];
  /** Extrusion direction in world space (default: [0, 1, 0] = up) */
  direction?: [number, number, number];
  /** Extrusion length */
  length: number;
  /** Cap both ends? (default: true) */
  cap?: boolean;
  /** Optional hole profiles (each is a flat 3D point array, CCW) */
  holes?: number[][];
}

/**
 * High-level profile extrusion: generates geometry from a 2D profile +
 * direction + length, positioned in world space.
 *
 * Uses `engine.getExtrusion()` (WASM) with a Three.js `ExtrudeGeometry` fallback.
 *
 * Example — rectangular column:
 * ```ts
 * const geo = extrudeProfile(engine, {
 *   profile: rectangleProfile(0.3, 0.3),
 *   position: [5, 0, 3],
 *   direction: [0, 1, 0],
 *   length: 3.0,
 * });
 * ```
 *
 * Example — circular pipe:
 * ```ts
 * const geo = extrudeProfile(engine, {
 *   profile: circleProfile(0.15),
 *   position: [0, 0, 0],
 *   direction: [1, 0, 0],  // horizontal
 *   length: 5.0,
 * });
 * ```
 *
 * Example — H-beam:
 * ```ts
 * const geo = extrudeProfile(engine, {
 *   profile: hProfile(0.3, 0.5, 0.02, 0.015),
 *   position: [0, 0, 0],
 *   direction: [1, 0, 0],  // horizontal beam
 *   length: 6.0,
 * });
 * ```
 */
export function extrudeProfile(
  engine: GeometryEngine,
  opts: ExtrudeProfileOptions
): THREE.BufferGeometry {
  const {
    profile,
    position,
    direction = [0, 1, 0],
    length,
    cap = true,
    holes,
  } = opts;

  try {
    const geometry = new THREE.BufferGeometry();
    engine.getExtrusion(geometry, {
      profilePoints: profile,
      direction,
      length,
      cap,
      profileHoles: holes,
    });

    const posAttr = geometry.getAttribute("position");
    if (posAttr && posAttr.count >= 3) {
      geometry.translate(position[0], position[1], position[2]);
      return geometry;
    }
    geometry.dispose();
  } catch {
    // Fall through to Three.js fallback
  }

  return extrudeProfileFallback(profile, position, direction, length);
}

// ---------------------------------------------------------------------------
// Fallback: Three.js ExtrudeGeometry
// ---------------------------------------------------------------------------

function extrudeProfileFallback(
  profile: number[],
  position: [number, number, number],
  direction: [number, number, number],
  length: number
): THREE.BufferGeometry {
  // Extract X,Z from the profile (ignore Y=0)
  const shape = new THREE.Shape();
  shape.moveTo(profile[0], profile[2]);
  for (let i = 3; i < profile.length; i += 3) {
    shape.lineTo(profile[i], profile[i + 2]);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: false,
  });

  // ExtrudeGeometry extrudes along +Z in shape space (shape is in XZ of
  // profile = XY of the Shape). We need to rotate so the extrusion aligns
  // with the requested world direction.

  // Shape lives in XY plane, extruded along Z.
  // Profile was in XZ (Y=0) → Shape used (X, Z) as (x, y).
  // So Shape XY = profile XZ, extrusion = Shape Z = profile Y direction.
  // We need to rotate from (0,1,0) → direction after correcting the axis swap.

  // Default: extrusion goes along (0,0,1) in Shape space.
  // After rotating shape XY → world XZ: extrusion goes along (0,1,0).
  geo.rotateX(-Math.PI / 2);

  // Now extrusion is along +Y. Rotate to match requested direction.
  const dir = new THREE.Vector3(...direction).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  if (dir.distanceTo(up) > 1e-6) {
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
    geo.applyQuaternion(quat);
  }

  geo.translate(position[0], position[1], position[2]);
  return geo;
}
