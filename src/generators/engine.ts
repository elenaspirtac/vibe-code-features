import * as WEBIFC from "web-ifc";
import { GeometryEngine } from "@thatopen/fragments";

let _engine: GeometryEngine | null = null;
let _api: WEBIFC.IfcAPI | null = null;

export async function getGeometryEngine(): Promise<GeometryEngine> {
  if (_engine) return _engine;
  _api = new WEBIFC.IfcAPI();
  _api.SetWasmPath("/wasm/", false);
  await _api.Init();
  _engine = new GeometryEngine(_api);
  return _engine;
}
