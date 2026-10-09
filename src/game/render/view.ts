/**
 * Babylon.js view layer. It owns meshes, lights, camera and particles, and only READS game state:
 * `sync(state, dt)` positions everything to match the store each frame; `handleEvent` spawns
 * cosmetic effects (sparks, debris, poofs, shake). No game rules live here.
 */
import {
  Camera,
  Color3,
  Color4,
  ColorCurves,
  DirectionalLight,
  Engine,
  EngineInstrumentation,
  ImageProcessingConfiguration,
  SceneInstrumentation,
  FreeCamera,
  GlowLayer,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  PointLight,
  Quaternion,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Texture,
  Vector3,
  VertexBuffer,
  VertexData,
  type AbstractMesh,
} from "@babylonjs/core";
import { BOSS_AIM_LOCK, BOSS_LUNGE_DIST, BOSS_R, GLOB_FUSE, GLOB_SPLASH_R, PLAYER_R, SWING_HALF_ARC, SWING_TIME } from "../constants";
import { hash2, makeRng } from "../rng";
import { chestVisible, gateClosed } from "../sim";
import type { GameEvent, GameState } from "../types";
import { CHEST, DUNGEON, GATE_ROW, MAPS, OVERWORLD, PEDESTAL, SPAWN, Tile, type MapData, type MapId } from "../world";
import { SwayPlugin, bakeHeightAO, makeShimmerTexture, swayClock } from "./fx";
import {
  hex,
  makeBlob,
  makeBloom,
  makeHedge,
  makeHeart,
  makeHeroParts,
  makeKey,
  makePine,
  makePot,
  makeRock,
  makeRoundTree,
  makeRupee,
  makeTuft,
  material,
  merge,
  paintFacets,
} from "./meshes";

const MAP_OFFSET: Record<MapId, number> = { over: 0, dungeon: 120 };

/** Map space (x east, y south) → Babylon world (x right, y up, z north/away from camera). */
export function toWorld(map: MapId, x: number, y: number, h = 0, out?: Vector3): Vector3 {
  return out ? out.set(x + MAP_OFFSET[map], h, -y) : new Vector3(x + MAP_OFFSET[map], h, -y);
}

/** Glob hit radius for the hero's centre — the fuse ring is drawn exactly here. */
const GLOB_HIT_R = GLOB_SPLASH_R + PLAYER_R / 2;
const LANE_W = BOSS_R * 0.85 * 2; // the Warden's collision width
const LANE_LEN = BOSS_LUNGE_DIST + BOSS_R * 0.85; // centre travel + front of the body

const tmpQ = new Quaternion();
const tmpS = new Vector3();
const tmpT = new Vector3();
function compose(x: number, y: number, z: number, s: number | Vector3, yaw = 0, tiltX = 0, tiltZ = 0): Matrix {
  if (typeof s === "number") tmpS.set(s, s, s);
  else tmpS.copyFrom(s);
  Quaternion.RotationYawPitchRollToRef(yaw, tiltX, tiltZ, tmpQ);
  tmpT.set(x, y, z);
  return Matrix.Compose(tmpS, tmpQ, tmpT);
}
const ZERO = Matrix.Compose(new Vector3(0, 0, 0), Quaternion.Identity(), new Vector3(0, -50, 0));

function screenOf(x: number, y: number) {
  return { sx: Math.min(2, Math.max(0, Math.floor(x / 16))), sy: Math.min(1, Math.max(0, Math.floor(y / 12))) };
}

/**
 * Static scenery is split into chunks so frustum culling can drop what's off screen:
 * overworld screens 0-5 (sy*3+sx) and the vault's antechamber (6) / hall (7) — the same ids as
 * `state.explored`. Takes Babylon world x/z.
 */
function chunkOfWorld(wx: number, wz: number): number {
  const y = -wz;
  if (wx > 80) return y < GATE_ROW + 0.5 ? 7 : 6;
  const { sx, sy } = screenOf(wx, y);
  return sy * 3 + sx;
}
/** distance (map tiles) from a map-space point to a chunk's rectangle */
function chunkDist(chunk: number, map: MapId, x: number, y: number): number {
  let x0: number, x1: number, y0: number, y1: number;
  if (chunk >= 6) {
    if (map !== "dungeon") return Infinity;
    x0 = 0; x1 = 16;
    [y0, y1] = chunk === 7 ? [0, GATE_ROW + 0.5] : [GATE_ROW + 0.5, 23];
  } else {
    if (map !== "over") return Infinity;
    x0 = (chunk % 3) * 16; x1 = x0 + 16;
    y0 = Math.floor(chunk / 3) * 12; y1 = y0 + 12;
  }
  const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
  return Math.hypot(dx, dy);
}

/** Sway weights are baked into vertex alpha as a fraction of this many world units. */
const SWAY_MAX = 0.14;

interface BakeBucket {
  group: string;
  chunk: number;
  pos: number[];
  nrm: number[];
  col: number[];
  idx: number[];
}
const bv = new Vector3();

/** Where one input matrix of a chunked thin-instance set ended up. */
interface ThinSlot {
  mesh: Mesh;
  idx: number;
}

// Palette: each area has its own grass tone.
const AREA_GRASS = [
  ["#5e9c4c", "#a6a361", "#79c06b"], // Thistlewick Wood, Cinderstone Crags, Mirelight Pond
  ["#9cc95a", "#86bd5c", "#b8a64e"], // Bramblebell Meadow, Hearthollow, Lanternfall Glade
];

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  g: number;
  c: Color3;
  spin: number;
}

interface EnemyView {
  root: TransformNode;
  mesh: Mesh;
  mat: StandardMaterial;
  wasAlive: boolean;
  spawnT: number;
  yaw: number;
}

export class GameView {
  engine: Engine;
  scene: Scene;
  camera: FreeCamera;
  private glow: GlowLayer;
  private hemi: HemisphericLight;
  private sun: DirectionalLight;
  private shadows: ShadowGenerator;
  private roomLights: PointLight[] = [];
  private flames: Mesh[] = [];
  private heroRoot: TransformNode;
  private heroBody: Mesh;
  private swordPivot: TransformNode;
  private arc: Mesh;
  private arcPositions: Float32Array;
  private arcColors: Float32Array;
  private heroYaw = Math.PI;
  private walkPhase = 0;
  private enemyViews = new Map<number, EnemyView>();
  private blobTemplate: Mesh;
  private bossTemplate: Mesh;
  private pickupMeshes = new Map<number, AbstractMesh>();
  private rupeeG: Mesh;
  private rupeeB: Mesh;
  private heartMesh: Mesh;
  private tuftMesh: Mesh;
  private potMesh: Mesh;
  private breakIndex = new Map<number, { mesh: Mesh; idx: number; matrix: Matrix; shown: boolean }>();
  private keyMesh: Mesh;
  private gateNode: TransformNode;
  private gateY = 0;
  private chestNode: TransformNode;
  private chestLid: TransformNode;
  private chestScale = 0;
  private water: Mesh;
  private stars: Mesh[] = [];
  private globBase: Mesh;
  private ringBase: Mesh;
  private discBase: Mesh;
  private puddleBase: Mesh;
  private globMeshes = new Map<number, { ball: Mesh | AbstractMesh; ring: AbstractMesh; disc: AbstractMesh; landed: boolean }>();
  private laneRoot: TransformNode;
  private laneBg: Mesh;
  private laneFill: Mesh;
  private laneHead: Mesh;
  private laneBgMat: StandardMaterial;
  private laneFillMat: StandardMaterial;
  private laneYaw = 0;
  private laneAlpha = 0;
  private tmpV = new Vector3();
  private tmpV2 = new Vector3();
  private staticCasters: { mesh: Mesh; chunk: number; on: boolean }[] = [];
  private buckets = new Map<string, BakeBucket>();
  private shadowKey = -1;
  private sceneInst: SceneInstrumentation | null = null;
  private engineInst: EngineInstrumentation | null = null;
  private baseScale = 1;
  private hwScale = 1;
  private adaptive = true;
  private fpsAcc = 0;
  private fpsN = 0;
  private adaptT = 0;
  private waterMat!: StandardMaterial;
  private shimmer!: Texture;
  private swayMats: StandardMaterial[] = [];
  private dynamicMats = new Set<StandardMaterial>();
  private seenA = new Set<number>();
  private seenB = new Set<number>();
  private dirty = new Set<Mesh>();
  private evOut: GameEvent[] = [];
  private puddleMeshes = new Map<number, AbstractMesh>();
  private particles: Particle[] = [];
  private particleMesh: Mesh;
  private particleMatrices: Float32Array;
  private particleColors: Float32Array;
  private readonly MAX_P = 500;
  private camTarget = new Vector3();
  private shake = 0;
  private time = 0;
  private currentMap: MapId | null = null;
  private lastSeq = 0;
  private lastState: GameState | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true }, true);
    this.baseScale = this.hwScale = 1 / Math.min(window.devicePixelRatio || 1, 2);
    this.engine.setHardwareScalingLevel(this.hwScale);
    // automation renders on a software GPU: keep full resolution there so screenshots stay sharp
    this.adaptive = !navigator.webdriver || location.search.includes("adaptive=1");
    const scene = (this.scene = new Scene(this.engine));
    scene.clearColor = Color4.FromHexString("#f4c79aff");
    scene.ambientColor = new Color3(0.2, 0.2, 0.2);
    scene.skipPointerMovePicking = true;
    scene.skipPointerDownPicking = true;
    scene.skipPointerUpPicking = true;
    // colour grading lives in the material shaders (no extra post-process pass)
    const ip = scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.32;
    ip.contrast = 1.12;
    ip.colorCurvesEnabled = true;
    const curves = new ColorCurves();
    curves.globalSaturation = 22;
    curves.shadowsHue = 265;
    curves.shadowsDensity = 18;
    curves.shadowsSaturation = 30;
    curves.highlightsHue = 40;
    curves.highlightsDensity = 12;
    curves.highlightsSaturation = 25;
    ip.colorCurves = curves;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = 1.6;
    ip.vignetteStretch = 0.35;
    ip.vignetteColor = new Color4(0.12, 0.04, 0.16, 0);
    ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
    ip.vignetteCameraFov = 0.72;
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.012;
    scene.fogColor = hex("#f4c79a");

    this.camera = new FreeCamera("cam", new Vector3(SPAWN.x, 12, -SPAWN.y - 8), scene);
    this.camera.fov = 0.72;
    this.camera.minZ = 0.3;
    this.camera.maxZ = 200;
    this.camera.inputs.clear();

    this.hemi = new HemisphericLight("hemi", new Vector3(0.1, 1, -0.2), scene);
    this.sun = new DirectionalLight("sun", new Vector3(-0.55, -1, 0.45).normalize(), scene);
    this.sun.autoUpdateExtends = false;
    this.sun.shadowFrustumSize = 30;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = 80;
    const coarse = matchMedia("(pointer: coarse)").matches;
    this.shadows = new ShadowGenerator(coarse ? 1024 : 2048, this.sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.shadows.bias = 0.0015;
    this.shadows.normalBias = 0.01;
    this.shadows.darkness = 0.35;

    const glow = (this.glow = new GlowLayer("glow", scene, { blurKernelSize: 32, mainTextureRatio: 0.4 }));
    glow.intensity = 0.55;
    // only things that actually glow are drawn into the glow pass (it used to redraw the whole scene)
    glow.addIncludedOnlyMesh(new Mesh("glowAnchor", scene));

    this.buildBackdrop();
    this.buildGround(OVERWORLD);
    this.buildGround(DUNGEON);
    this.water = this.buildWater();
    this.buildOverworldProps();
    this.buildDungeonProps();
    this.flushBakes();
    const tuftPot = this.buildBreakables();
    this.tuftMesh = tuftPot.tuft;
    this.potMesh = tuftPot.pot;

    // hero
    const { hero, sword } = makeHeroParts(scene);
    this.heroRoot = new TransformNode("heroRoot", scene);
    this.heroBody = hero;
    hero.parent = this.heroRoot;
    this.shadows.addShadowCaster(hero);
    this.swordPivot = new TransformNode("swordPivot", scene);
    this.swordPivot.parent = this.heroRoot;
    this.swordPivot.position.y = 0.42;
    sword.parent = this.swordPivot;
    this.shadows.addShadowCaster(sword);
    this.swordPivot.setEnabled(false);
    const arc = this.buildArc();
    this.arc = arc.mesh;
    this.arcPositions = arc.positions;
    this.arcColors = arc.colors;

    // enemy templates
    this.blobTemplate = makeBlob(scene, "blobT", "#8e4fb8", "#c58be0", "#fff4b8", false);
    this.blobTemplate.setEnabled(false);
    this.bossTemplate = makeBlob(scene, "bossT", "#b8323f", "#ef8a6a", "#ffe066", true);
    this.bossTemplate.setEnabled(false);

    // pickups
    this.rupeeG = makeRupee(scene, "rupeeG", "#2ee88a");
    this.rupeeB = makeRupee(scene, "rupeeB", "#4aa8ff");
    this.heartMesh = makeHeart(scene);
    for (const m of [this.rupeeG, this.rupeeB, this.heartMesh]) m.setEnabled(false);

    // key on pedestal
    this.keyMesh = makeKey(scene);
    this.keyMesh.position = toWorld("dungeon", PEDESTAL.x, PEDESTAL.y, 1.25);
    this.shadows.addShadowCaster(this.keyMesh);

    const g = this.buildGate();
    this.gateNode = g;
    const c = this.buildChest();
    this.chestNode = c.node;
    this.chestLid = c.lid;

    // boss: dizzy stars, globs, landing markers, puddles
    const starMat = material(scene, "star-mat", "#ffe066", { emissive: "#ffcc33" });
    for (let i = 0; i < 4; i++) {
      const st = MeshBuilder.CreatePolyhedron("star" + i, { type: 2, size: 0.11 }, scene);
      st.material = starMat;
      st.setEnabled(false);
      this.stars.push(st);
    }
    this.globBase = MeshBuilder.CreateIcoSphere("glob", { radius: 0.26, subdivisions: 1 }, scene);
    paintFacets(this.globBase, hex("#5b2a7a"), 0.2, 91);
    const gm = material(scene, "glob-mat", "#ffffff", { spec: 0.6 });
    gm.emissiveColor = hex("#3a7a1a");
    this.globBase.material = gm;
    this.globBase.registerInstancedBuffer("color", 4);
    this.globBase.instancedBuffers.color = new Color4(1, 1, 1, 1);
    this.globBase.setEnabled(false);
    this.ringBase = MeshBuilder.CreateTorus("globRing", { diameter: 2, thickness: 0.07, tessellation: 28 }, scene);
    const rm = material(scene, "ring-mat", "#ff5a7a", { emissive: "#ff2a5a" });
    rm.disableLighting = true;
    this.ringBase.material = rm;
    this.ringBase.registerInstancedBuffer("color", 4);
    this.ringBase.instancedBuffers.color = new Color4(1, 1, 1, 1);
    this.ringBase.setEnabled(false);
    // lunge lane: a ground decal from the Warden to his max reach (local +z = forward, length 1)
    this.laneRoot = new TransformNode("laneRoot", scene);
    const lanePlane = (name: string, mat: StandardMaterial, y: number) => {
      const m = MeshBuilder.CreateGround(name, { width: 1, height: 1 }, scene);
      m.position.z = 0.5;
      m.bakeCurrentTransformIntoVertices();
      m.position.y = y;
      m.material = mat;
      m.parent = this.laneRoot;
      m.isPickable = false;
      return m;
    };
    this.laneBgMat = material(scene, "lane-bg", "#ff7a3a", { emissive: "#ff5a1a", alpha: 0.18 });
    this.laneBgMat.disableLighting = true;
    this.laneFillMat = material(scene, "lane-fill", "#ffb03a", { emissive: "#ff8a1a", alpha: 0.4 });
    this.laneFillMat.disableLighting = true;
    this.laneBg = lanePlane("laneBg", this.laneBgMat, 0.035);
    this.laneFill = lanePlane("laneFill", this.laneFillMat, 0.045);
    const head = MeshBuilder.CreateDisc("laneHead", { radius: 0.5, tessellation: 3 }, scene);
    head.rotation.x = Math.PI / 2;
    head.rotation.y = -Math.PI / 2; // a vertex points along +z
    head.bakeCurrentTransformIntoVertices();
    head.material = this.laneFillMat;
    head.parent = this.laneRoot;
    head.position.y = 0.05;
    this.laneHead = head;
    this.laneRoot.setEnabled(false);
    this.discBase = MeshBuilder.CreateDisc("globDisc", { radius: 1, tessellation: 28 }, scene);
    this.discBase.rotation.x = Math.PI / 2;
    this.discBase.bakeCurrentTransformIntoVertices();
    const dm = material(scene, "disc-mat", "#ff3a6a", { emissive: "#a0103a", alpha: 0.28 });
    dm.disableLighting = true;
    this.discBase.material = dm;
    this.discBase.registerInstancedBuffer("color", 4);
    this.discBase.instancedBuffers.color = new Color4(1, 1, 1, 1);
    this.discBase.setEnabled(false);
    this.puddleBase = MeshBuilder.CreateDisc("puddle", { radius: 1, tessellation: 12 }, scene);
    this.puddleBase.rotation.x = Math.PI / 2;
    this.puddleBase.bakeCurrentTransformIntoVertices();
    const pdm = material(scene, "puddle-mat", "#3b1a52", { emissive: "#4a8a1a", alpha: 0.85, spec: 0.8 });
    this.puddleBase.material = pdm;
    this.puddleBase.setEnabled(false);

    // particles
    const pm = MeshBuilder.CreateBox("particle", { size: 1 }, scene);
    const pmat = material(scene, "particle-mat", "#ffffff", { spec: 0 });
    pmat.emissiveColor = new Color3(0.35, 0.35, 0.35);
    pm.material = pmat;
    this.particleMatrices = new Float32Array(this.MAX_P * 16);
    this.particleColors = new Float32Array(this.MAX_P * 4);
    for (let i = 0; i < this.MAX_P; i++) ZERO.copyToArray(this.particleMatrices, i * 16);
    pm.thinInstanceSetBuffer("matrix", this.particleMatrices, 16, false);
    pm.thinInstanceSetBuffer("color", this.particleColors, 4, false);
    pm.alwaysSelectAsActiveMesh = true;
    pm.isPickable = false;
    this.particleMesh = pm;

    for (const m of [...this.flames, ...this.stars, this.globBase, this.ringBase, this.laneFill, this.laneHead, this.keyMesh, pm, this.rupeeG, this.rupeeB, this.heartMesh])
      this.glow.addIncludedOnlyMesh(m);
    for (const name of ["rune", "win"]) {
      const m = scene.getMeshByName(name);
      if (m) this.glow.addIncludedOnlyMesh(m as Mesh);
    }
    // materials whose uniforms we change after startup stay live; everything else is frozen
    for (const m of [this.laneBgMat, this.laneFillMat, this.waterMat, ...this.swayMats]) this.dynamicMats.add(m);
    for (const mesh of [this.heroBody, ...this.swordPivot.getChildMeshes()]) if (mesh.material instanceof StandardMaterial) this.dynamicMats.add(mesh.material);
    for (const m of scene.materials) if (m instanceof StandardMaterial && !this.dynamicMats.has(m)) m.freeze();
  }

  // ───────────── static world ─────────────
  private buildBackdrop() {
    const s = this.scene;
    const far = MeshBuilder.CreateGround("backdrop", { width: 220, height: 160 }, s);
    far.position.set(24, -0.6, -12);
    far.material = material(s, "backdrop-mat", "#2f5a35");
    far.receiveShadows = true;
    const dun = MeshBuilder.CreateGround("backdropD", { width: 80, height: 80 }, s);
    dun.position.set(MAP_OFFSET.dungeon + 8, -0.5, -12);
    dun.material = material(s, "backdropD-mat", "#09070d");
  }

  private groundColor(map: MapData, t: number, x: number, y: number): Color3 {
    // ambient occlusion: darken floor tiles hugged by walls / trees / rocks / hedges
    let occ = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
        const nt = map.tiles[ny * map.w + nx];
        const solid = map.id === "dungeon" ? nt === Tile.WALL : nt === Tile.TREE || nt === Tile.ROCK || nt === Tile.HEDGE;
        if (solid) occ += dx && dy ? 0.6 : 1;
      }
    const ao = 1 - Math.min(0.3, occ * (map.id === "dungeon" ? 0.07 : 0.045));
    const v = (1 + (hash2(x, y, 9) - 0.5) * 0.09) * ao;
    let c: Color3;
    if (map.id === "dungeon") {
      const checker = (x + y) % 2 === 0 ? 1 : 0.92;
      c = hex(t === Tile.DOOR ? "#0b0910" : "#6a6478").scale(checker);
    } else if (t === Tile.PATH) c = hex("#dcb877");
    else if (t === Tile.BRIDGE) c = hex("#a8744a").scale((x % 2) * 0.1 + 0.95);
    else if (t === Tile.DOOR) c = hex("#120d14");
    else if (t === Tile.ROCK) c = hex("#9a8f78");
    else {
      const { sx, sy } = screenOf(x, y);
      c = hex(AREA_GRASS[sy][sx]);
      if (t === Tile.HEDGE) c = c.scale(0.85);
    }
    return c.scale(v);
  }

  private buildGround(map: MapData) {
    const s = this.scene;
    const byKind: Record<string, { m: Matrix[]; c: number[]; h: number; top: number }> = {};
    const push = (k: string, h: number, top: number, x: number, y: number, col: Color3) => {
      if (!byKind[k]) byKind[k] = { m: [], c: [], h, top };
      const p = toWorld(map.id, x + 0.5, y + 0.5, top - h / 2, this.tmpV);
      byKind[k].m.push(compose(p.x, p.y, p.z, this.tmpV2.set(1, h, 1)));
      byKind[k].c.push(col.r, col.g, col.b, 1);
    };
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) {
        const t = map.tiles[y * map.w + x];
        if (map.id === "dungeon") {
          if (t === Tile.WALL) {
            // south-facing walls stay low so they never hide the hero
            const southWall = y === GATE_ROW || y === map.h - 1;
            const isPillar = x > 0 && x < map.w - 1 && y > 0 && y < map.h - 1 && y !== GATE_ROW;
            const h = southWall ? 0.6 : isPillar ? 1.5 : 2.2;
            const col = hex("#4a4558").scale(1 + (hash2(x, y, 3) - 0.5) * 0.15);
            push(southWall ? "wallLow" : isPillar ? "pillar" : "wall", h + 0.1, h, x, y, col);
          } else push("floor", 0.2, 0, x, y, this.groundColor(map, t, x, y));
          continue;
        }
        if (t === Tile.WATER) {
          push("bed", 0.2, -0.45, x, y, hex("#2c6f72"));
          continue;
        }
        if (t === Tile.BRIDGE) {
          push("bed", 0.2, -0.45, x, y, hex("#2c6f72"));
          push("plank", 0.12, 0.04, x, y, this.groundColor(map, t, x, y));
          continue;
        }
        const top = t === Tile.PATH || t === Tile.DOOR ? -0.015 : 0;
        push(t === Tile.PATH ? "path" : "grass", 0.6, top, x, y, this.groundColor(map, t, x, y));
      }
    // every tile is the same unit box: bake them all into one ground (and one wall) mesh per chunk
    const box = MeshBuilder.CreateBox(`${map.id}-tile`, { size: 1 }, s);
    for (const [k, d] of Object.entries(byKind)) {
      const isWall = k.startsWith("wall") || k === "pillar";
      this.bake(isWall ? "walls" : "ground", box, d.m, { colors: d.c });
    }
    if (map.id === "dungeon") {
      // wall caps for a bit of definition
      const caps: Matrix[] = [];
      for (let y = 0; y < map.h; y++)
        for (let x = 0; x < map.w; x++) {
          if (map.tiles[y * map.w + x] !== Tile.WALL) continue;
          const southWall = y === GATE_ROW || y === map.h - 1;
          const isPillar = x > 0 && x < map.w - 1 && y > 0 && y < map.h - 1 && y !== GATE_ROW;
          const h = southWall ? 0.6 : isPillar ? 1.5 : 2.2;
          const p = toWorld("dungeon", x + 0.5, y + 0.5, h + 0.04, this.tmpV);
          caps.push(compose(p.x, p.y, p.z, this.tmpV2.set(1.04, 0.08, 1.04)));
        }
      const capCol = hex("#7c768c");
      const cc: number[] = [];
      for (let i = 0; i < caps.length; i++) cc.push(capCol.r, capCol.g, capCol.b, 1);
      this.bake("walls", box, caps, { colors: cc });
    }
    box.dispose();
  }

  private buildWater(): Mesh {
    const s = this.scene;
    const w = MeshBuilder.CreateGround("water", { width: 48, height: 24, subdivisions: 1 }, s);
    w.position.set(24, -0.14, -12);
    const m = material(s, "water-mat", "#0c3a48", { spec: 0.8, alpha: 0.88 });
    m.specularPower = 48;
    m.emissiveColor = hex("#0a3238");
    // animated shimmer: a tiling streak texture scrolled in two directions (see sync)
    this.shimmer = makeShimmerTexture(s);
    this.shimmer.uScale = 9;
    this.shimmer.vScale = 4.5;
    this.shimmer.level = 0.35;
    m.emissiveTexture = this.shimmer;
    this.waterMat = m;
    w.material = m;
    w.receiveShadows = true;
    return w;
  }

  /**
   * Static batching: transform `mesh`'s vertices by every matrix and append them to the bucket of
   * (group, chunk). Vertex colour = template colour × instance colour; alpha = sway weight
   * (local height² × `sway`, as a fraction of SWAY_MAX) for the foliage shader.
   */
  private bake(group: string, mesh: Mesh, mats: Matrix[], opts: { colors?: number[]; sway?: number } = {}) {
    const P = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const N = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const C = mesh.getVerticesData(VertexBuffer.ColorKind);
    const I = mesh.getIndices()!;
    const nv = P.length / 3;
    mats.forEach((m, mi) => {
      const chunk = chunkOfWorld(m.m[12], m.m[14]);
      const key = `${group}|${chunk}`;
      let b = this.buckets.get(key);
      if (!b) this.buckets.set(key, (b = { group, chunk, pos: [], nrm: [], col: [], idx: [] }));
      const base = b.pos.length / 3;
      const ir = opts.colors ? opts.colors[mi * 4] : 1, ig = opts.colors ? opts.colors[mi * 4 + 1] : 1, ib = opts.colors ? opts.colors[mi * 4 + 2] : 1;
      for (let v = 0; v < nv; v++) {
        Vector3.TransformCoordinatesFromFloatsToRef(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m, bv);
        b.pos.push(bv.x, bv.y, bv.z);
        Vector3.TransformNormalFromFloatsToRef(N[v * 3], N[v * 3 + 1], N[v * 3 + 2], m, bv);
        bv.normalize();
        b.nrm.push(bv.x, bv.y, bv.z);
        const y = Math.max(0, P[v * 3 + 1]);
        const w = opts.sway ? Math.min(1, (opts.sway * y * y) / SWAY_MAX) : 0;
        b.col.push((C ? C[v * 4] : 1) * ir, (C ? C[v * 4 + 1] : 1) * ig, (C ? C[v * 4 + 2] : 1) * ib, w);
      }
      for (let i = 0; i < I.length; i++) b.idx.push(I[i] + base);
    });
  }

  private flushBakes() {
    const s = this.scene;
    const mats: Record<string, StandardMaterial> = {};
    const matFor = (group: string) => {
      if (mats[group]) return mats[group];
      const m = material(s, `baked-${group}-mat`, "#ffffff", { spec: group === "ground" ? 0.02 : group === "walls" ? 0.04 : 0.05, backFace: group !== "flora" });
      if (group === "scenery" || group === "flora") {
        new SwayPlugin(m, SWAY_MAX, "alpha");
        this.swayMats.push(m);
      }
      return (mats[group] = m);
    };
    for (const b of this.buckets.values()) {
      const mesh = new Mesh(`${b.group}#${b.chunk}`, s);
      const vd = new VertexData();
      vd.positions = b.pos;
      vd.normals = b.nrm;
      vd.colors = b.col;
      vd.indices = b.idx;
      vd.applyToMesh(mesh, false);
      mesh.hasVertexAlpha = false;
      mesh.material = matFor(b.group);
      mesh.receiveShadows = true;
      mesh.isPickable = false;
      mesh.freezeWorldMatrix();
      if (b.group === "scenery" || b.group === "walls") this.staticCasters.push({ mesh, chunk: b.chunk, on: false });
    }
    this.buckets.clear();
  }

  /**
   * Thin instances, split per chunk (screen / room): one clone of `mesh` (shared geometry and
   * material) per chunk, each with a tight bounding box so off-screen chunks are frustum-culled
   * and only nearby chunks cast shadows. `dynamic` must be true for instances we later hide/move
   * (static buffers are never re-uploaded). Returns where each input matrix landed.
   */
  private thin(mesh: Mesh, mats: Matrix[], cast = true, dynamic = false, colors?: number[]): ThinSlot[] {
    const out: ThinSlot[] = new Array(mats.length);
    if (!mats.length) {
      mesh.setEnabled(false);
      return out;
    }
    const groups = new Map<number, number[]>();
    mats.forEach((m, i) => {
      const k = chunkOfWorld(m.m[12], m.m[14]);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(i);
    });
    // clone BEFORE any buffers exist, and give every clone its own geometry: thin-instance buffers
    // are bound through the geometry's vertex buffers, so shared geometry would make chunks clobber each other
    const keys = [...groups.keys()];
    const base = mesh.name;
    const meshes = keys.map((k, i) => {
      const cm = i === 0 ? mesh : (mesh.clone(`${base}#${k}`) as Mesh);
      if (i > 0) cm.makeGeometryUnique();
      return cm;
    });
    mesh.name = `${base}#${keys[0]}`;
    for (let gi = 0; gi < keys.length; gi++) {
      const k = keys[gi], idxs = groups.get(k)!, cm = meshes[gi];
      const buf = new Float32Array(idxs.length * 16);
      idxs.forEach((src, j) => {
        mats[src].copyToArray(buf, j * 16);
        out[src] = { mesh: cm, idx: j };
      });
      cm.thinInstanceSetBuffer("matrix", buf, 16, !dynamic);
      if (colors) {
        const cb = new Float32Array(idxs.length * 4);
        idxs.forEach((src, j) => cb.set(colors.slice(src * 4, src * 4 + 4), j * 4));
        cm.thinInstanceSetBuffer("color", cb, 4, true);
      }
      cm.thinInstanceRefreshBoundingInfo(false);
      cm.receiveShadows = true;
      cm.isPickable = false;
      cm.freezeWorldMatrix();
      if (cast) this.staticCasters.push({ mesh: cm, chunk: k, on: false });
    }
    return out;
  }

  /** Only chunks near the camera go into the shadow map (it has no frustum culling of its own). */
  private updateShadowCasters(map: MapId, x: number, y: number) {
    let key = 0;
    for (let c = 0; c < 8; c++) if (chunkDist(c, map, x, y) < 9) key |= 1 << c;
    if (key === this.shadowKey) return;
    this.shadowKey = key;
    for (const sc of this.staticCasters) {
      const want = (key & (1 << sc.chunk)) !== 0;
      if (want === sc.on) continue;
      sc.on = want;
      if (want) this.shadows.addShadowCaster(sc.mesh, false);
      else this.shadows.removeShadowCaster(sc.mesh, false);
    }
  }

  private buildOverworldProps() {
    const s = this.scene;
    const m = OVERWORLD;
    const rnd = makeRng(99);
    const pines = [
      makePine(s, "pineA", ["#2f7a4f", "#3a8a58", "#4a9a62"], 1),
      makePine(s, "pineB", ["#28694a", "#2f7a55", "#3d8d63"], 2),
      makePine(s, "pineC", ["#3f8f5e", "#56a26a", "#6bb677"], 3),
    ];
    const autumn = [
      makeRoundTree(s, "oakA", ["#e0823a", "#f0a04b", "#d06a2e"], 4),
      makeRoundTree(s, "oakB", ["#e8b84a", "#f2cf63", "#d9a03a"], 5),
      makePine(s, "pineAut", ["#c9622f", "#de7d3a", "#eaa04c"], 6),
    ];
    const treeM: Matrix[][] = [[], [], [], [], [], []];
    const rocks = [makeRock(s, "rockA", "#8f8a84", 11), makeRock(s, "rockB", "#a29a8e", 12), makeRock(s, "rockC", "#77736f", 13)];
    const rockM: Matrix[][] = [[], [], []];
    const hedge = makeHedge(s);
    const hedgeM: Matrix[] = [];
    const blooms = ["#ff7a6b", "#ffd66b", "#b59cff", "#fff6e8"].map((c, i) => makeBloom(s, "bloom" + i, c));
    const bloomM: Matrix[][] = [[], [], [], []];
    const deco = makeTuft(s, "decoTuft", "#4f8a3c", "#a9d46a", 6, 8);
    const decoM: Matrix[] = [];
    for (const t of [...pines, ...autumn]) bakeHeightAO(t, 0.38, 0.5);
    rocks.forEach((r) => bakeHeightAO(r, 0.3, 0.6));
    bakeHeightAO(hedge, 0.32, 0.7);

    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const t = m.tiles[y * m.w + x];
        const p = toWorld("over", x + 0.5, y + 0.5);
        const { sx, sy } = screenOf(x, y);
        const edge = x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1;
        if (t === Tile.TREE) {
          const glade = sx === 2 && sy === 1;
          let v: number;
          if (glade) v = 3 + Math.floor(rnd() * 3);
          else if (sx === 0 && sy === 0) v = rnd() < 0.6 ? 1 : 0;
          else v = Math.floor(rnd() * 3);
          const sc = (edge ? 1.15 : 0.85) + rnd() * 0.4;
          treeM[v].push(
            compose(p.x + (rnd() - 0.5) * 0.3, 0, p.z + (rnd() - 0.5) * 0.3, new Vector3(sc * (0.9 + rnd() * 0.2), sc * (0.85 + rnd() * 0.35), sc * (0.9 + rnd() * 0.2)), rnd() * 6.28, (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.1),
          );
        } else if (t === Tile.ROCK) {
          const v = Math.floor(rnd() * 3);
          const cliff = sy === 0 && sx === 1 && y <= 3;
          const base = cliff ? 1.1 + rnd() * 0.35 : 0.75 + rnd() * 0.35;
          const sv = new Vector3(base * (0.85 + rnd() * 0.4), base * (cliff ? 1.3 + rnd() * 0.9 : 0.6 + rnd() * 0.5), base * (0.85 + rnd() * 0.4));
          rockM[v].push(compose(p.x + (rnd() - 0.5) * 0.15, 0.12, p.z + (rnd() - 0.5) * 0.15, sv, rnd() * 6.28, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3));
          // pebble companion
          if (rnd() < 0.4) {
            const ps = 0.25 + rnd() * 0.2;
            rockM[(v + 1) % 3].push(compose(p.x + (rnd() - 0.5) * 0.8, 0.02, p.z + (rnd() - 0.5) * 0.8, new Vector3(ps, ps * 0.6, ps), rnd() * 6.28));
          }
        } else if (t === Tile.HEDGE) {
          hedgeM.push(compose(p.x, 0, p.z, new Vector3(1, 0.9 + hash2(x, y, 4) * 0.25, 1), (Math.floor(rnd() * 4) * Math.PI) / 2));
        } else if (t === Tile.FLOWERS) {
          const n = 3 + Math.floor(rnd() * 3);
          const col = Math.floor(rnd() * 4);
          for (let i = 0; i < n; i++) {
            const c = rnd() < 0.75 ? col : Math.floor(rnd() * 4);
            bloomM[c].push(compose(p.x + (rnd() - 0.5) * 0.8, 0, p.z + (rnd() - 0.5) * 0.8, 0.8 + rnd() * 0.6, rnd() * 6.28));
          }
          if (rnd() < 0.6) decoM.push(compose(p.x + (rnd() - 0.5) * 0.7, 0, p.z + (rnd() - 0.5) * 0.7, 0.5 + rnd() * 0.3, rnd() * 6.28));
        } else if (t === Tile.GRASS) {
          if (rnd() < 0.35) decoM.push(compose(p.x + (rnd() - 0.5) * 0.8, 0, p.z + (rnd() - 0.5) * 0.8, 0.4 + rnd() * 0.35, rnd() * 6.28));
        }
      }
    // static scenery is baked per chunk: one "scenery" mesh (trees, rocks, hedges — casts shadows)
    // and one "flora" mesh (flowers, grass tufts) per screen, each with its own sway weights
    [...pines, ...autumn].forEach((mesh, i) => this.bake("scenery", mesh, treeM[i], { sway: 0.02 }));
    rocks.forEach((mesh, i) => this.bake("scenery", mesh, rockM[i]));
    this.bake("scenery", hedge, hedgeM, { sway: 0.03 });
    blooms.forEach((mesh, i) => this.bake("flora", mesh, bloomM[i], { sway: 0.9 }));
    this.bake("flora", deco, decoM, { sway: 0.7 });
    for (const m of [...pines, ...autumn, ...rocks, hedge, ...blooms, deco]) {
      m.material?.dispose();
      m.dispose();
    }

    this.buildCottage(toWorld("over", 18.5, 15));
    this.buildWell(toWorld("over", 27.5, 14.5));
    this.buildArch(toWorld("over", 24, 2.5));
    this.buildSign(toWorld("over", 21.4, 4.3));
  }

  private sway(mesh: Mesh, amp: number) {
    const m = mesh.material;
    if (!(m instanceof StandardMaterial) || this.swayMats.includes(m)) return;
    new SwayPlugin(m, amp);
    this.swayMats.push(m);
  }

  private buildCottage(at: Vector3) {
    const s = this.scene;
    const parts: Mesh[] = [];
    const walls = MeshBuilder.CreateBox("cw", { width: 2.7, height: 1.3, depth: 1.8 }, s);
    walls.position.y = 0.65;
    paintFacets(walls, hex("#f1e3c6"), 0.04, 1);
    parts.push(walls);
    const roof = MeshBuilder.CreateCylinder("roof", { height: 3.1, diameter: 2.5, tessellation: 3 }, s);
    roof.rotation.z = Math.PI / 2;
    roof.rotation.x = Math.PI / 6;
    roof.position.y = 1.65;
    roof.scaling.set(1, 1, 0.8);
    paintFacets(roof, hex("#c8553d"), 0.08, 2);
    parts.push(roof);
    const door = MeshBuilder.CreateBox("door", { width: 0.5, height: 0.8, depth: 0.08 }, s);
    door.position.set(0.5, 0.4, -0.92);
    paintFacets(door, hex("#6b4226"), 0.05, 3);
    parts.push(door);
    const chimney = MeshBuilder.CreateBox("chim", { width: 0.3, height: 0.8, depth: 0.3 }, s);
    chimney.position.set(-0.8, 2.1, 0.3);
    paintFacets(chimney, hex("#8d7b6a"), 0.08, 4);
    parts.push(chimney);
    const m = merge(parts, "cottage");
    bakeHeightAO(m, 0.3, 0.35);
    m.material = material(s, "cottage-mat", "#ffffff");
    m.position = at.add(new Vector3(0, 0, 0));
    m.receiveShadows = true;
    this.shadows.addShadowCaster(m);
    const win = MeshBuilder.CreateBox("win", { width: 0.42, height: 0.36, depth: 0.06 }, s);
    win.position = at.add(new Vector3(-0.6, 0.75, -0.92));
    win.material = material(s, "win-mat", "#ffd27a", { emissive: "#c98a2a" });
  }

  private buildWell(at: Vector3) {
    const s = this.scene;
    const ring = MeshBuilder.CreateCylinder("wellring", { height: 0.5, diameter: 0.95, tessellation: 8 }, s);
    ring.position.y = 0.25;
    paintFacets(ring, hex("#9a948c"), 0.12, 5);
    const posts: Mesh[] = [];
    for (const sx of [-1, 1]) {
      const p = MeshBuilder.CreateBox("post", { width: 0.08, height: 1.0, depth: 0.08 }, s);
      p.position.set(sx * 0.42, 0.75, 0);
      paintFacets(p, hex("#6b4226"), 0.05, 6);
      posts.push(p);
    }
    const roof = MeshBuilder.CreateCylinder("wroof", { height: 1.1, diameter: 0.8, tessellation: 3 }, s);
    roof.rotation.z = Math.PI / 2;
    roof.rotation.x = Math.PI / 6;
    roof.position.y = 1.35;
    paintFacets(roof, hex("#3d6f8c"), 0.08, 7);
    const m = merge([ring, ...posts, roof], "well");
    m.material = material(s, "well-mat", "#ffffff");
    m.position = at;
    m.receiveShadows = true;
    this.shadows.addShadowCaster(m);
    const water = MeshBuilder.CreateCylinder("wellw", { height: 0.02, diameter: 0.75, tessellation: 8 }, s);
    water.position = at.add(new Vector3(0, 0.42, 0));
    water.material = material(s, "wellw-mat", "#1e5d66", { emissive: "#0d3f44" });
  }

  private buildArch(at: Vector3) {
    const s = this.scene;
    const parts: Mesh[] = [];
    for (const sx of [-1, 1]) {
      const pillar = MeshBuilder.CreateBox("ap", { width: 0.5, height: 2.0, depth: 0.6 }, s);
      pillar.position.set(sx * 1.25, 1.0, 0);
      paintFacets(pillar, hex("#7d7468"), 0.1, 20 + sx);
      parts.push(pillar);
    }
    const lintel = MeshBuilder.CreateBox("al", { width: 3.1, height: 0.45, depth: 0.7 }, s);
    lintel.position.y = 2.2;
    paintFacets(lintel, hex("#8b8275"), 0.1, 23);
    parts.push(lintel);
    const keystone = MeshBuilder.CreateCylinder("ak", { height: 0.5, diameterTop: 0.5, diameterBottom: 0.25, tessellation: 4 }, s);
    keystone.position.set(0, 2.25, -0.3);
    keystone.rotation.x = Math.PI / 2;
    paintFacets(keystone, hex("#5aa58f"), 0.1, 24);
    parts.push(keystone);
    const m = merge(parts, "arch");
    m.material = material(s, "arch-mat", "#ffffff");
    m.position = at.add(new Vector3(0, 0, -0.2));
    m.receiveShadows = true;
    this.shadows.addShadowCaster(m);
    const dark = MeshBuilder.CreateBox("archdark", { width: 2.0, height: 2.0, depth: 0.2 }, s);
    dark.position = at.add(new Vector3(0, 1.0, 0.15));
    dark.material = material(s, "archdark-mat", "#000000", { spec: 0 });
  }

  private buildSign(at: Vector3) {
    const s = this.scene;
    const post = MeshBuilder.CreateBox("sp", { width: 0.08, height: 0.6, depth: 0.08 }, s);
    post.position.y = 0.3;
    paintFacets(post, hex("#6b4226"), 0.05, 30);
    const board = MeshBuilder.CreateBox("sb", { width: 0.6, height: 0.35, depth: 0.06 }, s);
    board.position.y = 0.62;
    paintFacets(board, hex("#b07a48"), 0.06, 31);
    const m = merge([post, board], "sign");
    m.material = material(s, "sign-mat", "#ffffff");
    m.position = at;
    m.rotation.y = 0.2;
    this.shadows.addShadowCaster(m);
  }

  private buildDungeonProps() {
    const s = this.scene;
    // pedestal
    const ped = MeshBuilder.CreateCylinder("ped", { height: 0.7, diameterTop: 0.6, diameterBottom: 0.8, tessellation: 8 }, s);
    paintFacets(ped, hex("#8a8496"), 0.1, 40);
    ped.material = material(s, "ped-mat", "#ffffff");
    ped.position = toWorld("dungeon", PEDESTAL.x, PEDESTAL.y, 0.35);
    ped.receiveShadows = true;
    this.shadows.addShadowCaster(ped);
    // rune circle in the boss hall
    const rune = MeshBuilder.CreateTorus("rune", { diameter: 4.2, thickness: 0.08, tessellation: 24 }, s);
    rune.position = toWorld("dungeon", 8, 5.6, 0.02);
    rune.material = material(s, "rune-mat", "#3b2f55", { emissive: "#5a2a7a" });
    // torches
    const torchMat = material(s, "torch-mat", "#5b3a24");
    const flameMat = material(s, "flame-mat", "#ffb347", { emissive: "#ff8a1f" });
    flameMat.disableLighting = true;
    for (const d of DUNGEON.decor.filter((d) => d.kind === "torch")) {
      const at = toWorld("dungeon", d.x, d.y, 1.25);
      const stick = MeshBuilder.CreateCylinder("torch", { height: 0.45, diameterTop: 0.12, diameterBottom: 0.06, tessellation: 5 }, s);
      stick.position = at;
      const dir = d.dir ?? 0;
      // lean the torch out from its wall
      stick.rotation.z = -Math.cos(dir) * 0.35;
      stick.rotation.x = -Math.sin(dir) * 0.35;
      stick.material = torchMat;
      const flame = MeshBuilder.CreateCylinder("flame", { height: 0.32, diameterTop: 0, diameterBottom: 0.2, tessellation: 5 }, s);
      flame.position = at.add(new Vector3(Math.cos(dir) * 0.09, 0.36, Math.sin(dir) * 0.09));
      flame.material = flameMat;
      this.flames.push(flame);
    }
    for (const [x, y] of [
      [8, 17],
      [8, 5.5],
    ]) {
      const l = new PointLight("roomLight", toWorld("dungeon", x, y, 3.2), s);
      l.diffuse = hex("#ffb066");
      l.specular = hex("#ffb066").scale(0.3);
      l.intensity = 0;
      l.range = 14;
      this.roomLights.push(l);
    }
  }

  private buildGate(): TransformNode {
    const s = this.scene;
    const node = new TransformNode("gate", s);
    const parts: Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const bar = MeshBuilder.CreateCylinder("bar", { height: 1.6, diameter: 0.09, tessellation: 6 }, s);
      bar.position.set(-0.85 + i * 0.34, 0.8, 0);
      parts.push(bar);
    }
    for (const y of [0.35, 1.25]) {
      const cross = MeshBuilder.CreateBox("cross", { width: 2.0, height: 0.1, depth: 0.12 }, s);
      cross.position.y = y;
      parts.push(cross);
    }
    for (const p of parts) paintFacets(p, hex("#3b3542"), 0.1, 70);
    const lock = MeshBuilder.CreateBox("lock", { width: 0.28, height: 0.3, depth: 0.16 }, s);
    lock.position.set(0, 0.8, -0.05);
    paintFacets(lock, hex("#d9a83a"), 0.1, 71);
    const m = merge([...parts, lock], "gateMesh");
    m.material = material(s, "gate-mat", "#ffffff", { spec: 0.4 });
    m.parent = node;
    node.position = toWorld("dungeon", 8, GATE_ROW + 0.5, 0);
    this.shadows.addShadowCaster(m);
    return node;
  }

  private buildChest() {
    const s = this.scene;
    const node = new TransformNode("chest", s);
    const base = MeshBuilder.CreateBox("cb", { width: 0.95, height: 0.5, depth: 0.62 }, s);
    base.position.y = 0.25;
    paintFacets(base, hex("#8a5530"), 0.08, 80);
    const band = MeshBuilder.CreateBox("cband", { width: 0.99, height: 0.08, depth: 0.66 }, s);
    band.position.y = 0.42;
    paintFacets(band, hex("#e3b341"), 0.08, 81);
    const bm = merge([base, band], "chestBase");
    bm.material = material(s, "chest-mat", "#ffffff", { spec: 0.3 });
    bm.parent = node;
    const lid = new TransformNode("lidPivot", s);
    lid.parent = node;
    lid.position.set(0, 0.5, 0.31);
    const lidMesh = MeshBuilder.CreateCylinder("lid", { height: 0.95, diameter: 0.62, tessellation: 8, arc: 0.5 }, s);
    lidMesh.rotation.z = Math.PI / 2;
    lidMesh.position.set(0, 0, -0.31);
    paintFacets(lidMesh, hex("#9a6238"), 0.08, 82);
    const lock = MeshBuilder.CreateBox("clock", { width: 0.14, height: 0.16, depth: 0.06 }, s);
    lock.position.set(0, -0.02, -0.63);
    paintFacets(lock, hex("#f2c14b"), 0.05, 83);
    const lm = merge([lidMesh, lock], "chestLid");
    lm.material = bm.material;
    lm.parent = lid;
    node.position = toWorld("dungeon", CHEST.x, CHEST.y, 0);
    node.scaling.setAll(0);
    this.shadows.addShadowCaster(bm);
    this.shadows.addShadowCaster(lm);
    return { node, lid };
  }

  private buildBreakables() {
    const s = this.scene;
    const tuft = makeTuft(s, "tuft", "#3f7f35", "#b5e06a", 9, 4);
    const pot = makePot(s);
    const tM: number[] = [];
    const pM: number[] = [];
    const rnd = makeRng(4242);
    // we need ids, but ids are assigned deterministically in createInitialState: keep order.
    this.pendingBreakables = { tuft, pot, rnd, tM, pM };
    return { tuft, pot };
  }
  private pendingBreakables: { tuft: Mesh; pot: Mesh; rnd: () => number; tM: number[]; pM: number[] } | null = null;

  private initBreakables(state: GameState) {
    if (!this.pendingBreakables) return;
    const { tuft, pot, rnd } = this.pendingBreakables;
    const tMats: Matrix[] = [], tIds: number[] = [];
    const pMats: Matrix[] = [], pIds: number[] = [];
    bakeHeightAO(pot, 0.3, 0.5);
    this.sway(tuft, 0.8);
    for (const b of state.breakables) {
      const p = toWorld(b.map, b.x, b.y);
      if (b.kind === "tuft") {
        tMats.push(compose(p.x, 0, p.z, 0.9 + rnd() * 0.5, rnd() * 6.28).clone());
        tIds.push(b.id);
      } else {
        const sc = 0.9 + rnd() * 0.25;
        pMats.push(compose(p.x, 0, p.z, new Vector3(sc, sc * (0.9 + rnd() * 0.25), sc), rnd() * 6.28, (rnd() - 0.5) * 0.08).clone());
        pIds.push(b.id);
      }
    }
    const ts = this.thin(tuft, tMats, false, true);
    const ps = this.thin(pot, pMats, true, true);
    ts.forEach((sl, i) => this.breakIndex.set(tIds[i], { mesh: sl.mesh, idx: sl.idx, matrix: tMats[i], shown: true }));
    ps.forEach((sl, i) => this.breakIndex.set(pIds[i], { mesh: sl.mesh, idx: sl.idx, matrix: pMats[i], shown: true }));
    for (const sc of this.staticCasters) sc.on = false;
    this.shadowKey = -1; // re-evaluate with the pots included
    this.pendingBreakables = null;
  }

  private buildArc() {
    const N = 18;
    const positions = new Float32Array((N + 1) * 2 * 3);
    const colors = new Float32Array((N + 1) * 2 * 4);
    const indices: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const mesh = new Mesh("swordArc", this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.colors = colors;
    vd.indices = indices;
    vd.applyToMesh(mesh, true);
    mesh.hasVertexAlpha = true;
    const m = material(this.scene, "arc-mat", "#ffffff", { emissive: "#ffffff", backFace: false });
    m.disableLighting = true;
    m.alpha = 0.999;
    mesh.material = m;
    mesh.parent = this.heroRoot;
    mesh.position.y = 0.45;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.setEnabled(false);
    return { mesh, positions, colors };
  }

  // ───────────── per-frame sync ─────────────
  sync(state: GameState, dt: number) {
    this.time += dt;
    if (state !== this.lastState) {
      // new game (retry): everything comes back, old events are history
      this.lastState = state;
      this.lastSeq = state.eventSeq;
      this.initBreakables(state);
    }
    const p = state.player;
    if (p.map !== this.currentMap) this.setMapLighting(p.map, state);

    this.syncHero(state, dt);
    this.syncEnemies(state, dt);
    this.syncPickups(state);
    this.syncBreakables(state);
    this.syncDungeon(state, dt);
    this.syncHazards(state);
    this.updateParticles(dt);
    this.water.position.y = -0.14 + Math.sin(this.time * 1.3) * 0.015;
    this.shimmer.uOffset = this.time * 0.035;
    this.shimmer.vOffset = Math.sin(this.time * 0.4) * 0.05;
    swayClock.t = this.time;
    this.syncCamera(state, dt);
    this.adaptResolution(dt);
  }

  /** Adaptive resolution: drop render scale when we can't hold ~45 fps, restore when there's headroom. */
  private adaptResolution(dt: number) {
    if (!this.adaptive || dt <= 0) return;
    this.fpsAcc += dt;
    this.fpsN++;
    this.adaptT += dt;
    if (this.adaptT < 2) return;
    const fps = this.fpsN / this.fpsAcc;
    this.adaptT = this.fpsAcc = 0;
    this.fpsN = 0;
    let next = this.hwScale;
    if (fps < 45) next = Math.min(this.baseScale * 2, this.hwScale * 1.2);
    else if (fps > 57) next = Math.max(this.baseScale, this.hwScale / 1.1);
    if (Math.abs(next - this.hwScale) > 1e-3) {
      this.hwScale = next;
      this.engine.setHardwareScalingLevel(next);
    }
  }

  newEvents(state: GameState): GameEvent[] {
    const out = this.evOut;
    out.length = 0;
    for (const e of state.events) if (e.seq > this.lastSeq) out.push(e);
    if (out.length) this.lastSeq = out[out.length - 1].seq;
    return out;
  }

  private setMapLighting(map: MapId, state: GameState) {
    this.currentMap = map;
    const p = state.player;
    this.camTarget.copyFrom(toWorld(map, p.x, p.y));
    if (map === "over") {
      this.scene.clearColor = Color4.FromHexString("#f4c79aff");
      this.scene.fogColor = hex("#f2c9a0");
      this.scene.fogDensity = 0.011;
      this.hemi.intensity = 0.72;
      this.hemi.diffuse = hex("#fff1dc");
      this.hemi.groundColor = hex("#5a6b4a");
      this.sun.intensity = 1.55;
      this.sun.diffuse = hex("#ffe2b8");
      this.roomLights.forEach((l) => (l.intensity = 0));
    } else {
      this.scene.clearColor = Color4.FromHexString("#09070dff");
      this.scene.fogColor = hex("#0b0812");
      this.scene.fogDensity = 0.022;
      this.hemi.intensity = 0.32;
      this.hemi.diffuse = hex("#9c8cc8");
      this.hemi.groundColor = hex("#1a1426");
      this.sun.intensity = 0.45;
      this.sun.diffuse = hex("#c9a4ff");
      this.roomLights.forEach((l) => (l.intensity = 1.25));
    }
  }

  private syncHero(state: GameState, dt: number) {
    const p = state.player;
    const pos = toWorld(p.map, p.x, p.y, 0, this.tmpV);
    const speed = Math.hypot(p.vx, p.vy);
    this.walkPhase += speed * dt * 3.2;
    const bob = speed > 0.3 ? Math.abs(Math.sin(this.walkPhase)) * 0.07 : Math.sin(this.time * 2) * 0.01;
    this.heroRoot.position.set(pos.x, bob, pos.z);
    // Babylon forward is +z; our map facing (fx, fy) maps to (fx, -fy) in world xz.
    const target = Math.atan2(p.fx, -p.fy);
    let d = target - this.heroYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.heroYaw += p.swingT > 0 ? d : d * Math.min(1, dt * 20);
    this.heroRoot.rotation.y = this.heroYaw;
    this.heroBody.rotation.x = Math.min(0.25, speed * 0.04);
    // i-frame blink
    const blink = p.invuln > 0 && Math.floor(p.invuln * 18) % 2 === 0;
    this.heroBody.visibility = blink ? 0.25 : 1;

    // sword swing: blade sweeps from the hero's right to left across the facing direction
    if (p.swingT > 0 && state.phase === "playing") {
      const prog = 1 - p.swingT / SWING_TIME;
      const ease = 1 - Math.pow(1 - prog, 3);
      const start = SWING_HALF_ARC, end = -SWING_HALF_ARC;
      const cur = start + (end - start) * ease;
      this.swordPivot.setEnabled(true);
      this.swordPivot.rotation.y = cur;
      this.updateArc(start, cur, 1 - prog * 0.6);
      this.arc.setEnabled(true);
    } else {
      this.swordPivot.setEnabled(false);
      this.arc.setEnabled(false);
    }
    this.heroRoot.setEnabled(true);
  }

  private updateArc(a0: number, a1: number, alpha: number) {
    const N = 18;
    const ri = 0.35, ro = 1.3;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const a = a0 + (a1 - a0) * t;
      const sx = Math.sin(a), cz = Math.cos(a);
      const o = i * 6;
      this.arcPositions[o] = sx * ri;
      this.arcPositions[o + 1] = 0;
      this.arcPositions[o + 2] = cz * ri;
      this.arcPositions[o + 3] = sx * ro;
      this.arcPositions[o + 4] = 0.05;
      this.arcPositions[o + 5] = cz * ro;
      const c = i * 8;
      const fade = alpha * (0.15 + 0.85 * t);
      const ac = this.arcColors;
      ac[c] = 0.85; ac[c + 1] = 0.95; ac[c + 2] = 1; ac[c + 3] = fade * 0.25;
      ac[c + 4] = 1; ac[c + 5] = 1; ac[c + 6] = 1; ac[c + 7] = fade * 0.85;
    }
    this.arc.updateVerticesData(VertexBuffer.PositionKind, this.arcPositions);
    this.arc.updateVerticesData(VertexBuffer.ColorKind, this.arcColors);
  }

  private syncEnemies(state: GameState, dt: number) {
    for (const e of state.enemies) {
      let v = this.enemyViews.get(e.id);
      if (!v) {
        const tpl = e.kind === "boss" ? this.bossTemplate : this.blobTemplate;
        const root = new TransformNode("enemy" + e.id, this.scene);
        const mesh = tpl.clone("enemyMesh" + e.id, root)!;
        mesh.setEnabled(true);
        const mat = material(this.scene, "enemyMat" + e.id, "#ffffff", { spec: 0.25 });
        mesh.material = mat;
        mesh.receiveShadows = true;
        this.shadows.addShadowCaster(mesh);
        this.glow.addIncludedOnlyMesh(mesh);
        const s = e.kind === "boss" ? 1.95 : 0.95;
        root.scaling.setAll(s);
        v = { root, mesh, mat, wasAlive: e.alive, spawnT: 1, yaw: 0 };
        this.enemyViews.set(e.id, v);
      }
      if (e.alive && !v.wasAlive) v.spawnT = 0;
      v.wasAlive = e.alive;
      v.root.setEnabled(e.alive);
      if (!e.alive) {
        if (e.kind === "boss") this.stars.forEach((st) => st.setEnabled(false));
        continue;
      }
      v.spawnT = Math.min(1, v.spawnT + dt * 3);
      const pos = toWorld(e.map, e.x, e.y, 0, this.tmpV);
      v.root.position.copyFrom(pos);
      // facing comes from the sim (velocity, or the hero only while attacking); just smooth frames
      let d = e.face - v.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      v.yaw += d * Math.min(1, dt * 20);
      v.mesh.rotation.y = v.yaw;
      // squash & stretch
      const rate = e.state === "chase" || e.state === "lunge" ? 11 : 5;
      let sq = Math.sin(this.time * rate + e.id) * (e.state === "chase" ? 0.12 : 0.07);
      const wind = e.state === "windup" ? Math.min(1, Math.max(0, 1 - e.stateT / (e.stateDur || 0.8))) : 0;
      if (e.state === "windup") sq = -0.08 - 0.27 * wind * (2 - wind) + Math.sin(this.time * (24 + 36 * wind)) * 0.035 * wind;
      if (e.stun > 0) sq = 0.18;
      const sp = v.spawnT * (2 - v.spawnT);
      v.mesh.scaling.set((1 - sq * 0.6) * sp, (1 + sq) * sp, (1 - sq * 0.6) * sp);
      // hit flash (white) / windup glow (amber)
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 14);
      if (e.hitFlash > 0) v.mat.emissiveColor.set(1, 1, 1);
      else if (e.state === "windup") {
        // glow ramps with the charge and pulses faster; a hot flash once the aim locks
        const fast = 0.5 + 0.5 * Math.sin(this.time * (10 + 40 * wind));
        const locked = e.stateT <= BOSS_AIM_LOCK;
        const k = 0.25 + 0.75 * wind;
        v.mat.emissiveColor.set((0.6 + fast * 0.4) * k, (0.25 + fast * 0.2 + (locked ? 0.25 : 0)) * k, locked ? 0.12 * k : 0.02);
      }
      else if (e.state === "lunge") v.mat.emissiveColor.set(0.7, 0.35, 0.05);
      else if (e.state === "spitWindup") v.mat.emissiveColor.set(0.15, 0.35 + pulse * 0.3, 0.05);
      else if (e.state === "stunned") v.mat.emissiveColor.set(0.12, 0.2, 0.45 + pulse * 0.15);
      else if (e.kind === "boss" && e.guardCd > 0) v.mat.emissiveColor.set(0.22, 0.22, 0.28);
      else if (e.kind === "boss" && !state.flags.bossAwake) v.mat.emissiveColor.set(0, 0, 0.02);
      else v.mat.emissiveColor.set(0, 0, 0);
      v.mesh.position.x = e.state === "windup" ? Math.sin(this.time * 60) * 0.035 * (0.3 + wind) : 0;
      v.mesh.rotation.z = e.state === "stunned" ? Math.sin(this.time * 7) * 0.2 : 0;
      v.mesh.rotation.x = e.state === "stunned" ? Math.cos(this.time * 7) * 0.12 : e.state === "lunge" ? 0.25 : 0;
      if (e.state === "stunned") v.mesh.rotation.y = v.yaw + Math.sin(this.time * 3.5) * 0.6;
      if (e.state === "spitWindup") v.mesh.scaling.set(1.15 + pulse * 0.08, 0.9, 1.15 + pulse * 0.08);
      if (e.kind === "boss" && !state.flags.bossAwake) v.mesh.scaling.y *= 0.92;
      if (e.kind === "boss") {
        this.syncLane(e, dt);
        const dizzy = e.state === "stunned";
        this.stars.forEach((st, i) => {
          st.setEnabled(dizzy);
          if (!dizzy) return;
          const a = this.time * 4 + (i / this.stars.length) * Math.PI * 2;
          st.position.set(pos.x + Math.cos(a) * 0.75, 2.05 + Math.sin(a * 2) * 0.08, pos.z + Math.sin(a) * 0.75);
          st.rotation.y = this.time * 6;
        });
      }
    }
  }

  /** Lunge lane decal: fills during the windup, turns red and locks once the aim is locked. */
  private syncLane(e: GameState["enemies"][number], dt: number) {
    const active = e.alive && (e.state === "windup" || e.state === "lunge");
    this.laneAlpha = active ? 1 : Math.max(0, this.laneAlpha - dt * 5);
    this.laneRoot.setEnabled(this.laneAlpha > 0.01);
    if (this.laneAlpha <= 0.01) return;
    if (active) {
      this.laneYaw = Math.atan2(e.wx, -e.wy);
      if (e.state === "windup") toWorld(e.map, e.x, e.y, 0, this.laneRoot.position);
    }
    this.laneRoot.rotation.y = this.laneYaw;
    const wind = e.state === "windup" ? Math.min(1, Math.max(0, 1 - e.stateT / (e.stateDur || 0.8))) : 1;
    const locked = e.state !== "windup" || e.stateT <= BOSS_AIM_LOCK;
    this.laneBg.scaling.set(LANE_W, 1, LANE_LEN);
    this.laneFill.scaling.set(LANE_W * (locked ? 1 : 0.8), 1, Math.max(0.01, LANE_LEN * wind));
    this.laneHead.position.z = LANE_LEN + 0.02;
    this.laneHead.scaling.setAll(LANE_W * 1.2);
    const fl = locked ? 0.75 + 0.25 * Math.sin(this.time * 40) : 1;
    if (locked) {
      this.laneFillMat.emissiveColor.set(1 * fl, 0.12, 0.08);
      this.laneFillMat.diffuseColor.set(1, 0.2, 0.15);
    } else {
      this.laneFillMat.emissiveColor.set(1, 0.55, 0.1);
      this.laneFillMat.diffuseColor.set(1, 0.69, 0.23);
    }
    this.laneFillMat.alpha = (locked ? 0.55 : 0.38) * this.laneAlpha;
    this.laneBgMat.alpha = 0.2 * this.laneAlpha;
  }

  private syncPickups(state: GameState) {
    const seen = this.seenA;
    seen.clear();
    for (const k of state.pickups) {
      seen.add(k.id);
      let m = this.pickupMeshes.get(k.id);
      if (!m) {
        const base = k.kind === "heart" ? this.heartMesh : k.value > 1 ? this.rupeeB : this.rupeeG;
        m = base.createInstance("pk" + k.id);
        this.shadows.addShadowCaster(m);
        this.glow.addIncludedOnlyMesh(m as Mesh);
        this.pickupMeshes.set(k.id, m);
      }
      toWorld(k.map, k.x, k.y, 0.32 + k.z + Math.sin(this.time * 4 + k.id) * 0.05, m.position);
      m.rotation.y = this.time * 3 + k.id;
      m.isVisible = k.life > 3 || Math.floor(k.life * 10) % 2 === 0;
    }
    for (const [id, m] of this.pickupMeshes)
      if (!seen.has(id)) {
        this.shadows.removeShadowCaster(m);
        m.dispose();
        this.pickupMeshes.delete(id);
      }
  }

  private syncBreakables(state: GameState) {
    const dirty = this.dirty;
    dirty.clear();
    for (const b of state.breakables) {
      const e = this.breakIndex.get(b.id);
      if (!e || e.shown === b.alive) continue;
      e.shown = b.alive;
      e.mesh.thinInstanceSetMatrixAt(e.idx, b.alive ? e.matrix : ZERO, false);
      dirty.add(e.mesh);
    }
    for (const m of dirty) m.thinInstanceBufferUpdated("matrix");
  }

  private syncDungeon(state: GameState, dt: number) {
    const f = state.flags;
    this.keyMesh.setEnabled(!f.hasKey);
    this.keyMesh.rotation.y = this.time * 2;
    this.keyMesh.position.y = 1.15 + Math.sin(this.time * 2.5) * 0.08;
    const target = gateClosed(state) ? 0 : -1.75;
    const sp = target < this.gateY ? 1.6 : 9; // rises slowly, slams fast
    this.gateY += Math.sign(target - this.gateY) * Math.min(Math.abs(target - this.gateY), sp * dt);
    this.gateNode.position.y = this.gateY;
    const cs = chestVisible(state) ? 1 : 0;
    this.chestScale += (cs - this.chestScale) * Math.min(1, dt * 5);
    this.chestNode.scaling.setAll(this.chestScale < 0.01 ? 0 : this.chestScale);
    this.chestNode.setEnabled(this.chestScale > 0.01);
    const lidTarget = f.chestOpened ? -1.9 : 0;
    this.chestLid.rotation.x += (lidTarget - this.chestLid.rotation.x) * Math.min(1, dt * 6);
    // torch flicker
    this.flames.forEach((fl, i) => {
      const k = 1 + Math.sin(this.time * 17 + i * 1.7) * 0.12 + Math.sin(this.time * 31 + i) * 0.07;
      fl.scaling.set(1, k, 1);
    });
    if (this.currentMap === "dungeon")
      this.roomLights.forEach((l, i) => (l.intensity = 1.2 + Math.sin(this.time * 9 + i) * 0.08 + Math.sin(this.time * 23 + i * 3) * 0.05));
    if (f.chestOpened && Math.random() < 0.4) this.emit(CHEST.x, CHEST.y, "dungeon", 1, { c: hex("#ffe27a"), speed: 1, up: 3, g: -1, life: 1.2, size: 0.07 });
  }

  private syncHazards(state: GameState) {
    const seen = this.seenA;
    seen.clear();
    for (const g of state.globs) {
      seen.add(g.id);
      let m = this.globMeshes.get(g.id);
      if (!m) {
        m = { ball: this.globBase.createInstance("gb" + g.id), ring: this.ringBase.createInstance("gr" + g.id), disc: this.discBase.createInstance("gd" + g.id), landed: false };
        m.ball.instancedBuffers.color = new Color4(1, 1, 1, 1);
        m.ring.instancedBuffers.color = new Color4(1, 1, 1, 1);
        m.disc.instancedBuffers.color = new Color4(1, 1, 1, 1);
        this.glow.addIncludedOnlyMesh(m.ball as Mesh);
        this.glow.addIncludedOnlyMesh(m.ring as Mesh);
        this.shadows.addShadowCaster(m.ball);
        this.globMeshes.set(g.id, m);
      }
      const t = Math.min(1, g.t / g.dur);
      const fuse = g.t > g.dur ? Math.min(1, (g.t - g.dur) / GLOB_FUSE) : -1;
      const x = g.x0 + (g.tx - g.x0) * t, y = g.y0 + (g.ty - g.y0) * t;
      const ballC = (m.ball as Mesh).instancedBuffers.color as Color4;
      const ringC = m.ring.instancedBuffers.color as Color4;
      const discC = m.disc.instancedBuffers.color as Color4;
      if (fuse < 0) {
        // in flight: arc + the exact landing zone fading in
        toWorld("dungeon", x, y, 1.0 + 4 * 3.2 * t * (1 - t), m.ball.position);
        m.ball.rotation.set(this.time * 5, this.time * 3, 0);
        m.ball.scaling.setAll(1);
        ballC.set(1, 1, 1, 1);
        const rs = GLOB_HIT_R * (1 + Math.sin(this.time * 12) * 0.015);
        m.ring.scaling.set(rs, 1, rs);
        ringC.set(0.55 + 0.45 * t, 0.55 + 0.45 * t, 0.55 + 0.45 * t, 1);
        const ds = GLOB_HIT_R * 0.25 * t;
        m.disc.scaling.set(ds, 1, ds);
        discC.set(0.6, 0.6, 0.6, 1);
      } else {
        // landed: the fuse. Swells, pulses faster and faster, shifts green → white-hot magenta;
        // the disc fills out to the ring (exact blast radius) as the timer runs down.
        const freq = 8 + 34 * fuse;
        const beat = 0.5 + 0.5 * Math.sin(this.time * freq);
        const swell = 1 + 0.75 * fuse + beat * (0.08 + 0.18 * fuse);
        toWorld("dungeon", g.tx, g.ty, 0.2 + 0.12 * swell, m.ball.position);
        m.ball.rotation.set(0, this.time * (2 + 6 * fuse), 0);
        m.ball.scaling.set(swell * 1.1, swell * (0.85 + 0.1 * beat), swell * 1.1);
        ballC.set(1 + 1.6 * fuse + beat * fuse, 1 - 0.35 * fuse + 0.8 * fuse * beat, 1 + 1.2 * fuse, 1);
        if (!m.landed) {
          m.landed = true;
          this.emit(g.tx, g.ty, "dungeon", 8, { c: [hex("#7ad04a"), hex("#5b2a7a")], speed: 1.6, up: 2, g: 10, life: 0.35, size: 0.07, h: 0.15 });
        }
        const rs = GLOB_HIT_R * (1 + beat * 0.03 * (1 + fuse));
        m.ring.scaling.set(rs, 1, rs);
        const rb = 1.1 + 0.9 * beat * (0.4 + fuse);
        ringC.set(rb, rb, rb, 1);
        const ds = Math.max(0.01, GLOB_HIT_R * fuse);
        m.disc.scaling.set(ds, 1, ds);
        const db = 1 + fuse * 1.2 + beat * 0.3;
        discC.set(db, db, db, 1);
      }
      toWorld("dungeon", g.tx, g.ty, 0.045, m.ring.position);
      toWorld("dungeon", g.tx, g.ty, 0.03, m.disc.position);
    }
    for (const [id, m] of this.globMeshes)
      if (!seen.has(id)) {
        this.shadows.removeShadowCaster(m.ball);
        m.ball.dispose();
        m.ring.dispose();
        m.disc.dispose();
        this.globMeshes.delete(id);
      }
    const seenP = this.seenB;
    seenP.clear();
    for (const q of state.puddles) {
      seenP.add(q.id);
      let m = this.puddleMeshes.get(q.id);
      if (!m) {
        m = this.puddleBase.createInstance("pd" + q.id);
        this.puddleMeshes.set(q.id, m);
      }
      toWorld("dungeon", q.x, q.y, 0.03, m.position);
      const k = q.r * Math.min(1, (q.max - q.life) * 8) * Math.min(1, q.life * 2.5);
      m.scaling.set(k * (1 + Math.sin(this.time * 9 + q.id) * 0.05), 1, k);
      if (Math.random() < 0.15) this.emit(q.x, q.y, "dungeon", 1, { c: hex("#7ad04a"), speed: 0.3, up: 1.2, g: 0.5, life: 0.5, size: 0.06, h: 0.05 });
    }
    for (const [id, m] of this.puddleMeshes)
      if (!seenP.has(id)) {
        m.dispose();
        this.puddleMeshes.delete(id);
      }
  }

  private syncCamera(state: GameState, dt: number) {
    const p = state.player;
    const map = MAPS[p.map];
    let tx = p.x, ty = p.y;
    // keep the camera inside the map so the void never shows
    if (p.map === "over") {
      tx = Math.min(map.w - 7.5, Math.max(7.5, tx));
      ty = Math.min(map.h - 3.5, Math.max(4.5, ty));
    } else {
      tx = Math.min(10, Math.max(6, tx));
      ty = Math.min(map.h - 3.2, Math.max(4.5, ty));
    }
    const want = toWorld(p.map, tx, ty, 0, this.tmpV);
    const k = 1 - Math.exp(-dt * 6);
    this.camTarget.x += (want.x - this.camTarget.x) * k;
    this.camTarget.z += (want.z - this.camTarget.z) * k;
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const sh = this.shake * this.shake;
    const ox = (Math.random() - 0.5) * sh * 1.2, oy = (Math.random() - 0.5) * sh * 1.2;
    // classic Zelda tilt: high and behind, looking down at ~55°
    this.camera.position.set(this.camTarget.x + ox, 11.2 + oy, this.camTarget.z - 7.7);
    this.camera.setTarget(this.tmpV2.set(this.camTarget.x + ox, 0, this.camTarget.z + 0.2));
    // sun + shadow frustum follow the action
    this.sun.direction.scaleToRef(-30, this.tmpV);
    this.sun.position.set(this.camTarget.x + this.tmpV.x, this.tmpV.y, this.camTarget.z + 2 + this.tmpV.z);
    const mx = this.camTarget.x - MAP_OFFSET[p.map];
    this.updateShadowCasters(p.map, mx, -this.camTarget.z);
  }

  // ───────────── effects ─────────────
  private emit(
    x: number,
    y: number,
    map: MapId,
    n: number,
    o: { c: Color3 | Color3[]; speed: number; up: number; g?: number; life: number; size: number; grow?: number; h?: number; dx?: number; dy?: number },
  ) {
    const base = toWorld(map, x, y, o.h ?? 0.4);
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= this.MAX_P) this.particles.shift();
      const a = Math.random() * Math.PI * 2;
      const sp = o.speed * (0.4 + Math.random() * 0.8);
      let vx = Math.cos(a) * sp, vz = Math.sin(a) * sp;
      if (o.dx !== undefined && o.dy !== undefined) {
        vx += o.dx * o.speed * 0.8;
        vz += -o.dy * o.speed * 0.8;
      }
      const cols = Array.isArray(o.c) ? o.c : [o.c];
      this.particles.push({
        x: base.x + (Math.random() - 0.5) * 0.2,
        y: base.y,
        z: base.z + (Math.random() - 0.5) * 0.2,
        vx,
        vy: o.up * (0.5 + Math.random() * 0.8),
        vz,
        life: o.life * (0.6 + Math.random() * 0.6),
        max: o.life,
        size: o.size * (0.7 + Math.random() * 0.6),
        grow: o.grow ?? 0,
        g: o.g ?? 12,
        c: cols[Math.floor(Math.random() * cols.length)],
        spin: Math.random() * 6,
      });
    }
  }

  private updateParticles(dt: number) {
    const ps = this.particles;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.03 && p.g > 0) {
        p.y = 0.03;
        p.vy *= -0.3;
        p.vx *= 0.6;
        p.vz *= 0.6;
      }
      p.spin += dt * 8;
      ps[w++] = p;
    }
    ps.length = w;
    for (let i = 0; i < this.MAX_P; i++) {
      if (i < ps.length) {
        const p = ps[i];
        const t = p.life / p.max;
        const s = Math.max(0.001, p.size * (p.grow ? 1 + (1 - t) * p.grow : Math.min(1, t * 2)));
        compose(p.x, p.y, p.z, s, p.spin, p.spin * 0.7).copyToArray(this.particleMatrices, i * 16);
        const pc = this.particleColors, o = i * 4;
        pc[o] = p.c.r; pc[o + 1] = p.c.g; pc[o + 2] = p.c.b; pc[o + 3] = 1;
      } else ZERO.copyToArray(this.particleMatrices, i * 16);
    }
    this.particleMesh.thinInstanceBufferUpdated("matrix");
    this.particleMesh.thinInstanceBufferUpdated("color");
  }

  handleEvent(e: GameEvent) {
    const W = hex("#ffffff");
    switch (e.type) {
      case "hit":
        this.emit(e.x, e.y, e.map, 14, { c: [hex("#fff6c2"), hex("#ffd34d"), W], speed: 5, up: 3, g: 10, life: 0.3, size: 0.07, dx: e.dx, dy: e.dy });
        this.shake = Math.max(this.shake, 0.3);
        break;
      case "enemyDie":
        this.emit(e.x, e.y, e.map, 18, { c: [W, hex("#e3cff2"), hex("#c58be0")], speed: 2.2, up: 1.6, g: -0.5, life: 0.6, size: 0.2, grow: 1.5 });
        this.emit(e.x, e.y, e.map, 8, { c: hex("#8e4fb8"), speed: 3, up: 4, g: 12, life: 0.6, size: 0.08 });
        break;
      case "bossDie":
        this.emit(e.x, e.y, e.map, 60, { c: [W, hex("#ffd0c2"), hex("#b8323f"), hex("#f2c14b")], speed: 4, up: 3, g: -0.4, life: 1.2, size: 0.3, grow: 2 });
        this.shake = 0.9;
        break;
      case "chestAppear":
        this.emit(e.x, e.y, e.map, 30, { c: [W, hex("#ffe27a")], speed: 2, up: 3, g: 1, life: 1, size: 0.12, grow: 1 });
        break;
      case "tuft":
        this.emit(e.x, e.y, e.map, 14, { c: [hex("#5aa33f"), hex("#8fd05a"), hex("#b5e06a")], speed: 2.4, up: 4, g: 11, life: 0.7, size: 0.07, h: 0.2 });
        break;
      case "pot":
        this.emit(e.x, e.y, e.map, 12, { c: [hex("#c4693a"), hex("#8f4a2a"), hex("#e8b27a")], speed: 3, up: 4.5, g: 14, life: 0.9, size: 0.1, h: 0.3 });
        this.emit(e.x, e.y, e.map, 6, { c: hex("#e8d6bd"), speed: 1, up: 0.6, g: -0.3, life: 0.5, size: 0.15, grow: 1.5, h: 0.2 });
        break;
      case "rupee":
        this.emit(e.x, e.y, e.map, 6, { c: [hex("#2ee88a"), W], speed: 1.2, up: 2, g: 2, life: 0.4, size: 0.05 });
        break;
      case "heart":
        this.emit(e.x, e.y, e.map, 8, { c: [hex("#ff6b7a"), W], speed: 1.2, up: 2.5, g: 2, life: 0.5, size: 0.06 });
        break;
      case "key":
        this.emit(e.x, e.y, e.map, 26, { c: [hex("#ffe27a"), W], speed: 2, up: 3, g: 2, life: 0.9, size: 0.07, h: 1.1 });
        break;
      case "gate":
      case "gateSlam":
        this.emit(e.x, e.y, e.map, 20, { c: [hex("#8a8496"), hex("#b9b2c6")], speed: 2, up: 1, g: 0.5, life: 0.8, size: 0.14, grow: 1, h: 0.1 });
        this.shake = Math.max(this.shake, e.type === "gateSlam" ? 0.6 : 0.4);
        break;
      case "hurt":
        this.emit(e.x, e.y, e.map, 10, { c: [hex("#ff4d5e"), W], speed: 3, up: 3, g: 10, life: 0.4, size: 0.07 });
        this.shake = Math.max(this.shake, 0.6);
        break;
      case "spawn":
        this.emit(e.x, e.y, e.map, 10, { c: [hex("#c58be0"), W], speed: 1.2, up: 1, g: -0.3, life: 0.5, size: 0.15, grow: 1 });
        break;
      case "lunge":
        this.emit(e.x, e.y, e.map, 10, { c: hex("#b9b2c6"), speed: 1.5, up: 0.5, g: 0, life: 0.4, size: 0.18, grow: 1, h: 0.1 });
        this.shake = Math.max(this.shake, 0.25);
        break;
      case "clank":
        this.emit(e.x, e.y, e.map, 12, { c: [W, hex("#c9d4e8"), hex("#8a96b0")], speed: 5, up: 3, g: 12, life: 0.25, size: 0.05, h: 0.8, dx: e.dx === undefined ? undefined : -e.dx, dy: e.dy === undefined ? undefined : -e.dy });
        this.shake = Math.max(this.shake, 0.15);
        break;
      case "bossStun":
        this.emit(e.x, e.y, e.map, 14, { c: [hex("#ffe066"), W], speed: 2, up: 3, g: 4, life: 0.7, size: 0.08, h: 1.6 });
        this.shake = Math.max(this.shake, e.dx !== undefined ? 0.7 : 0.3);
        break;
      case "spit":
        this.emit(e.x, e.y, e.map, e.dx ? 16 : 6, { c: [hex("#7ad04a"), hex("#5b2a7a")], speed: 2, up: 4, g: 8, life: 0.5, size: 0.1, h: 1.4 });
        break;
      case "splash":
        this.emit(e.x, e.y, e.map, 22, { c: [hex("#7ad04a"), hex("#5b2a7a"), hex("#b06ad0")], speed: 3.5, up: 4, g: 12, life: 0.6, size: 0.1, h: 0.2 });
        this.shake = Math.max(this.shake, 0.22);
        break;
      case "bossCharge":
        // feet dig in: a ring of dust kicked back from the lunge heading
        this.emit(e.x, e.y, e.map, 14, { c: [hex("#b9b2c6"), hex("#8a8496")], speed: 1.4, up: 0.8, g: 1, life: 0.6, size: 0.16, grow: 1.2, h: 0.1, dx: e.dx === undefined ? undefined : -e.dx, dy: e.dy === undefined ? undefined : -e.dy });
        break;
      case "bossRoar":
        this.shake = Math.max(this.shake, 0.5);
        break;
      case "chest":
        this.emit(e.x, e.y, e.map, 50, { c: [hex("#ffe27a"), W, hex("#ffb347")], speed: 2.5, up: 5, g: 3, life: 1.4, size: 0.08, h: 0.6 });
        break;
    }
  }

  /** Projected screen position of the hero (used by automated visual checks). */
  heroScreen(): { x: number; y: number } {
    const w = this.engine.getRenderWidth(), h = this.engine.getRenderHeight();
    const p = Vector3.Project(
      this.heroRoot.getAbsolutePosition(),
      Matrix.Identity(),
      this.scene.getTransformMatrix(),
      this.camera.viewport.toGlobal(w, h),
    );
    return { x: p.x / w, y: p.y / h };
  }

  render() {
    this.scene.render();
  }

  /** Resize + portrait handling: in portrait keep the horizontal field of view instead of the vertical. */
  resize() {
    this.engine.resize();
    const portrait = this.engine.getRenderHeight() > this.engine.getRenderWidth();
    this.camera.fovMode = portrait ? Camera.FOVMODE_HORIZONTAL_FIXED : Camera.FOVMODE_VERTICAL_FIXED;
    this.camera.fov = portrait ? 1.02 : 0.72;
  }

  /** Perf overlay: instrumentation is only attached while the overlay is on. */
  setInstrumentation(on: boolean) {
    if (on && !this.sceneInst) {
      this.sceneInst = new SceneInstrumentation(this.scene);
      this.sceneInst.captureFrameTime = true;
      this.engineInst = new EngineInstrumentation(this.engine);
      this.engineInst.captureGPUFrameTime = true;
    } else if (!on && this.sceneInst) {
      this.sceneInst.dispose();
      this.engineInst?.dispose();
      this.sceneInst = this.engineInst = null;
    }
  }

  perfStats() {
    const active = this.scene.getActiveMeshes();
    let verts = 0;
    for (let i = 0; i < active.length; i++) {
      const m = active.data[i] as Mesh;
      verts += m.getTotalVertices() * Math.max(1, m.thinInstanceCount || 0);
    }
    const gpu = this.engineInst?.gpuFrameTimeCounter.lastSecAverage ?? 0;
    return {
      fps: this.engine.getFps(),
      // counters need a couple of completed frames before their numbers mean anything
      frameMs: this.sceneInst && this.sceneInst.frameTimeCounter.count > 1 ? this.sceneInst.frameTimeCounter.lastSecAverage || this.sceneInst.frameTimeCounter.current : -1,
      gpuMs: gpu > 0 ? gpu * 1e-6 : null,
      drawCalls: this.sceneInst && this.sceneInst.drawCallsCounter.count > 1 ? this.sceneInst.drawCallsCounter.current : -1,
      activeMeshes: active.length,
      totalMeshes: this.scene.meshes.length,
      tris: Math.round(this.scene.getActiveIndices() / 3),
      verts,
      hwScale: this.engine.getHardwareScalingLevel(),
    };
  }

  dispose() {
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
