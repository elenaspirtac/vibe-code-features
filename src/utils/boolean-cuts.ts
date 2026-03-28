import * as THREE from "three";
import type { GeometryEngine } from "@thatopen/fragments";
import type { ContractId } from "../core/contracts";
import type { BimDocument } from "../core/document";
import type { ElementRegistry } from "../core/registry";

// ── Types ─────────────────────────────────────────────────────────

export interface BooleanOperand {
  type: "DIFFERENCE" | "UNION";
  mesh: THREE.Mesh;
}

// ── Generic cut collection ────────────────────────────────────────

/**
 * Collect void geometry from elements that declare a "cuts" relationship
 * targeting this element. Uses the relationship graph — no hardcoded logic.
 *
 * Returns BooleanOperands ready to apply.
 */
export function collectGenericCuts(
  engine: GeometryEngine,
  targetId: ContractId,
  doc: BimDocument,
  registry: ElementRegistry
): BooleanOperand[] {
  const operands: BooleanOperand[] = [];

  // Scan all contracts for "cuts" relationships targeting us.
  // TODO: optimize with a reverse index if this becomes a bottleneck.
  for (const [, contract] of doc.contracts) {
    const rels = registry.getRelationships(contract, doc);
    for (const rel of rels) {
      if (rel.type === "cuts" && rel.targetId === targetId) {
        const def = registry.get(contract.kind);
        const voidMesh = def?.getVoidGeometry?.(engine, contract, doc);
        if (voidMesh) {
          operands.push({ type: "DIFFERENCE", mesh: voidMesh });
        }
        break; // one "cuts" per cutter is enough
      }
    }
  }

  return operands;
}

// ── Boolean application pipeline ──────────────────────────────────

/**
 * Apply a sequence of boolean operations to a base geometry.
 * Disposes intermediate geometries and operand meshes.
 *
 * Returns the final geometry (may be the original if no operands).
 */
export function applyBooleanOperands(
  engine: GeometryEngine,
  baseGeometry: THREE.BufferGeometry,
  operands: BooleanOperand[]
): THREE.BufferGeometry {
  if (operands.length === 0) return baseGeometry;

  let currentGeo = baseGeometry;

  for (const { type, mesh } of operands) {
    const targetMesh = new THREE.Mesh(currentGeo);
    targetMesh.updateMatrixWorld(true);

    const resultGeo = new THREE.BufferGeometry();
    engine.getBooleanOperation(resultGeo, {
      type,
      target: targetMesh,
      operands: [mesh],
    });

    currentGeo.dispose();
    mesh.geometry.dispose();
    currentGeo = resultGeo;
  }

  return currentGeo;
}
