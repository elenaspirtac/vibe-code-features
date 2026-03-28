import type { ToolManager } from "../tools/tool-manager";
import type { Tool } from "../tools/tool-manager";

export function createToolbar(
  toolMgr: ToolManager,
  tools: { tool: Tool; label: string; icon?: string }[]
) {
  const container = document.getElementById("toolbar")!;

  const buttons = new Map<string, HTMLButtonElement>();

  for (const { tool, label } of tools) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (toolMgr.getActiveTool()?.name === tool.name) {
        toolMgr.setTool(null);
      } else {
        toolMgr.setTool(tool);
      }
    });
    container.appendChild(btn);
    buttons.set(tool.name, btn);
  }

  // Escape button — visible only when a tool is active
  const escBtn = document.createElement("button");
  escBtn.textContent = "✕ Esc";
  escBtn.title = "Cancel active tool (Escape)";
  escBtn.style.cssText = `
    background: #f38ba8;
    color: #1e1e2e;
    font-weight: 700;
    border: none;
    display: none;
    margin-left: 8px;
  `;
  escBtn.addEventListener("click", () => toolMgr.setTool(null));
  container.appendChild(escBtn);

  // Update active states + show/hide Esc button
  toolMgr.onToolChanged = (name) => {
    for (const [toolName, btn] of buttons) {
      btn.classList.toggle("active", toolName === name);
    }
    escBtn.style.display = name ? "inline-block" : "none";
  };
}
