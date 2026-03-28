/**
 * AI Tool Generator Panel
 * Floating chat panel that lets users describe a BIM tool in natural language.
 * Calls POST /api/generate → Claude generates TypeScript → Vite HMR reloads.
 */

type PanelStatus = "idle" | "generating" | "writing" | "done" | "error";

export function createAIPanel() {
  // ── Container ───────────────────────────────────────────────────
  const panel = document.createElement("div");
  panel.id = "ai-panel";
  panel.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: 320px;
    background: #1e1e2e;
    border: 1px solid #44475a;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: sans-serif;
    font-size: 13px;
    color: #cdd6f4;
    z-index: 9999;
    overflow: hidden;
    transition: box-shadow 0.2s;
  `;

  // ── Header ──────────────────────────────────────────────────────
  const header = document.createElement("div");
  header.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: #181825;
    cursor: pointer;
    user-select: none;
    border-bottom: 1px solid #313244;
  `;
  header.innerHTML = `
    <span style="font-size:16px">🤖</span>
    <span style="font-weight:600; color:#cba6f7">AI Tool Generator</span>
    <span id="ai-panel-toggle" style="margin-left:auto; font-size:11px; color:#6c7086">▼ collapse</span>
  `;

  // ── Body ────────────────────────────────────────────────────────
  const body = document.createElement("div");
  body.id = "ai-panel-body";
  body.style.cssText = `padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px;`;

  // Generated tools list
  const toolsList = document.createElement("div");
  toolsList.id = "ai-tools-list";
  toolsList.style.cssText = `
    min-height: 28px;
    font-size: 11px;
    color: #6c7086;
  `;
  toolsList.textContent = "No tools generated yet.";

  // Text input
  const input = document.createElement("textarea");
  input.id = "ai-prompt-input";
  input.placeholder = 'Describe a tool… e.g. "a beam tool that places horizontal structural elements between two points"';
  input.rows = 3;
  input.style.cssText = `
    width: 100%;
    box-sizing: border-box;
    background: #313244;
    border: 1px solid #45475a;
    border-radius: 8px;
    color: #cdd6f4;
    padding: 8px 10px;
    font-size: 12px;
    font-family: sans-serif;
    resize: none;
    outline: none;
    line-height: 1.5;
  `;

  // Status line
  const statusLine = document.createElement("div");
  statusLine.id = "ai-status";
  statusLine.style.cssText = `
    font-size: 11px;
    color: #6c7086;
    min-height: 16px;
  `;

  // Generate button
  const btn = document.createElement("button");
  btn.id = "ai-generate-btn";
  btn.textContent = "✨ Generate Tool";
  btn.style.cssText = `
    background: linear-gradient(135deg, #cba6f7, #89b4fa);
    border: none;
    border-radius: 8px;
    color: #1e1e2e;
    font-weight: 700;
    font-size: 13px;
    padding: 9px 16px;
    cursor: pointer;
    width: 100%;
    transition: opacity 0.15s;
  `;

  body.appendChild(toolsList);
  body.appendChild(input);
  body.appendChild(statusLine);
  body.appendChild(btn);

  panel.appendChild(header);
  panel.appendChild(body);
  document.body.appendChild(panel);

  // ── Collapse toggle ─────────────────────────────────────────────
  let collapsed = false;
  header.addEventListener("click", () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "flex";
    document.getElementById("ai-panel-toggle")!.textContent = collapsed ? "▶ expand" : "▼ collapse";
  });

  // ── Status helper ────────────────────────────────────────────────
  const icons: Record<PanelStatus, string> = {
    idle: "",
    generating: "⏳ Generating TypeScript…",
    writing: "💾 Writing files…",
    done: "✅ Tool ready — reloading…",
    error: "❌ Error — see console",
  };

  function setStatus(s: PanelStatus, extra = "") {
    statusLine.textContent = icons[s] + (extra ? ` ${extra}` : "");
    statusLine.style.color =
      s === "done" ? "#a6e3a1" : s === "error" ? "#f38ba8" : s === "idle" ? "#6c7086" : "#f9e2af";
  }

  // ── Load existing tools from server ─────────────────────────────
  async function refreshToolsList() {
    try {
      const res = await fetch("/api/tools");
      if (!res.ok) return;
      const tools: string[] = await res.json();
      if (tools.length === 0) {
        toolsList.textContent = "No tools generated yet.";
      } else {
        toolsList.innerHTML =
          `<span style="color:#a6e3a1; font-weight:600">Generated tools:</span><br>` +
          tools.map(t => `&nbsp;• ${t}`).join("<br>");
      }
    } catch {
      // server might not be up yet
    }
  }
  refreshToolsList();

  // ── Generate ─────────────────────────────────────────────────────
  btn.addEventListener("click", async () => {
    const prompt = input.value.trim();
    if (!prompt) {
      setStatus("error", "(empty prompt)");
      return;
    }

    btn.disabled = true;
    btn.style.opacity = "0.6";
    setStatus("generating");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error ?? "Unknown error");
      }

      setStatus("done", data.demo ? "(demo mode)" : "");
      input.value = "";
      await refreshToolsList();

      setTimeout(() => location.reload(), 800);
    } catch (err: any) {
      console.error("[AI Panel]", err);
      setStatus("error", err.message ?? "");
      btn.disabled = false;
      btn.style.opacity = "1";
    }
  });

  // Enter = submit (Shift+Enter = newline)
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      btn.click();
    }
  });
}
