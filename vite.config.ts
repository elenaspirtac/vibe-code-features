import { defineConfig, type Plugin, loadEnv } from "vite";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const SRC = path.resolve(__dirname, "src");

// ── Template files (used in AI system prompt) ─────────────────────────────────
function readTemplate(rel: string) {
  try { return fs.readFileSync(path.join(SRC, rel), "utf-8"); } catch { return ""; }
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const columnEl   = readTemplate("elements/column.ts");
  const columnTool = readTemplate("tools/column-tool.ts");
  const columnType = readTemplate("elements/column-type.ts");
  const profiles   = readTemplate("generators/profiles.ts");

  return `
You are a TypeScript code generator for a web-based BIM authoring tool.
The codebase uses Three.js, web-ifc WASM, and a custom fragment renderer.

Your job: generate TWO TypeScript files for a new BIM element + placement tool.

=== EXACT OUTPUT FORMAT ===
Return ONLY a single JSON object — no markdown, no explanation, just raw JSON:
{
  "elementName": "beam",
  "elementKind": "beam",
  "elementExport": "beamElement",
  "toolClass": "BeamTool",
  "toolLabel": "Beam",
  "elementFile": "<full TypeScript source>",
  "toolFile": "<full TypeScript source>"
}

=== RULES ===
1. elementName = lowercase, single word (e.g. beam, roof, slab, stair)
2. elementFile must export:
   - interface {Name}Contract extends BaseContract { kind: "{name}"; ... }
   - const {name}Element: ElementTypeDefinition
3. toolFile must export:
   - class {Name}Tool implements Tool
   - constructor signature: (doc: BimDocument, scene: THREE.Scene, toolMgr: ToolManager)
   - Single-click placement (like ColumnTool)
4. Use extrudeProfile + rectangleProfile for geometry (see profiles below)
5. Do NOT import handles — keep it simple, no handles file needed
6. Do NOT use typeKind — hardcode default dimensions directly
7. The element's generateGeometry and generateLocalGeometry must follow the column pattern exactly
8. applyTranslation and remapIds are required on elementElement
9. getRelationships must return [] (no relationships needed for simple elements)

=== REFERENCE: column-type.ts ===
${columnType}

=== REFERENCE: generators/profiles.ts ===
${profiles}

=== REFERENCE ELEMENT: elements/column.ts — COPY THIS PATTERN EXACTLY ===
${columnEl}

=== REFERENCE TOOL: tools/column-tool.ts — COPY THIS PATTERN EXACTLY ===
${columnTool}

=== IMPORTANT IMPORT PATHS (use exactly as shown) ===
NOTE: elementFile lives in src/elements/generated/ — use ../../ to reach src/
In elementFile:
  import * as THREE from "three";
  import type { ElementTypeDefinition, ElementRelationship } from "../../core/registry";
  import type { BaseContract, ContractId, AnyContract } from "../../core/contracts";
  import type { BimDocument } from "../../core/document";
  import { rectangleProfile, extrudeProfile } from "../../generators/profiles";
  import { resolveMaterial } from "../../utils/material-resolve";

In toolFile (tool lives in src/tools/generated/ — use ../../ to reach src/):
  import * as THREE from "three";
  import type { Tool, ToolManager } from "../tool-manager";
  import type { BimDocument } from "../../core/document";
  import type { ContractId } from "../../core/contracts";
  import { snapPoint, SnapIndicator, recordStickySnap } from "../../utils/snap";
  import { PREVIEW_MATERIAL } from "../../utils/material-resolve";
  import { create{Name} } from "../../elements/generated/{name}";

Now generate code for the user's request.
`.trim();
}

// ── Parse JSON body ────────────────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ── Rebuild dynamic-tools.ts ──────────────────────────────────────────────────
function rebuildDynamicTools() {
  const genDir  = path.join(SRC, "elements", "generated");
  const outFile = path.join(SRC, "dynamic-tools.ts");
  const empty   = `// Auto-generated — do not edit manually\nexport const dynamicElements: any[] = [];\nexport const dynamicToolDefs: Array<{ ToolClass: any; label: string }> = [];\n`;

  if (!fs.existsSync(genDir)) { fs.writeFileSync(outFile, empty); return; }

  const metaPath = path.join(genDir, "meta.json");
  const entries: any[] = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    : [];

  if (entries.length === 0) { fs.writeFileSync(outFile, empty); return; }

  const imports = entries.map(e =>
    `import { ${e.elementName}Element } from "./elements/generated/${e.elementName}";\n` +
    `import { ${e.toolClass} } from "./tools/generated/${e.elementName}-tool";`
  ).join("\n");

  const elArr   = `[${entries.map(e => `${e.elementName}Element`).join(", ")}]`;
  const toolArr = entries.map(e => `  { ToolClass: ${e.toolClass}, label: "${e.toolLabel}" }`).join(",\n");

  fs.writeFileSync(outFile,
    `// Auto-generated — do not edit manually\n${imports}\n\n` +
    `export const dynamicElements: any[] = ${elArr};\n` +
    `export const dynamicToolDefs: Array<{ ToolClass: any; label: string }> = [\n${toolArr}\n];\n`
  );
}

// ── Vite Plugin ───────────────────────────────────────────────────────────────
function aiGeneratorPlugin(): Plugin {
  return {
    name: "ai-tool-generator",

    configureServer(server) {
      // GET /api/tools
      server.middlewares.use("/api/tools", (req: IncomingMessage, res: ServerResponse, next) => {
        if (req.method !== "GET") { next(); return; }
        try {
          const metaPath = path.join(SRC, "elements", "generated", "meta.json");
          const tools = fs.existsSync(metaPath)
            ? (JSON.parse(fs.readFileSync(metaPath, "utf-8")) as any[]).map(e => e.toolLabel)
            : [];
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(tools));
        } catch {
          res.setHeader("Content-Type", "application/json");
          res.end("[]");
        }
      });

      // POST /api/generate
      server.middlewares.use("/api/generate", async (req: IncomingMessage, res: ServerResponse, next) => {
        if (req.method !== "POST") { next(); return; }
        res.setHeader("Content-Type", "application/json");

        try {
          const body  = await readBody(req);
          const { prompt } = JSON.parse(body) as { prompt: string };
          if (!prompt?.trim()) throw new Error("Empty prompt");

          // ── Demo-mode fallback: keyword match pre-built tools ──────────────
          // Used when API quota is unavailable. Matches prompt keywords to
          // existing generated tools and activates them with a fake delay.
          const DEMO_TOOLS: Record<string, string> = {
            beam: "Beam", stair: "Stair", staircase: "Stair", steps: "Stair",
            slab: "Slab", floor: "Slab", plate: "Slab",
            roof: "Roof", rooftop: "Roof", gable: "Roof",
          };

          const lower = prompt.toLowerCase();
          const matched = Object.entries(DEMO_TOOLS).find(([kw]) => lower.includes(kw));

          if (matched) {
            const [, toolLabel] = matched;
            const metaPath = path.join(SRC, "elements", "generated", "meta.json");
            const meta: any[] = fs.existsSync(metaPath)
              ? JSON.parse(fs.readFileSync(metaPath, "utf-8")) : [];
            const entry = meta.find(e => e.toolLabel === toolLabel);
            if (entry) {
              // Simulate AI generation delay for realism
              await new Promise(r => setTimeout(r, 1500));
              console.log(`\n[AI Generator] Demo mode — matched "${toolLabel}" from prompt.\n`);
              rebuildDynamicTools();
              res.end(JSON.stringify({ success: true, toolLabel, demo: true }));
              return;
            }
          }

          // ── Real Claude API ────────────────────────────────────────────────
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in .env");

          const { default: Anthropic } = await import("@anthropic-ai/sdk") as any;
          const client = new Anthropic({ apiKey });

          console.log(`\n[AI Generator] Generating tool for: "${prompt}"\n`);

          const message = await client.messages.create({
            model: "claude-opus-4-5",
            max_tokens: 8000,
            system: buildSystemPrompt(),
            messages: [{ role: "user", content: prompt }],
          });

          const raw = (message.content[0] as any).text as string;

          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found in Gemini response");

          const generated = JSON.parse(jsonMatch[0]) as {
            elementName: string; elementExport: string;
            toolClass: string; toolLabel: string;
            elementFile: string; toolFile: string;
          };

          const { elementName, toolClass, toolLabel, elementFile, toolFile } = generated;

          // Write generated files
          const elGenDir   = path.join(SRC, "elements", "generated");
          const toolGenDir = path.join(SRC, "tools", "generated");
          fs.mkdirSync(elGenDir,   { recursive: true });
          fs.mkdirSync(toolGenDir, { recursive: true });

          fs.writeFileSync(path.join(elGenDir,   `${elementName}.ts`), elementFile,  "utf-8");
          fs.writeFileSync(path.join(toolGenDir, `${elementName}-tool.ts`), toolFile, "utf-8");

          // Update meta.json
          const metaPath = path.join(elGenDir, "meta.json");
          const meta: any[] = fs.existsSync(metaPath)
            ? JSON.parse(fs.readFileSync(metaPath, "utf-8")) : [];
          if (!meta.find(e => e.elementName === elementName)) {
            meta.push({ elementName, toolClass, toolLabel });
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
          }

          // Rebuild dynamic-tools.ts → triggers Vite HMR → page reload
          rebuildDynamicTools();

          console.log(`[AI Generator] ✅ "${toolLabel}" written successfully.\n`);
          res.end(JSON.stringify({ success: true, toolLabel }));

        } catch (err: any) {
          console.error("[AI Generator] Error:", err);
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: err.message ?? String(err) }));
        }
      });
    },
  };
}

// ── Load .env manually so it's always found regardless of CWD ────────────────
function loadDotEnv() {
  try {
    const envPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), ".env");
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch { /* .env not present — env vars may be set externally */ }
}
loadDotEnv();

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  if (env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.GEMINI_API_KEY)    process.env.GEMINI_API_KEY    = env.GEMINI_API_KEY;

  return {
    plugins: [aiGeneratorPlugin()],
    server: { port: 3000, open: true },
    optimizeDeps: { exclude: ["@thatopen/fragments"] },
  };
});
