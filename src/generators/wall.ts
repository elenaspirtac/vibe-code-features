import * as THREE from "three";
import type { GeometryEngine } from "@thatopen/fragments";
import type { ResolvedWall } from "../elements/wall";

/** Info about a neighbor wall at a specific endpoint, used for miter cuts. */
export interface MiterNeighbor {
  endpoint: "start" | "end";
  neighbor: ResolvedWall;
}

/** T-junction butt joint: the joining wall is trimmed at the receiving wall's face. */
export interface TJunctionHost {
  endpoint: "start" | "end";
  /** The receiving wall this endpoint butts against. */
  host: ResolvedWall;
}

/**
 * Pure function: WallContract → THREE.BufferGeometry (base geometry only).
 *
 * Generates the wall body with joint extensions (miter + T-junction) but
 * WITHOUT boolean cuts. Boolean operations (miter cuts, T-junction trims,
 * window voids, ad-hoc cuts) are applied by the registry's boolean pipeline
 * via `getBooleanOperands` + `collectGenericCuts`.
 */
export function generateWallGeometry(
  engine: GeometryEngine,
  contract: ResolvedWall,
  miterNeighbors?: MiterNeighbor[],
  tJunctions?: TJunctionHost[]
): THREE.BufferGeometry {
  // Compute extended start/end so the wall fills the corner before the cut
  const extStart = new THREE.Vector3(...contract.start);
  const extEnd = new THREE.Vector3(...contract.end);

  const wallDir = new THREE.Vector3()
    .subVectors(extEnd, extStart)
    .normalize();

  if (miterNeighbors && miterNeighbors.length > 0) {
    for (const { endpoint, neighbor } of miterNeighbors) {
      const ext = computeJointExtension(contract, endpoint, neighbor);
      if (ext <= 0) continue;
      if (endpoint === "start") {
        extStart.addScaledVector(wallDir, -ext);
      } else {
        extEnd.addScaledVector(wallDir, ext);
      }
    }
  }

  // Extend endpoints past receiving wall so boolean cut has material to trim
  if (tJunctions && tJunctions.length > 0) {
    for (const { endpoint, host } of tJunctions) {
      const ext = host.thickness / 2 + 0.01; // slightly past the far face
      if (endpoint === "start") {
        extStart.addScaledVector(wallDir, -ext);
      } else {
        extEnd.addScaledVector(wallDir, ext);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  const baseElevation = contract.start[1];
  engine.getWall(geometry, {
    start: [extStart.x, extStart.y, extStart.z],
    end: [extEnd.x, extEnd.y, extEnd.z],
    height: contract.height,
    thickness: contract.thickness,
    offset: contract.offset,
    elevation: baseElevation,
    direction: [0, 1, 0],
  });

  return geometry;
}

/**
 * Compute how far to extend a wall past the joint so the miter cut
 * creates a flush diagonal. For angle θ between walls:
 *   extension = (thickness / 2) / tan(θ / 2)
 * For 90° → extension = thickness / 2.
 */
export function computeJointExtension(
  wall: ResolvedWall,
  endpoint: "start" | "end",
  neighbor: ResolvedWall
): number {
  const jointPt =
    endpoint === "start"
      ? new THREE.Vector3(...wall.start)
      : new THREE.Vector3(...wall.end);

  const wallStart = new THREE.Vector3(...wall.start);
  const wallEnd = new THREE.Vector3(...wall.end);
  const wallDir = new THREE.Vector3()
    .subVectors(wallEnd, wallStart)
    .normalize();
  const awayA =
    endpoint === "start" ? wallDir.clone() : wallDir.clone().negate();

  const nStart = new THREE.Vector3(...neighbor.start);
  const nEnd = new THREE.Vector3(...neighbor.end);
  const nDir = new THREE.Vector3().subVectors(nEnd, nStart).normalize();
  const nStartDist = jointPt.distanceTo(nStart);
  const awayB = nStartDist < 0.01 ? nDir.clone() : nDir.clone().negate();

  // Angle between the two wall directions
  const cosAngle = awayA.dot(awayB);
  // Clamp to avoid numerical issues
  const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));

  // Skip when near-parallel (< ~10°) or near-collinear (> ~170°)
  if (angle < 0.15 || angle > Math.PI - 0.15) return 0;

  const halfAngle = angle / 2;
  return (wall.thickness / 2) / Math.tan(halfAngle);
}

/**
 * Build a large box mesh that cuts the excess wall thickness at a miter joint.
 *
 * The miter line runs ALONG the bisector of the two wall directions.
 * The cutting plane is vertical and contains the bisector, so its normal
 * is perpendicular to the bisector in the horizontal plane.
 * Each wall's excess thickness (the part overlapping the neighbor) is on
 * the neighbor's side of this plane.
 */
/**
 * Build a cutting box that removes the part of the joining wall that
 * overlaps with the receiving (host) wall. The cutting plane is the
 * host wall's near face (the face closest to the joining wall).
 *
 * Works for any angle between the two walls.
 */
export function buildTJunctionCutBox(
  joiningWall: ResolvedWall,
  endpoint: "start" | "end",
  joiningDir: THREE.Vector3,
  host: ResolvedWall
): THREE.Mesh | null {
  // The joining wall's endpoint is on the host's centerline
  const junctionPt =
    endpoint === "start"
      ? new THREE.Vector3(...joiningWall.start)
      : new THREE.Vector3(...joiningWall.end);

  // Host wall direction and normal
  const hStart = new THREE.Vector3(...host.start);
  const hEnd = new THREE.Vector3(...host.end);
  const hDir = new THREE.Vector3().subVectors(hEnd, hStart).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const hNormal = new THREE.Vector3().crossVectors(hDir, up).normalize();

  // Figure out which side the joining wall approaches from:
  // the "toward" direction is the joining wall going INTO the junction
  const toward =
    endpoint === "start"
      ? joiningDir.clone().negate() // wall goes start→end, so toward start is -wallDir
      : joiningDir.clone();

  // The near face is on the side the joining wall comes from
  const side = Math.sign(toward.dot(hNormal));
  if (side === 0) return null;

  // Near face normal points toward the joining wall's body (outward from host)
  const nearFaceNormal = hNormal.clone().multiplyScalar(-side);

  // Near face position: offset from centerline by thickness/2
  const nearFaceCenter = junctionPt
    .clone()
    .addScaledVector(nearFaceNormal, host.thickness / 2);

  // The cut box sits on the host's side of the near face.
  // cutDir points INTO the host (opposite of nearFaceNormal)
  const cutDir = nearFaceNormal.clone().negate();

  const boxSize = Math.max(joiningWall.height, joiningWall.thickness, host.thickness) * 4;
  const boxGeo = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
  const boxMesh = new THREE.Mesh(boxGeo);

  // Orient: align box local +Z with cutDir
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    cutDir
  );
  boxMesh.quaternion.copy(quat);

  // Position: box center offset so the -Z face sits at the near face
  boxMesh.position.copy(nearFaceCenter).addScaledVector(cutDir, boxSize / 2);
  boxMesh.position.y = joiningWall.start[1] + joiningWall.height / 2;

  boxMesh.updateMatrixWorld(true);
  return boxMesh;
}

export function buildMiterCutBox(
  wall: ResolvedWall,
  endpoint: "start" | "end",
  neighbor: ResolvedWall
): THREE.Mesh | null {
  const jointPt =
    endpoint === "start"
      ? new THREE.Vector3(...wall.start)
      : new THREE.Vector3(...wall.end);

  // Direction of THIS wall pointing AWAY from the joint
  const wallStart = new THREE.Vector3(...wall.start);
  const wallEnd = new THREE.Vector3(...wall.end);
  const wallDir = new THREE.Vector3()
    .subVectors(wallEnd, wallStart)
    .normalize();
  const awayA =
    endpoint === "start" ? wallDir.clone() : wallDir.clone().negate();

  // Direction of NEIGHBOR wall pointing AWAY from the joint
  const nStart = new THREE.Vector3(...neighbor.start);
  const nEnd = new THREE.Vector3(...neighbor.end);
  const nDir = new THREE.Vector3().subVectors(nEnd, nStart).normalize();
  const nStartDist = jointPt.distanceTo(nStart);
  const awayB = nStartDist < 0.01 ? nDir.clone() : nDir.clone().negate();

  // Angle between the two "away" directions.
  // 0° = walls overlap (parallel same dir) — degenerate
  // 90° = L-shape — normal miter
  // 180° = collinear (straight line) — no miter needed
  const cosAngle = awayA.dot(awayB);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
  // Skip when near-parallel (< ~10°) or near-collinear (> ~170°)
  if (angle < 0.15 || angle > Math.PI - 0.15) return null;

  // Bisector: average of the two "away" directions (runs along the miter line)
  const bisector = new THREE.Vector3()
    .addVectors(awayA, awayB)
    .normalize();

  // If walls are parallel (bisector is zero), skip
  if (bisector.length() < 0.01) return null;

  // The cutting plane contains the bisector and the vertical (Y) axis.
  // Its normal is perpendicular to both → cross(bisector, Y).
  const up = new THREE.Vector3(0, 1, 0);
  const planeNormal = new THREE.Vector3()
    .crossVectors(bisector, up)
    .normalize();

  if (planeNormal.length() < 0.01) return null;

  // Determine which side of the cutting plane the neighbor is on.
  // We cut the excess on the neighbor's side.
  const side = Math.sign(awayB.dot(planeNormal));
  if (side === 0) return null;
  const cutDir = planeNormal.clone().multiplyScalar(side);

  // Build a large cutting box
  const boxSize = Math.max(wall.height, wall.thickness) * 4;
  const boxGeo = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
  const boxMesh = new THREE.Mesh(boxGeo);

  // Orient: align box local +Z with cutDir
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    cutDir
  );
  boxMesh.quaternion.copy(quat);

  // Position: box center offset in cutDir so the -Z face sits at the joint
  boxMesh.position
    .copy(jointPt)
    .addScaledVector(cutDir, boxSize / 2);
  // Center vertically on the wall (base at start Y)
  boxMesh.position.y = wall.start[1] + wall.height / 2;

  boxMesh.updateMatrixWorld(true);
  return boxMesh;
}

