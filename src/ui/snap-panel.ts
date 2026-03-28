import { snapSettings } from "../utils/snap";

/**
 * Bottom-left panel with grid/snap toggle controls.
 */
export function createSnapPanel() {
  const panel = document.createElement("div");
  panel.id = "snap-panel";
  panel.innerHTML = `
    <label>
      <input type="checkbox" id="snap-grid" ${snapSettings.gridEnabled ? "checked" : ""} />
      Grid
    </label>
    <label>
      <input type="number" id="snap-grid-step" value="${snapSettings.gridStep}" step="0.05" min="0.01" max="5" />
      m
    </label>
    <label>
      <input type="checkbox" id="snap-endpoint" ${snapSettings.endpointEnabled ? "checked" : ""} />
      Endpoint
    </label>
    <label>
      <input type="checkbox" id="snap-midpoint" ${snapSettings.midpointEnabled ? "checked" : ""} />
      Midpoint
    </label>
    <label>
      <input type="checkbox" id="snap-extension" ${snapSettings.extensionEnabled ? "checked" : ""} />
      Extension
    </label>
    <label>
      <input type="checkbox" id="snap-perpendicular" ${snapSettings.perpendicularEnabled ? "checked" : ""} />
      Perpendicular
    </label>
    <label>
      <input type="number" id="snap-endpoint-threshold" value="${snapSettings.endpointThreshold}" step="0.05" min="0.05" max="2" />
      m
    </label>
  `;
  document.body.appendChild(panel);

  const gridCheck = panel.querySelector("#snap-grid") as HTMLInputElement;
  const gridStep = panel.querySelector("#snap-grid-step") as HTMLInputElement;
  const endpointCheck = panel.querySelector("#snap-endpoint") as HTMLInputElement;
  const midpointCheck = panel.querySelector("#snap-midpoint") as HTMLInputElement;
  const extensionCheck = panel.querySelector("#snap-extension") as HTMLInputElement;
  const perpendicularCheck = panel.querySelector("#snap-perpendicular") as HTMLInputElement;
  const endpointThreshold = panel.querySelector("#snap-endpoint-threshold") as HTMLInputElement;

  gridCheck.addEventListener("change", () => {
    snapSettings.gridEnabled = gridCheck.checked;
  });
  gridStep.addEventListener("input", () => {
    const v = parseFloat(gridStep.value);
    if (v > 0) snapSettings.gridStep = v;
  });
  endpointCheck.addEventListener("change", () => {
    snapSettings.endpointEnabled = endpointCheck.checked;
  });
  midpointCheck.addEventListener("change", () => {
    snapSettings.midpointEnabled = midpointCheck.checked;
  });
  extensionCheck.addEventListener("change", () => {
    snapSettings.extensionEnabled = extensionCheck.checked;
  });
  perpendicularCheck.addEventListener("change", () => {
    snapSettings.perpendicularEnabled = perpendicularCheck.checked;
  });
  endpointThreshold.addEventListener("input", () => {
    const v = parseFloat(endpointThreshold.value);
    if (v > 0) snapSettings.endpointThreshold = v;
  });
}
