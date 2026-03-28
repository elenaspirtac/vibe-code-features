import * as THREE from "three";
import * as FRAGS from "@thatopen/fragments";

export class FragmentManager {
  fragments: FRAGS.FragmentsModels;
  modelId = "bim-authoring";
  model: any = null;

  private constructor(fragments: FRAGS.FragmentsModels) {
    this.fragments = fragments;
  }

  static async create(scene: THREE.Scene, camera: THREE.Camera): Promise<FragmentManager> {
    const workerUrl = "/worker.mjs";

    const fragments = new FRAGS.FragmentsModels(workerUrl);

    const mgr = new FragmentManager(fragments);

    // Create empty model
    const bytes = FRAGS.EditUtils.newModel({ raw: true });
    mgr.model = await fragments.load(bytes, {
      modelId: mgr.modelId,
      camera,
      raw: true,
    });

    scene.add(mgr.model.object);
    await fragments.update(true);

    return mgr;
  }

  get editor() {
    return this.fragments.editor;
  }

  async update(force = false) {
    await this.fragments.update(force);
  }

  /** Get the fragment model binary buffer for persistence. */
  async getBuffer(): Promise<Uint8Array> {
    const model = this.fragments.models.list.get(this.modelId);
    if (!model) throw new Error("No model loaded");
    const buffer = await model.getBuffer(true);
    return new Uint8Array(buffer);
  }

  /** Remove and dispose the current fragment model from the scene. */
  async disposeModel(scene: THREE.Scene): Promise<void> {
    const model = this.fragments.models.list.get(this.modelId);
    if (model) {
      scene.remove(model.object);
      // Also remove delta model's object if it exists
      if (model.deltaModelId) {
        const delta = this.fragments.models.list.get(model.deltaModelId);
        if (delta) {
          scene.remove(delta.object);
        }
      }
      await model.dispose();
    }
    this.model = null;
  }

  /** Load a fragment model from a binary buffer and add it to the scene. */
  async loadModel(buffer: Uint8Array, scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    this.model = await this.fragments.load(buffer, {
      modelId: this.modelId,
      camera,
      raw: true,
    });
    scene.add(this.model.object);
    await this.fragments.update(true);
  }
}
