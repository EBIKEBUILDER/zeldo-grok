/**
 * Cheap look-dev helpers: foliage sway (material plugin, vertex shader only), baked height AO on
 * vertex colours, and a procedural water shimmer texture. No external assets.
 */
import { DynamicTexture, MaterialPluginBase, Mesh, Scene, Texture, VertexBuffer, type Material, type MaterialDefines, type UniformBuffer } from "@babylonjs/core";

/** shared clock for every swaying material (seconds) */
export const swayClock = { t: 0 };

/**
 * Bends vertices sideways by sin(time + world position), scaled by the square of the vertex's
 * height in the mesh's local space — trunks/roots stay put, canopies and blade tips wave.
 */
export class SwayPlugin extends MaterialPluginBase {
  amp: number;
  /** "height": weight = local y² (thin instances); "alpha": weight baked in vertex-colour alpha (merged meshes) */
  mode: "height" | "alpha";
  constructor(material: Material, amp: number, mode: "height" | "alpha" = "height") {
    super(material, "Sway", 200, { ZSWAY: false });
    this.amp = amp;
    this.mode = mode;
    this._enable(true);
  }
  getClassName() {
    return "SwayPlugin";
  }
  prepareDefines(defines: MaterialDefines) {
    defines.ZSWAY = true;
  }
  getUniforms() {
    return {
      ubo: [
        { name: "swayTime", size: 1, type: "float" },
        { name: "swayAmp", size: 1, type: "float" },
      ],
      vertex: `#ifdef ZSWAY
uniform float swayTime;
uniform float swayAmp;
#endif`,
    };
  }
  bindForSubMesh(ubo: UniformBuffer) {
    ubo.updateFloat("swayTime", swayClock.t);
    ubo.updateFloat("swayAmp", this.amp);
  }
  getCustomCode(shaderType: string) {
    if (shaderType !== "vertex") return null;
    return {
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `
#ifdef ZSWAY
{
  ${this.mode === "alpha" ? "float zw = color.a * swayAmp;" : "float zh = max(positionUpdated.y, 0.0);\n  float zw = zh * zh * swayAmp;"}
  float zp = worldPos.x * 0.55 + worldPos.z * 0.38;
  worldPos.x += sin(swayTime * 1.7 + zp) * zw;
  worldPos.z += cos(swayTime * 1.3 + zp * 1.3) * zw * 0.6;
}
#endif
`,
    };
  }
}

/**
 * Ambient-occlusion-ish darkening toward a mesh's base, baked into its vertex colours once.
 * `strength` = how dark the very bottom gets (0.35 → 65% brightness), fading out over `fade` of the height.
 */
export function bakeHeightAO(mesh: Mesh, strength = 0.35, fade = 0.45) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const col = mesh.getVerticesData(VertexBuffer.ColorKind);
  if (!pos || !col) return;
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < pos.length; i += 3) {
    lo = Math.min(lo, pos[i]);
    hi = Math.max(hi, pos[i]);
  }
  const span = Math.max(1e-3, (hi - lo) * fade);
  const out = new Float32Array(col.length);
  for (let v = 0; v < pos.length / 3; v++) {
    const t = Math.min(1, (pos[v * 3 + 1] - lo) / span);
    const k = 1 - strength * (1 - t * t * (3 - 2 * t));
    out[v * 4] = col[v * 4] * k;
    out[v * 4 + 1] = col[v * 4 + 1] * k;
    out[v * 4 + 2] = col[v * 4 + 2] * k;
    out[v * 4 + 3] = col[v * 4 + 3];
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, out);
}

/** Soft caustic-like streaks for the pond; scrolled via uOffset/vOffset each frame. */
export function makeShimmerTexture(scene: Scene): DynamicTexture {
  const S = 128;
  const tex = new DynamicTexture("shimmer", { width: S, height: S }, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = (x / S) * Math.PI * 2, v = (y / S) * Math.PI * 2;
      const a = Math.sin(u * 2 + Math.sin(v * 3) * 1.2) + Math.sin(v * 2 + Math.sin(u * 3) * 1.1);
      const w = Math.pow(Math.max(0, 1 - Math.abs(a) * 0.9), 6);
      const c = Math.round(w * 255);
      const i = (y * S + x) * 4;
      img.data[i] = c;
      img.data[i + 1] = c;
      img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}
