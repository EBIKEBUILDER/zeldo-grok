import {
  Color3,
  Color4,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import { makeRng } from "../rng";

export const hex = (h: string) => Color3.FromHexString(h);

export function material(scene: Scene, name: string, color: Color3 | string = "#ffffff", opts: { spec?: number; emissive?: Color3 | string; alpha?: number; backFace?: boolean; flat?: boolean } = {}) {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = typeof color === "string" ? hex(color) : color;
  const sp = opts.spec ?? 0.05;
  m.specularColor = new Color3(sp, sp, sp);
  m.specularPower = 32;
  if (opts.emissive) m.emissiveColor = typeof opts.emissive === "string" ? hex(opts.emissive) : opts.emissive;
  if (opts.alpha !== undefined) m.alpha = opts.alpha;
  if (opts.backFace === false) m.backFaceCulling = false;
  return m;
}

/** Paints each triangle a slightly different shade of `base` — gives the faceted low-poly look. */
export function paintFacets(mesh: Mesh, base: Color3 | ((y: number) => Color3), variance = 0.08, seed = 1, alpha = 1) {
  if (mesh.getIndices()?.length) mesh.convertToFlatShadedMesh();
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const n = pos.length / 3;
  const colors = new Float32Array(n * 4);
  const rnd = makeRng(seed);
  for (let f = 0; f < n; f += 3) {
    const cy = (pos[f * 3 + 1] + pos[(f + 1) * 3 + 1] + pos[(f + 2) * 3 + 1]) / 3;
    const b = typeof base === "function" ? base(cy) : base;
    const k = 1 + (rnd() - 0.5) * 2 * variance;
    for (let v = 0; v < 3 && f + v < n; v++) {
      const i = (f + v) * 4;
      colors[i] = Math.min(1, b.r * k);
      colors[i + 1] = Math.min(1, b.g * k);
      colors[i + 2] = Math.min(1, b.b * k);
      colors[i + 3] = alpha;
    }
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  return mesh;
}

export function merge(meshes: Mesh[], name: string): Mesh {
  const m = Mesh.MergeMeshes(meshes, true, true)!;
  m.name = name;
  return m;
}

function vcolMat(scene: Scene, name: string, opts: { spec?: number; backFace?: boolean } = {}) {
  return material(scene, name, "#ffffff", opts);
}

// ───────────── trees ─────────────
export function makePine(scene: Scene, name: string, foliage: string[], seed: number): Mesh {
  const trunk = MeshBuilder.CreateCylinder("trunk", { height: 0.6, diameterTop: 0.14, diameterBottom: 0.22, tessellation: 5 }, scene);
  trunk.position.y = 0.3;
  paintFacets(trunk, hex("#7a4b2c"), 0.1, seed);
  const tiers = [
    { h: 0.85, d: 1.15, y: 0.95 },
    { h: 0.75, d: 0.88, y: 1.38 },
    { h: 0.65, d: 0.58, y: 1.78 },
  ];
  const parts: Mesh[] = [trunk];
  tiers.forEach((t, i) => {
    const c = MeshBuilder.CreateCylinder("tier", { height: t.h, diameterTop: 0, diameterBottom: t.d, tessellation: 6 }, scene);
    c.position.y = t.y;
    c.rotation.y = i * 0.5;
    paintFacets(c, hex(foliage[i % foliage.length]), 0.12, seed + i * 7);
    parts.push(c);
  });
  const m = merge(parts, name);
  m.material = vcolMat(scene, name + "-mat");
  return m;
}

/** Round broadleaf tree — used for the autumn Lanternfall Glade. */
export function makeRoundTree(scene: Scene, name: string, foliage: string[], seed: number): Mesh {
  const trunk = MeshBuilder.CreateCylinder("trunk", { height: 0.9, diameterTop: 0.13, diameterBottom: 0.24, tessellation: 5 }, scene);
  trunk.position.y = 0.45;
  paintFacets(trunk, hex("#6b4226"), 0.1, seed);
  const parts: Mesh[] = [trunk];
  const blobs = [
    { x: 0, y: 1.25, z: 0, s: 0.95 },
    { x: 0.25, y: 1.05, z: 0.15, s: 0.6 },
    { x: -0.22, y: 1.1, z: -0.12, s: 0.62 },
  ];
  blobs.forEach((b, i) => {
    const s = MeshBuilder.CreateIcoSphere("leaf", { radius: 0.5 * b.s, subdivisions: 1 }, scene);
    s.position.set(b.x, b.y, b.z);
    s.scaling.y = 0.85;
    paintFacets(s, hex(foliage[i % foliage.length]), 0.14, seed + i * 13);
    parts.push(s);
  });
  const m = merge(parts, name);
  m.material = vcolMat(scene, name + "-mat");
  return m;
}

// ───────────── rocks ─────────────
export function makeRock(scene: Scene, name: string, color: string, seed: number): Mesh {
  const r = MeshBuilder.CreateIcoSphere(name, { radius: 0.5, subdivisions: 1, updatable: true }, scene);
  const pos = r.getVerticesData(VertexBuffer.PositionKind)!;
  const rnd = makeRng(seed);
  // jitter unique vertex positions consistently (shared verts get same offset)
  const offsets = new Map<string, number>();
  for (let i = 0; i < pos.length; i += 3) {
    const key = `${pos[i].toFixed(3)},${pos[i + 1].toFixed(3)},${pos[i + 2].toFixed(3)}`;
    if (!offsets.has(key)) offsets.set(key, 0.75 + rnd() * 0.45);
    const k = offsets.get(key)!;
    pos[i] *= k;
    pos[i + 1] *= k * (pos[i + 1] < 0 ? 0.5 : 1);
    pos[i + 2] *= k;
  }
  r.updateVerticesData(VertexBuffer.PositionKind, pos);
  paintFacets(r, hex(color), 0.12, seed + 3);
  r.material = vcolMat(scene, name + "-mat", { spec: 0.08 });
  return r;
}

// ───────────── hedge ─────────────
export function makeHedge(scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const box = MeshBuilder.CreateBox("hb", { width: 1.02, height: 0.8, depth: 1.02 }, scene);
  box.position.y = 0.4;
  paintFacets(box, hex("#2f6b3c"), 0.08, 5);
  parts.push(box);
  const bumps = [
    [-0.25, 0.85, -0.2, 0.42], [0.22, 0.88, 0.18, 0.46], [0.25, 0.82, -0.25, 0.36], [-0.2, 0.84, 0.25, 0.38],
  ];
  bumps.forEach(([x, y, z, r], i) => {
    const s = MeshBuilder.CreateIcoSphere("hbump", { radius: r, subdivisions: 1 }, scene);
    s.position.set(x, y, z);
    s.scaling.y = 0.6;
    paintFacets(s, hex(i % 2 ? "#3a7d45" : "#336f3f"), 0.1, 11 + i);
    parts.push(s);
  });
  const m = merge(parts, "hedge");
  m.material = vcolMat(scene, "hedge-mat");
  return m;
}

// ───────────── grass tuft (crossed blades) ─────────────
export function makeTuft(scene: Scene, name: string, base: string, tip: string, blades = 7, seed = 3): Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const rnd = makeRng(seed);
  const cb = hex(base), ct = hex(tip);
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rnd() * 0.5;
    const lean = 0.12 + rnd() * 0.18;
    const h = 0.32 + rnd() * 0.22;
    const w = 0.06 + rnd() * 0.03;
    const px = Math.cos(a + Math.PI / 2) * w, pz = Math.sin(a + Math.PI / 2) * w;
    const ox = Math.cos(a) * 0.05, oz = Math.sin(a) * 0.05;
    const tx = Math.cos(a) * lean, tz = Math.sin(a) * lean;
    const b = positions.length / 3;
    positions.push(ox - px, 0, oz - pz, ox + px, 0, oz + pz, tx, h, tz);
    colors.push(cb.r, cb.g, cb.b, 1, cb.r, cb.g, cb.b, 1, ct.r, ct.g, ct.b, 1);
    indices.push(b, b + 1, b + 2);
  }
  const m = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.colors = colors;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vd.normals = normals;
  vd.applyToMesh(m);
  m.material = vcolMat(scene, name + "-mat", { backFace: false });
  return m;
}

// ───────────── pot ─────────────
/**
 * Clay pot: ONE closed, single-sided, smooth-shaded lathe. The profile runs up the outside, over a
 * rolled lip, down the inner wall and across a recessed floor, so the mouth shows a dark interior
 * instead of a hole. (The old open-topped DOUBLESIDE shell was flat-shaded with per-triangle colour
 * jitter plus a light band whose edge zig-zagged across triangles — that was the "staggered" look —
 * and its inside showed the ground through the mouth.)
 */
export function makePot(scene: Scene): Mesh {
  const profile = [
    [0, 0], [0.2, 0], [0.27, 0.07], [0.3, 0.2], [0.29, 0.3], [0.22, 0.42], [0.15, 0.5], // body + neck
    [0.2, 0.55], [0.18, 0.585], [0.13, 0.58], // rolled lip
    [0.115, 0.54], [0.105, 0.47], [0, 0.45], // inner wall + floor
  ].map(([x, y]) => new Vector3(x, y, 0));
  const pot = MeshBuilder.CreateLathe("pot", { shape: profile, tessellation: 16, sideOrientation: Mesh.FRONTSIDE }, scene);
  const pos = pot.getVerticesData(VertexBuffer.PositionKind)!;
  const n = pos.length / 3;
  const col = new Float32Array(n * 4);
  const clay = hex("#c4693a"), rim = hex("#b05a31"), inside = hex("#2e170f");
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const r = Math.hypot(x, z);
    let c: Color3;
    if (y > 0.44 && r < 0.12) {
      // interior: dark at the floor, shading up to the rim colour at the top of the inner wall
      const t = Math.min(1, Math.max(0, (y - 0.45) / 0.13));
      c = Color3.Lerp(inside, rim, t * t);
    } else if (y > 0.52) c = rim;
    else c = clay;
    col.set([c.r, c.g, c.b, 1], v * 4);
  }
  pot.setVerticesData(VertexBuffer.ColorKind, col);
  pot.material = vcolMat(scene, "pot-mat", { spec: 0.06 });
  return pot;
}

// ───────────── flowers ─────────────
export function makeBloom(scene: Scene, name: string, petal: string): Mesh {
  const head = MeshBuilder.CreateIcoSphere("bloom", { radius: 0.07, subdivisions: 1 }, scene);
  head.scaling.y = 0.55;
  head.position.y = 0.16;
  paintFacets(head, hex(petal), 0.1, 2);
  const stem = MeshBuilder.CreateCylinder("stem", { height: 0.16, diameter: 0.025, tessellation: 3 }, scene);
  stem.position.y = 0.08;
  paintFacets(stem, hex("#3f7a33"), 0.05, 3);
  const m = merge([head, stem], name);
  m.material = vcolMat(scene, name + "-mat");
  return m;
}

// ───────────── hero ─────────────
export function makeHeroParts(scene: Scene) {
  const body = MeshBuilder.CreateCapsule("hero-body", { radius: 0.2, height: 0.62, tessellation: 8, subdivisions: 2 }, scene);
  body.position.y = 0.36;
  paintFacets(body, (y) => (y < -0.12 ? hex("#1d6f68") : hex("#2a9d8f")), 0.05, 31);
  const belt = MeshBuilder.CreateTorus("belt", { diameter: 0.38, thickness: 0.06, tessellation: 10 }, scene);
  belt.position.y = 0.3;
  paintFacets(belt, hex("#5b3a24"), 0.05, 32);
  const head = MeshBuilder.CreateIcoSphere("head", { radius: 0.17, subdivisions: 2 }, scene);
  head.position.y = 0.8;
  paintFacets(head, hex("#f2c9a0"), 0.04, 33);
  const hat = MeshBuilder.CreateCylinder("hat", { height: 0.44, diameterTop: 0, diameterBottom: 0.36, tessellation: 7 }, scene);
  hat.position.set(0, 1.0, -0.08);
  hat.rotation.x = -0.55;
  paintFacets(hat, hex("#e07a2f"), 0.08, 34);
  const scarf = MeshBuilder.CreateTorus("scarf", { diameter: 0.3, thickness: 0.07, tessellation: 10 }, scene);
  scarf.position.y = 0.64;
  paintFacets(scarf, hex("#f2d14b"), 0.06, 35);
  const eyeL = MeshBuilder.CreateSphere("eye", { diameter: 0.05, segments: 4 }, scene);
  eyeL.position.set(-0.065, 0.83, 0.15);
  paintFacets(eyeL, hex("#1b1424"), 0, 1);
  const eyeR = eyeL.clone("eyeR")!;
  eyeR.position.x = 0.065;
  const bootL = MeshBuilder.CreateBox("boot", { width: 0.1, height: 0.08, depth: 0.16 }, scene);
  bootL.position.set(-0.09, 0.04, 0.03);
  paintFacets(bootL, hex("#5b3a24"), 0.05, 36);
  const bootR = bootL.clone("bootR")!;
  bootR.position.x = 0.09;
  const shield = MeshBuilder.CreateCylinder("shield", { height: 0.05, diameter: 0.32, tessellation: 6 }, scene);
  shield.rotation.z = Math.PI / 2;
  shield.position.set(-0.24, 0.42, 0.02);
  paintFacets(shield, (y) => hex("#b8c4d6"), 0.12, 37);
  const hero = merge([body, belt, head, hat, scarf, eyeL, eyeR, bootL, bootR, shield], "hero");
  hero.material = vcolMat(scene, "hero-mat", { spec: 0.12 });

  const blade = MeshBuilder.CreateBox("blade", { width: 0.05, height: 0.03, depth: 0.62 }, scene);
  blade.position.z = 0.58;
  paintFacets(blade, hex("#e8eef7"), 0.06, 41);
  const tip = MeshBuilder.CreateCylinder("tip", { height: 0.12, diameterTop: 0, diameterBottom: 0.06, tessellation: 4 }, scene);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = 0.95;
  paintFacets(tip, hex("#ffffff"), 0.04, 42);
  const guard = MeshBuilder.CreateBox("guard", { width: 0.2, height: 0.04, depth: 0.05 }, scene);
  guard.position.z = 0.26;
  paintFacets(guard, hex("#e3b341"), 0.05, 43);
  const grip = MeshBuilder.CreateBox("grip", { width: 0.04, height: 0.04, depth: 0.14 }, scene);
  grip.position.z = 0.18;
  paintFacets(grip, hex("#5b3a24"), 0.05, 44);
  const sword = merge([blade, tip, guard, grip], "sword");
  const swordMat = vcolMat(scene, "sword-mat", { spec: 0.6 });
  swordMat.emissiveColor = new Color3(0.15, 0.15, 0.18);
  sword.material = swordMat;
  return { hero, sword };
}

// ───────────── blob enemy ─────────────
/** Per-vertex colours on a SMOOTH mesh (keeps shared vertices + smooth normals, no jitter). */
export function paintSmooth(mesh: Mesh, base: Color3 | ((y: number) => Color3)) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const n = pos.length / 3;
  const colors = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const c = typeof base === "function" ? base(pos[v * 3 + 1]) : base;
    colors.set([c.r, c.g, c.b, 1], v * 4);
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  return mesh;
}

/**
 * Blob / Warden body. Smooth-shaded UV sphere (14 segments) with a soft belly gradient — the old
 * flat-shaded subdiv-2 icosphere with ±10% per-triangle colour jitter read as a dimpled golf ball.
 * Eyes and the crown band are smooth too; the crown spikes and the sprout stay crisp (they're
 * meant to be pointy). One merged mesh per kind, cloned per enemy (shared geometry).
 */
export function makeBlob(scene: Scene, name: string, body: string, belly: string, eye: string, boss: boolean): Mesh {
  const b = MeshBuilder.CreateSphere("blob", { diameter: 1, segments: 14 }, scene);
  b.scaling.set(1, 0.78, 1);
  b.bakeCurrentTransformIntoVertices();
  b.position.y = 0.38;
  const cBody = hex(body), cBelly = hex(belly);
  paintSmooth(b, (y) => {
    // y in [-0.39, 0.39]: belly colour low, blending smoothly into the body colour
    const t = Math.min(1, Math.max(0, (y + 0.3) / 0.22));
    return Color3.Lerp(cBelly, cBody, t * t * (3 - 2 * t));
  });
  const parts: Mesh[] = [b];
  for (const sx of [-1, 1]) {
    const white = MeshBuilder.CreateSphere("eyeW", { diameter: 0.2, segments: 8 }, scene);
    white.position.set(sx * 0.15, 0.52, 0.36);
    white.scaling.z = 0.6;
    paintSmooth(white, hex(eye));
    const pupil = MeshBuilder.CreateSphere("eyeP", { diameter: 0.09, segments: 6 }, scene);
    pupil.position.set(sx * 0.15, 0.51, 0.43);
    paintSmooth(pupil, hex("#1b1424"));
    parts.push(white, pupil);
    if (boss) {
      const brow = MeshBuilder.CreateBox("brow", { width: 0.2, height: 0.05, depth: 0.05 }, scene);
      brow.position.set(sx * 0.15, 0.66, 0.4);
      brow.rotation.z = sx * 0.45;
      paintFacets(brow, hex("#2a0d16"), 0, 55);
      parts.push(brow);
    }
  }
  if (boss) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = MeshBuilder.CreateCylinder("crown", { height: 0.22, diameterTop: 0, diameterBottom: 0.12, tessellation: 6 }, scene);
      spike.position.set(Math.cos(a) * 0.16, 0.8, Math.sin(a) * 0.16);
      paintFacets(spike, hex("#f2c14b"), 0, 60 + i);
      parts.push(spike);
    }
    const band = MeshBuilder.CreateTorus("cband", { diameter: 0.36, thickness: 0.06, tessellation: 20 }, scene);
    band.position.y = 0.72;
    paintSmooth(band, hex("#e3a92f"));
    parts.push(band);
  } else {
    const sprout = MeshBuilder.CreateCylinder("sprout", { height: 0.18, diameterTop: 0, diameterBottom: 0.08, tessellation: 6 }, scene);
    sprout.position.set(0.05, 0.8, 0);
    sprout.rotation.z = -0.4;
    paintSmooth(sprout, hex(body).scale(0.9));
    parts.push(sprout);
  }
  const m = merge(parts, name);
  return m;
}

// ───────────── pickups ─────────────
export function makeRupee(scene: Scene, name: string, color: string): Mesh {
  const r = MeshBuilder.CreatePolyhedron(name, { type: 1, size: 0.13 }, scene);
  r.scaling.set(0.8, 1.7, 0.45);
  r.bakeCurrentTransformIntoVertices();
  paintFacets(r, hex(color), 0.18, 71);
  const m = material(scene, name + "-mat", "#ffffff", { spec: 0.9 });
  m.emissiveColor = hex(color).scale(0.45);
  r.material = m;
  return r;
}

export function makeHeart(scene: Scene): Mesh {
  const l = MeshBuilder.CreateIcoSphere("hl", { radius: 0.11, subdivisions: 1 }, scene);
  l.position.set(-0.075, 0.05, 0);
  const r = MeshBuilder.CreateIcoSphere("hr", { radius: 0.11, subdivisions: 1 }, scene);
  r.position.set(0.075, 0.05, 0);
  const tip = MeshBuilder.CreateCylinder("ht", { height: 0.2, diameterTop: 0.27, diameterBottom: 0, tessellation: 6 }, scene);
  tip.position.y = -0.06;
  for (const p of [l, r, tip]) paintFacets(p, hex("#e8414f"), 0.12, 72);
  const m = merge([l, r, tip], "heart");
  const mat = material(scene, "heart-mat", "#ffffff", { spec: 0.5 });
  mat.emissiveColor = hex("#7a1020");
  m.material = mat;
  return m;
}

export function makeKey(scene: Scene): Mesh {
  const ring = MeshBuilder.CreateTorus("kr", { diameter: 0.2, thickness: 0.06, tessellation: 10 }, scene);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.2;
  const shaft = MeshBuilder.CreateBox("ks", { width: 0.05, height: 0.32, depth: 0.05 }, scene);
  shaft.position.y = -0.04;
  const t1 = MeshBuilder.CreateBox("kt", { width: 0.1, height: 0.04, depth: 0.05 }, scene);
  t1.position.set(0.06, -0.15, 0);
  const t2 = t1.clone("kt2")!;
  t2.position.y = -0.08;
  for (const p of [ring, shaft, t1, t2]) paintFacets(p, hex("#f2c14b"), 0.12, 81);
  const m = merge([ring, shaft, t1, t2], "key");
  const mat = material(scene, "key-mat", "#ffffff", { spec: 0.9 });
  mat.emissiveColor = hex("#7a5a10");
  m.material = mat;
  return m;
}

export { Color4 };
