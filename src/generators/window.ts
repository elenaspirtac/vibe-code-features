import * as THREE from "three";
import type { ResolvedWall } from "../elements/wall";
import type { ResolvedWindow } from "../elements/window";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";

const FRAME_DEPTH = 0.06; // frame thickness front-to-back
const FRAME_WIDTH = 0.05; // frame member width
const GLASS_THICKNESS = 0.006;

/**
 * Compute the world-space position and orientation of a window on its host wall.
 */
export function getWindowTransform(
  win: ResolvedWindow,
  wall: ResolvedWall
): { center: THREE.Vector3; normal: THREE.Vector3; along: THREE.Vector3 } {
  const s = new THREE.Vector3(...wall.start);
  const e = new THREE.Vector3(...wall.end);
  const along = new THREE.Vector3().subVectors(e, s);
  const center = new THREE.Vector3().lerpVectors(s, e, win.position);
  center.y = wall.start[1] + win.sillHeight + win.height / 2;

  const normal = new THREE.Vector3(-along.z, 0, along.x).normalize();
  const alongNorm = along.clone().normalize();

  return { center, normal, along: alongNorm };
}

/**
 * Generate window sub-geometries at origin (local space) + world transform.
 * Returns separate frame and glass parts for per-slot material assignment.
 */
export function generateWindowPartsLocal(
  win: ResolvedWindow,
  hostWall: ResolvedWall
): { frame: THREE.BufferGeometry; glass: THREE.BufferGeometry; worldTransform: THREE.Matrix4 } {
  const { center, normal, along } = getWindowTransform(win, hostWall);

  const hw = win.width / 2;
  const hh = win.height / 2;

  // Frame pieces in local space (centered at origin, facing +Z)
  const frameParts: THREE.BufferGeometry[] = [];
  frameParts.push(makeBox(win.width, FRAME_WIDTH, FRAME_DEPTH, 0, -hh + FRAME_WIDTH / 2, 0));
  frameParts.push(makeBox(win.width, FRAME_WIDTH, FRAME_DEPTH, 0, hh - FRAME_WIDTH / 2, 0));
  frameParts.push(makeBox(FRAME_WIDTH, win.height, FRAME_DEPTH, -hw + FRAME_WIDTH / 2, 0, 0));
  frameParts.push(makeBox(FRAME_WIDTH, win.height, FRAME_DEPTH, hw - FRAME_WIDTH / 2, 0, 0));
  const frame = BufferGeometryUtils.mergeGeometries(frameParts);
  for (const p of frameParts) p.dispose();

  // Glass pane
  const glassW = win.width - FRAME_WIDTH * 2;
  const glassH = win.height - FRAME_WIDTH * 2;
  const glass = makeBox(glassW, glassH, GLASS_THICKNESS, 0, 0, 0);

  const worldTransform = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  worldTransform.makeBasis(along, up, normal);
  worldTransform.setPosition(center);

  return { frame, glass, worldTransform };
}

/**
 * Generate merged window geometry at origin (local space) + world transform.
 * Convenience wrapper for overlay/world-space use.
 */
export function generateWindowGeometryLocal(
  win: ResolvedWindow,
  hostWall: ResolvedWall
): { geometry: THREE.BufferGeometry; worldTransform: THREE.Matrix4 } {
  const { frame, glass, worldTransform } = generateWindowPartsLocal(win, hostWall);
  const geometry = BufferGeometryUtils.mergeGeometries([frame, glass]);
  frame.dispose();
  glass.dispose();
  return { geometry, worldTransform };
}

/**
 * Generate window geometry (frame + glass pane) positioned in world space.
 */
export function generateWindowGeometry(
  win: ResolvedWindow,
  hostWall: ResolvedWall
): THREE.BufferGeometry {
  const { geometry, worldTransform } = generateWindowGeometryLocal(win, hostWall);
  geometry.applyMatrix4(worldTransform);
  return geometry;
}

/**
 * Generate the void box used for boolean-cutting the host wall.
 */
export function generateWindowVoid(
  win: ResolvedWindow,
  hostWall: ResolvedWall
): THREE.Mesh {
  const { center, normal, along } = getWindowTransform(win, hostWall);
  const depth = hostWall.thickness + 0.1; // wider than wall for clean cut

  const geo = new THREE.BoxGeometry(win.width, win.height, depth);
  const mesh = new THREE.Mesh(geo);

  // Orient the void: local X→along, local Y→up, local Z→normal
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
