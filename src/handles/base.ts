import * as THREE from "three";

export class HandleMesh {
  mesh: THREE.Mesh;
  private color: number;
  private hoverColor = 0xffaa00;

  constructor(
    geometry: THREE.BufferGeometry,
    color: number,
    position: THREE.Vector3
  ) {
    this.color = color;
    const material = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(position);
    this.mesh.renderOrder = 999;
  }

  setPosition(pos: THREE.Vector3) {
    this.mesh.position.copy(pos);
  }

  setHovered(hovered: boolean) {
    (this.mesh.material as THREE.MeshBasicMaterial).color.set(
      hovered ? this.hoverColor : this.color
    );
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
