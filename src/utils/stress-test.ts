import type { BimDocument } from "../core/document";
import type { ContractId } from "../core/contracts";
import { createWall } from "../elements/wall";
import type { WallContract } from "../elements/wall";
import { createWindow } from "../elements/window";
import { createWallType } from "../elements/wall-type";
import { createWindowType } from "../elements/window-type";
import { createFloor } from "../elements/floor";
import type { FloorBoundaryVertex } from "../elements/floor";

export interface StressTestOptions {
  /** Grid rows (default 10). */
  rows?: number;
  /** Grid columns (default 10). */
  cols?: number;
  /** Cell size in meters (default 5). */
  cellSize?: number;
  /** Wall height (default 3). */
  height?: number;
  /** Wall thickness (default 0.2). */
  thickness?: number;
  /** Place a window on every N-th wall (0 = no windows, default 2). */
  windowEvery?: number;
  /** Create floors in each cell (default true). */
  floors?: boolean;
  /** Wall type ID to use. If not provided, creates a temporary type. */
  wallTypeId?: ContractId;
  /** Window type ID to use. If not provided, creates a temporary type. */
  windowTypeId?: ContractId;
}

/**
 * Generate a grid of connected walls (rooms), optionally with windows and floors.
 * All elements are created in a single transaction for performance.
 *
 * A 10×10 grid produces ~220 walls, ~110 windows, ~100 floors ≈ 430 elements.
 */
export function generateStressTest(
  doc: BimDocument,
  options: StressTestOptions = {}
) {
  const rows = options.rows ?? 10;
  const cols = options.cols ?? 10;
  const size = options.cellSize ?? 5;
  const height = options.height ?? 3;
  const thickness = options.thickness ?? 0.2;
  const windowEvery = options.windowEvery ?? 2;
  const makeFloors = options.floors ?? true;

  let wallCount = 0;
  let windowCount = 0;
  let floorCount = 0;

  const t0 = performance.now();

  doc.transaction(() => {
    // Ensure types exist
    let wallTypeId = options.wallTypeId;
    if (!wallTypeId) {
      const wt = createWallType({ height, thickness });
      doc.add(wt);
      wallTypeId = wt.id;
    }
    let windowTypeId = options.windowTypeId;
    if (!windowTypeId) {
      const wt = createWindowType();
      doc.add(wt);
      windowTypeId = wt.id;
    }
    // Grid corners: (row, col) → [x, 0, z]
    // Walls along rows (horizontal) and columns (vertical)

    // Store wall IDs at grid edges for floor boundary references
    // horizontalWalls[row][col] = wall along bottom edge of cell (row, col)
    const horizontalWalls: (WallContract | null)[][] = [];
    // verticalWalls[row][col] = wall along left edge of cell (row, col)
    const verticalWalls: (WallContract | null)[][] = [];

    // Create horizontal walls (rows+1 lines of cols walls each)
    for (let r = 0; r <= rows; r++) {
      horizontalWalls[r] = [];
      for (let c = 0; c < cols; c++) {
        const start: [number, number, number] = [c * size, 0, r * size];
        const end: [number, number, number] = [(c + 1) * size, 0, r * size];
        const wall = createWall(start, end, wallTypeId);
        doc.add(wall);
        horizontalWalls[r][c] = wall;
        wallCount++;

        if (windowEvery > 0 && wallCount % windowEvery === 0) {
          const win = createWindow(wall.id, 0.5, windowTypeId);
          doc.add(win);
          windowCount++;
        }
      }
    }

    // Create vertical walls (rows lines of cols+1 walls each)
    for (let r = 0; r < rows; r++) {
      verticalWalls[r] = [];
      for (let c = 0; c <= cols; c++) {
        const start: [number, number, number] = [c * size, 0, r * size];
        const end: [number, number, number] = [c * size, 0, (r + 1) * size];
        const wall = createWall(start, end, wallTypeId);
        doc.add(wall);
        verticalWalls[r][c] = wall;
        wallCount++;

        if (windowEvery > 0 && wallCount % windowEvery === 0) {
          const win = createWindow(wall.id, 0.5, windowTypeId);
          doc.add(win);
          windowCount++;
        }
      }
    }

    // Create floors (one per cell)
    if (makeFloors) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // Four corners of the cell
          const boundary: FloorBoundaryVertex[] = [
            { type: "free", position: [c * size, 0, r * size] },
            { type: "free", position: [(c + 1) * size, 0, r * size] },
            { type: "free", position: [(c + 1) * size, 0, (r + 1) * size] },
            { type: "free", position: [c * size, 0, (r + 1) * size] },
          ];
          const floor = createFloor(boundary);
          doc.add(floor);
          floorCount++;
        }
      }
    }
  });

  const elapsed = (performance.now() - t0).toFixed(0);
  const summary = `Stress test: ${wallCount} walls, ${windowCount} windows, ${floorCount} floors (${wallCount + windowCount + floorCount} total) in ${elapsed}ms`;
  console.log(summary);
  return { wallCount, windowCount, floorCount, elapsed };
}
