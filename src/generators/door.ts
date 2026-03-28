import * as THREE from "three";
import type { ResolvedWall } from "../elements/wall";
import type { ResolvedDoor } from "../elements/door";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";

const FRAME_DEPTH = 0.07;  // frame thickness front-to-back
const FRAME_WIDTH = 0.08;  // frame member width
const PANEL_THICKNESS = 0.03;

/**
 * Compute the world-space position and orientation of a door on its host wall.
 * Door is placed at floor level (sillHeight = 0).
 */
export function getDoorTransform(
  door: ResolvedDoor,
  wall: ResolvedWall
): { center: THREE.Vector3; normal: THREE.Vector3; along: THREE.Vector3 } {
  const s = new THREE.Vector3(...wall.start);
  const e = new THREE.Vector3(...wall.end);
  const along = new THREE.Vector3().subVectors(e, s);
  const center = new THREE.Vector3().lerpVectors(s, e, door.position);
  center.y = wall.start[1] + door.height / 2;

  const normal = new THREE.Vector3(-along.z, 0, along.x).normalize();
  const alongNorm = along.clone().normalize();

  return { center, normal, along: alongNorm };
}

/**
 * Generate door sub-geometries at origin (local space) + world transform.
 * Returns separate frame and panel parts for per-slot material assignment.
 */
export function generateDoorPartsLocal(
  door: ResolvedDoor,
  hostWall: ResolvedWall
): { frame: THREE.BufferGeometry; panel: THREE.BufferGeometry; worldTransform: THREE.Matrix4; frameDepth: number } {
  const { center, normal, along } = getDoorTransform(door, hostWall);

  const hw = door.width / 2;
  const hh = door.height / 2;
  const frameDepth = hostWall.thickness + 0.04;

  // Frame: head + two jambs
  const frameParts: THREE.BufferGeometry[] = [];
  frameParts.push(makeBox(door.width, FRAME_WIDTH, frameDepth, 0, hh - FRAME_WIDTH / 2, 0));
  frameParts.push(makeBox(FRAME_WIDTH, door.height, frameDepth, -hw + FRAME_WIDTH / 2, 0, 0));
  frameParts.push(makeBox(FRAME_WIDTH, door.height, frameDepth, hw - FRAME_WIDTH / 2, 0, 0));
  const frame = BufferGeometryUtils.mergeGeometries(frameParts);
  for (const p of frameParts) p.dispose();

  // Panel
  const panelWidth = door.width - FRAME_WIDTH * 2;
  const panelHeight = door.height - FRAME_WIDTH;
  const panel = makeBox(panelWidth, panelHeight, PANEL_THICKNESS, 0, -FRAME_WIDTH / 2, 0);

  const worldTransform = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  worldTransform.makeBasis(along, up, normal);
  worldTransform.setPosition(center);

  return { frame, panel, worldTransform, frameDepth };
}

/**
 * Generate merged door geometry at origin (local space) + world transform.
 * Convenience wrapper for overlay/world-space use.
 */
export function generateDoorGeometryLocal(
  door: ResolvedDoor,
  hostWall: ResolvedWall
): { geometry: THREE.BufferGeometry; worldTransform: THREE.Matrix4 } {
  const { frame, panel, worldTransform } = generateDoorPartsLocal(door, hostWall);
  const geometry = BufferGeometryUtils.mergeGeometries([frame, panel]);
  frame.dispose();
  panel.dispose();
  return { geometry, worldTransform };
}

export function generateDoorGeometry(
  door: ResolvedDoor,
  hostWall: ResolvedWall
): THREE.BufferGeometry {
  const { geometry, worldTransform } = generateDoorGeometryLocal(door, hostWall);
  geometry.applyMatrix4(worldTransform);
  return geometry;
}

/**
 * Generate the void box used for boolean-cutting the host wall.
 */
export function generateDoorVoid(
  door: ResolvedDoor,
  hostWall: ResolvedWall
): THREE.Mesh {
  const { center, normal, along } = getDoorTransform(door, hostWall);
  const depth = hostWall.thickness + 0.1; // wider than wall for clean cut

  // Inner opening: between jambs and below head.
  // Frame edges remain visible on the wall face.
  const innerW = door.width - FRAME_WIDTH * 2;
  const innerH = door.height - FRAME_WIDTH;
  const geo = new THREE.BoxGeometry(innerW, innerH, depth);
  // Shift down so the void bottom stays at floor level (frame has no bottom sill)
  geo.translate(0, -FRAME_WIDTH / 2, 0);
  const mesh = new THREE.Mesh(geo);

  const up = new THREE.Vector3(0, 1, 0);
  const mat = new THREE.Matrix4();
  mat.makeBasis(along, up, normal);
  mat.setPosition(center);
  mesh.applyMatrix4(mat);
  mesh.updateMatrixWorld(true);

  return mesh;
}

function makeBox(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y, z);
  return geo;
}
