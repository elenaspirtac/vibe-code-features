import type { BimDocument } from "../core/document";
import type { AnyContract, ContractId } from "../core/contracts";

export interface JointMember {
  id: ContractId;
  endpoint: string; // e.g. "start", "end" — matches LinearEdge.startId/endId
}

export interface Joint {
  point: [number, number, number];
  walls: JointMember[]; // kept as "walls" for backward compat with joint-menu
}

const EPS = 0.001;

function pointKey(p: [number, number, number]): string {
  const r = (v: number) => Math.round(v / EPS) * EPS;
  return `${r(p[0])},${r(p[1])},${r(p[2])}`;
}

/**
 * Find all elements with linear edges that share a given element's endpoint.
 * Generic: works for any element type that declares getLinearEdges.
 */
export function findNeighborsAtEndpoint(
  doc: BimDocument,
  elementId: ContractId,
  endpointId: string
): AnyContract[] {
  const reg = doc.registry;
  if (!reg) return [];
  const contract = doc.contracts.get(elementId);
  if (!contract) return [];
  const def = reg.get(contract.kind);
  const pos = def?.getEndpointPosition?.(contract, endpointId, doc);
  if (!pos) return [];

  const key = pointKey(pos);
  const neighbors: AnyContract[] = [];

  const candidateIds = doc.spatialIndex
    ? doc.spatialIndex.queryRadius(pos[0], pos[2], EPS * 2)
    : Array.from(doc.contracts.keys());

  for (const id of candidateIds) {
    if (id === elementId) continue;
    const c = doc.contracts.get(id);
    if (!c) continue;
    const cDef = reg.get(c.kind);
    const edges = cDef?.getLinearEdges?.(c, doc);
    if (!edges) continue;
    for (const edge of edges) {
      if (pointKey(edge.start) === key || pointKey(edge.end) === key) {
        neighbors.push(c);
        break;
      }
    }
  }

  return neighbors;
}

/**
 * Find all joints in the document — points where 2+ elements with linear edges meet.
 * Generic: works for any element type that declares getLinearEdges.
 */
export function findAllJoints(doc: BimDocument): Joint[] {
  const reg = doc.registry;
  if (!reg) return [];
  const map = new Map<string, Joint>();

  for (const [, contract] of doc.contracts) {
    const def = reg.get(contract.kind);
    const edges = def?.getLinearEdges?.(contract, doc);
    if (!edges) continue;

    for (const edge of edges) {
      for (const [epId, pt] of [[edge.startId, edge.start], [edge.endId, edge.end]] as const) {
        const key = pointKey(pt);
        let joint = map.get(key);
        if (!joint) {
          joint = { point: pt, walls: [] };
          map.set(key, joint);
        }
        joint.walls.push({ id: contract.id, endpoint: epId });
      }
    }
  }

  return Array.from(map.values()).filter((j) => j.walls.length >= 2);
}
