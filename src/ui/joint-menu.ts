import type { BimDocument } from "../core/document";
import type { JoinType } from "../core/contracts";
import type { Joint } from "../utils/joints";

/**
 * Floating dropdown shown when user clicks a wall joint.
 * Allows choosing the join type (butt / miter) for all walls at that joint.
 */
export class JointMenu {
  private el: HTMLDivElement;
  private doc: BimDocument;
  private currentJoint: Joint | null = null;

  constructor(doc: BimDocument) {
    this.doc = doc;
    this.el = document.createElement("div");
    this.el.id = "joint-menu";
    this.el.innerHTML = `
      <button data-join="butt" class="active">Butt</button>
      <button data-join="miter">Miter</button>
    `;
    this.el.style.display = "none";
    document.body.appendChild(this.el);

    this.el.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("button");
      if (!btn || !this.currentJoint) return;
      const joinType = btn.dataset.join as JoinType;
      this.applyJoinType(joinType);

      // Update active state
      this.el.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });

    // Close on outside click
    document.addEventListener("pointerdown", (e) => {
      if (this.el.style.display !== "none" && !this.el.contains(e.target as Node)) {
        this.hide();
      }
    });
  }

  show(joint: Joint, screenX: number, screenY: number) {
    this.currentJoint = joint;

    // Determine current join type from the first wall
    const firstWall = joint.walls[0];
    const contract = this.doc.contracts.get(firstWall.id);
    const currentType =
      contract && "startJoin" in contract
        ? firstWall.endpoint === "start"
          ? contract.startJoin
          : contract.endJoin
        : "butt";

    this.el.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.join === currentType);
    });

    this.el.style.display = "flex";
    this.el.style.left = `${screenX}px`;
    this.el.style.top = `${screenY}px`;
  }

  hide() {
    this.el.style.display = "none";
    this.currentJoint = null;
  }

  get visible() {
    return this.el.style.display !== "none";
  }

  private applyJoinType(joinType: JoinType) {
    if (!this.currentJoint) return;

    // Update all walls at this joint
    for (const { id, endpoint } of this.currentJoint.walls) {
      const patch =
        endpoint === "start"
          ? { startJoin: joinType }
          : { endJoin: joinType };
      this.doc.update(id, patch);
    }
  }
}
