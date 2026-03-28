import * as THREE from "three";
import type { GeometryEngine } from "@thatopen/fragments";
import type { FloorContract } from "../elements/floor";
import type { BimDocument } from "../core/document";

/**
 * Resolve boundary vertices to world-space coordinates.
 * Uses the registry's getEndpointPosition hook so any element type
 * with declared endpoints can serve as a floor boundary reference.
 * Returns null if any reference is unresolvable.
 */
export function resolveBoundary(
  contract: FloorContract,
  doc: BimDocument
): [number, number, number][] | null {
  const points: [number, number, number][] = [];
  for (const v of contract.boundary) {
    if (v.type === "free") {
      points.push(v.position);
    } else {
      const ref = doc.contracts.get(v.wallId);
      if (!ref) return null;
      const def = doc.registry?.get(ref.kind);
      const pos = def?.getEndpointPosition?.(ref, v.endpoint, doc);
      if (!pos) return null;
      points.push(pos);
    }
  }
  return points;
}

/**
 * Compute signed area of a polygon projected onto XZ plane.
 * Positive = CCW when viewed from above (Y+).
 */
function signedArea2D(points: [number, number, number][]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i][0] * points[j][2] - points[j][0] * points[i][2];
  }
  return area / 2;
}

export function generateFloorGeometry(
  engine: GeometryEngine,
  contract: FloorContract,
  doc: BimDocument
): THREE.BufferGeometry {
  const points = resolveBoundary(contract, doc);
  if (!points || points.length < 3) {
    return new THREE.BufferGeometry();
  }

  // Ensure CCW winding (positive signed area) for extrusion
  if (signedArea2D(points) < 0) {
    points.reverse();
  }

  // Build flat 3D profile in XZ plane (Y=0)
  const profilePoints: number[] = [];
  for (const [x, , z] of points) {
    profilePoints.push(x, 0, z);
  }

  try {
    const geometry = new THREE.BufferGeometry();
    engine.getExtrusion(geometry, {
      profilePoints,
      direction: [0, -1, 0],
      length: contract.thickness,
      cap: true,
    });

    // Translate to correct elevation
    if (contract.elevation !== 0) {
      geometry.translate(0, contract.elevation, 0);
    }

    const posAttr = geometry.getAttribute("position");
    if (posAttr && posAttr.count >= 3) {
      return geometry;
    }
    geometry.dispose();
  } catch {
    // Fall through to Three.js fallback
  }

  return generateFloorFallback(points, contract);
}

function generateFloorFallback(
  points: [number, number, number][],
  contract: FloorContract
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][2]);
  for (let i = 1; i < points.length; i++) {
    shape.lineTo(points[i][0], points[i][2]);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: contract.thickness,
    bevelEnabled: false,
  });

  // ExtrudeGeometry extrudes along +Z in shape space.
  // Rotate so shape XY → world XZ, extrusion Z → world -Y.
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, contract.elevation, 0);

  return geo;
}
