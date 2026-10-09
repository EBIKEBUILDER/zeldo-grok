/**
 * Babylon.js view layer. It owns meshes, lights, camera and particles, and only READS game state:
 * `sync(state, dt)` positions everything to match the store each frame; `handleEvent` spawns
 * cosmetic effects (sparks, debris, poofs, shake). No game rules live here.
 */
import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
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
  Vector3,
  VertexBuffer,
  VertexData,
  type AbstractMesh,
} from "@babylonjs/core";
import { GLOB_SPLASH_R, SWING_HALF_ARC, SWING_TIME } from "../constants";
import { hash2, makeRng } from "../rng";
import { chestVisible, gateClosed } from "../sim";
import type { GameEvent, GameState } from "../types";
import { CHEST, DUNGEON, GATE_ROW, MAPS, OVERWORLD, PEDESTAL, SPAWN, Tile, type MapData, type MapId } from "../world";
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
export function toWorld(map: MapId, x: number, y: number, h = 0): Vector3 {
  return new Vector3(x + MAP_OFFSET[map], h, -y);
}

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
  private globMeshes = new Map<number, { ball: AbstractMesh; ring: AbstractMesh; disc: AbstractMesh }>();
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
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));
    const scene = (this.scene = new Scene(this.engine));
    scene.clearColor = Color4.FromHexString("#f4c79aff");
    scene.ambientColor = new Color3(0.2, 0.2, 0.2);

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
    this.shadows = new ShadowGenerator(2048, this.sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.shadows.bias = 0.0015;
    this.shadows.normalBias = 0.01;
    this.shadows.darkness = 0.35;

    const glow = (this.glow = new GlowLayer("glow", scene, { blurKernelSize: 32 }));
    glow.intensity = 0.55;

    this.buildBackdrop();
    this.buildGround(OVERWORLD);
    this.buildGround(DUNGEON);
    this.water = this.buildWater();
    this.glow.addExcludedMesh(this.water);
    this.buildOverworldProps();
    this.buildDungeonProps();
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
    this.globBase.setEnabled(false);
    this.ringBase = MeshBuilder.CreateTorus("globRing", { diameter: 2, thickness: 0.07, tessellation: 28 }, scene);
    const rm = material(scene, "ring-mat", "#ff5a7a", { emissive: "#ff2a5a" });
    rm.disableLighting = true;
    this.ringBase.material = rm;
    this.ringBase.setEnabled(false);
    this.discBase = MeshBuilder.CreateDisc("globDisc", { radius: 1, tessellation: 28 }, scene);
    this.discBase.rotation.x = Math.PI / 2;
    this.discBase.bakeCurrentTransformIntoVertices();
    const dm = material(scene, "disc-mat", "#ff3a6a", { emissive: "#a0103a", alpha: 0.28 });
    dm.disableLighting = true;
    this.discBase.material = dm;
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
    this.particleMesh = pm;
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
    const v = 1 + (hash2(x, y, 9) - 0.5) * 0.09;
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
    const byKind: Record<string, { m: number[]; c: number[]; h: number; top: number }> = {};
    const push = (k: string, h: number, top: number, x: number, y: number, col: Color3) => {
      if (!byKind[k]) byKind[k] = { m: [], c: [], h, top };
      const p = toWorld(map.id, x + 0.5, y + 0.5, top - h / 2);
      const mat = compose(p.x, p.y, p.z, new Vector3(1, h, 1));
      byKind[k].m.push(...mat.asArray());
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
    for (const [k, d] of Object.entries(byKind)) {
      const box = MeshBuilder.CreateBox(`${map.id}-${k}`, { size: 1 }, s);
      const isWall = k.startsWith("wall") || k === "pillar";
      const mat = material(s, `${map.id}-${k}-mat`, "#ffffff", { spec: k === "plank" ? 0.1 : 0.02 });
      box.material = mat;
      box.thinInstanceSetBuffer("matrix", new Float32Array(d.m), 16, true);
      box.thinInstanceSetBuffer("color", new Float32Array(d.c), 4, true);
      box.receiveShadows = true;
      if (isWall || k === "plank") this.shadows.addShadowCaster(box);
      box.freezeWorldMatrix();
    }
    if (map.id === "dungeon") {
      // wall caps for a bit of definition
      const caps: number[] = [];
      for (let y = 0; y < map.h; y++)
        for (let x = 0; x < map.w; x++) {
          if (map.tiles[y * map.w + x] !== Tile.WALL) continue;
          const southWall = y === GATE_ROW || y === map.h - 1;
          const isPillar = x > 0 && x < map.w - 1 && y > 0 && y < map.h - 1 && y !== GATE_ROW;
          const h = southWall ? 0.6 : isPillar ? 1.5 : 2.2;
          const p = toWorld("dungeon", x + 0.5, y + 0.5, h + 0.04);
          caps.push(...compose(p.x, p.y, p.z, new Vector3(1.04, 0.08, 1.04)).asArray());
        }
      const cap = MeshBuilder.CreateBox("wallcap", { size: 1 }, s);
      cap.material = material(s, "wallcap-mat", "#7c768c");
      cap.thinInstanceSetBuffer("matrix", new Float32Array(caps), 16, true);
      cap.receiveShadows = true;
    }
  }

  private buildWater(): Mesh {
    const s = this.scene;
    const w = MeshBuilder.CreateGround("water", { width: 48, height: 24, subdivisions: 1 }, s);
    w.position.set(24, -0.14, -12);
    const m = material(s, "water-mat", "#0c3a48", { spec: 0.8, alpha: 0.88 });
    m.specularPower = 48;
    m.emissiveColor = hex("#06262c");
    w.material = m;
    w.receiveShadows = true;
    return w;
  }

  /** `dynamic` must be true for instances we later hide/move (static buffers are never re-uploaded). */
  private thin(mesh: Mesh, mats: Matrix[], cast = true, dynamic = false) {
    if (!mats.length) {
      mesh.setEnabled(false);
      return;
    }
    const buf = new Float32Array(mats.length * 16);
    mats.forEach((m, i) => m.copyToArray(buf, i * 16));
    mesh.thinInstanceSetBuffer("matrix", buf, 16, !dynamic);
    mesh.receiveShadows = true;
    if (cast) this.shadows.addShadowCaster(mesh);
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
    [...pines, ...autumn].forEach((mesh, i) => this.thin(mesh, treeM[i]));
    rocks.forEach((mesh, i) => this.thin(mesh, rockM[i]));
    this.thin(hedge, hedgeM);
    blooms.forEach((mesh, i) => this.thin(mesh, bloomM[i], false));
    this.thin(deco, decoM, false);

    this.buildCottage(toWorld("over", 18.5, 15));
    this.buildWell(toWorld("over", 27.5, 14.5));
    this.buildArch(toWorld("over", 24, 2.5));
    this.buildSign(toWorld("over", 21.4, 4.3));
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
    const tMats: Matrix[] = [];
    const pMats: Matrix[] = [];
    for (const b of state.breakables) {
      const p = toWorld(b.map, b.x, b.y);
      if (b.kind === "tuft") {
        const m = compose(p.x, 0, p.z, 0.9 + rnd() * 0.5, rnd() * 6.28);
        this.breakIndex.set(b.id, { mesh: tuft, idx: tMats.length, matrix: m, shown: true });
        tMats.push(m);
      } else {
        const sc = 0.9 + rnd() * 0.25;
        const m = compose(p.x, 0, p.z, new Vector3(sc, sc * (0.9 + rnd() * 0.25), sc), rnd() * 6.28, (rnd() - 0.5) * 0.08);
        this.breakIndex.set(b.id, { mesh: pot, idx: pMats.length, matrix: m, shown: true });
        pMats.push(m);
      }
    }
    this.thin(tuft, tMats, false, true);
    this.thin(pot, pMats, true, true);
    tuft.thinInstanceRefreshBoundingInfo();
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
    this.syncCamera(state, dt);
  }

  newEvents(state: GameState): GameEvent[] {
    const out = state.events.filter((e) => e.seq > this.lastSeq);
    if (out.length) this.lastSeq = out[out.length - 1].seq;
    return out;
  }

  private setMapLighting(map: MapId, state: GameState) {
    this.currentMap = map;
    const p = state.player;
    this.camTarget.copyFrom(toWorld(map, p.x, p.y));
    if (map === "over") {
      this.scene.clearColor = Color4.FromHexString("#f4c79aff");
      this.hemi.intensity = 0.72;
      this.hemi.diffuse = hex("#fff1dc");
      this.hemi.groundColor = hex("#5a6b4a");
      this.sun.intensity = 1.55;
      this.sun.diffuse = hex("#ffe2b8");
      this.roomLights.forEach((l) => (l.intensity = 0));
    } else {
      this.scene.clearColor = Color4.FromHexString("#09070dff");
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
    const pos = toWorld(p.map, p.x, p.y);
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
      this.arcColors.set([0.85, 0.95, 1, fade * 0.25, 1, 1, 1, fade * 0.85], c);
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
      const pos = toWorld(e.map, e.x, e.y);
      v.root.position.copyFrom(pos);
      const p = state.player;
      const look = Math.atan2(p.x - e.x, -(p.y - e.y));
      let d = look - v.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      v.yaw += d * Math.min(1, dt * (e.state === "chase" ? 8 : 2));
      v.mesh.rotation.y = v.yaw;
      // squash & stretch
      const rate = e.state === "chase" || e.state === "lunge" ? 11 : 5;
      let sq = Math.sin(this.time * rate + e.id) * (e.state === "chase" ? 0.12 : 0.07);
      if (e.state === "windup") sq = -0.25 + Math.sin(this.time * 40) * 0.04;
      if (e.stun > 0) sq = 0.18;
      const sp = v.spawnT * (2 - v.spawnT);
      v.mesh.scaling.set((1 - sq * 0.6) * sp, (1 + sq) * sp, (1 - sq * 0.6) * sp);
      // hit flash (white) / windup glow (amber)
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 14);
      if (e.hitFlash > 0) v.mat.emissiveColor.set(1, 1, 1);
      else if (e.state === "windup") v.mat.emissiveColor.set(0.55 + pulse * 0.35, 0.28 + pulse * 0.15, 0.03);
      else if (e.state === "lunge") v.mat.emissiveColor.set(0.7, 0.35, 0.05);
      else if (e.state === "spitWindup") v.mat.emissiveColor.set(0.15, 0.35 + pulse * 0.3, 0.05);
      else if (e.state === "stunned") v.mat.emissiveColor.set(0.12, 0.2, 0.45 + pulse * 0.15);
      else if (e.kind === "boss" && e.guardCd > 0) v.mat.emissiveColor.set(0.22, 0.22, 0.28);
      else if (e.kind === "boss" && !state.flags.bossAwake) v.mat.emissiveColor.set(0, 0, 0.02);
      else v.mat.emissiveColor.set(0, 0, 0);
      v.mesh.position.x = e.state === "windup" ? Math.sin(this.time * 60) * 0.03 : 0;
      v.mesh.rotation.z = e.state === "stunned" ? Math.sin(this.time * 7) * 0.2 : 0;
      v.mesh.rotation.x = e.state === "stunned" ? Math.cos(this.time * 7) * 0.12 : e.state === "lunge" ? 0.25 : 0;
      if (e.state === "stunned") v.mesh.rotation.y = v.yaw + Math.sin(this.time * 3.5) * 0.6;
      if (e.state === "spitWindup") v.mesh.scaling.set(1.15 + pulse * 0.08, 0.9, 1.15 + pulse * 0.08);
      if (e.kind === "boss" && !state.flags.bossAwake) v.mesh.scaling.y *= 0.92;
      if (e.kind === "boss") {
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

  private syncPickups(state: GameState) {
    const seen = new Set<number>();
    for (const k of state.pickups) {
      seen.add(k.id);
      let m = this.pickupMeshes.get(k.id);
      if (!m) {
        const base = k.kind === "heart" ? this.heartMesh : k.value > 1 ? this.rupeeB : this.rupeeG;
        m = base.createInstance("pk" + k.id);
        this.shadows.addShadowCaster(m);
        this.pickupMeshes.set(k.id, m);
      }
      const pos = toWorld(k.map, k.x, k.y, 0.32 + k.z + Math.sin(this.time * 4 + k.id) * 0.05);
      m.position.copyFrom(pos);
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
    const dirty = new Set<Mesh>();
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
    const seen = new Set<number>();
    for (const g of state.globs) {
      seen.add(g.id);
      let m = this.globMeshes.get(g.id);
      if (!m) {
        m = { ball: this.globBase.createInstance("gb" + g.id), ring: this.ringBase.createInstance("gr" + g.id), disc: this.discBase.createInstance("gd" + g.id) };
        this.shadows.addShadowCaster(m.ball);
        this.globMeshes.set(g.id, m);
      }
      const t = Math.min(1, g.t / g.dur);
      const x = g.x0 + (g.tx - g.x0) * t, y = g.y0 + (g.ty - g.y0) * t;
      m.ball.position.copyFrom(toWorld("dungeon", x, y, 1.0 + 4 * 3.2 * t * (1 - t)));
      m.ball.rotation.set(this.time * 5, this.time * 3, 0);
      const target = toWorld("dungeon", g.tx, g.ty, 0.04);
      m.ring.position.copyFrom(target);
      const rs = GLOB_SPLASH_R * (0.55 + 0.45 * t) * (1 + Math.sin(this.time * 18) * 0.03);
      m.ring.scaling.set(rs / 1, 1, rs / 1);
      m.disc.position.copyFrom(target.add(new Vector3(0, -0.01, 0)));
      const ds = GLOB_SPLASH_R * t;
      m.disc.scaling.set(ds, 1, ds);
    }
    for (const [id, m] of this.globMeshes)
      if (!seen.has(id)) {
        this.shadows.removeShadowCaster(m.ball);
        m.ball.dispose();
        m.ring.dispose();
        m.disc.dispose();
        this.globMeshes.delete(id);
      }
    const seenP = new Set<number>();
    for (const q of state.puddles) {
      seenP.add(q.id);
      let m = this.puddleMeshes.get(q.id);
      if (!m) {
        m = this.puddleBase.createInstance("pd" + q.id);
        this.puddleMeshes.set(q.id, m);
      }
      m.position.copyFrom(toWorld("dungeon", q.x, q.y, 0.03));
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
    const want = toWorld(p.map, tx, ty);
    const k = 1 - Math.exp(-dt * 6);
    this.camTarget.x += (want.x - this.camTarget.x) * k;
    this.camTarget.z += (want.z - this.camTarget.z) * k;
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const sh = this.shake * this.shake;
    const ox = (Math.random() - 0.5) * sh * 1.2, oy = (Math.random() - 0.5) * sh * 1.2;
    // classic Zelda tilt: high and behind, looking down at ~55°
    this.camera.position.set(this.camTarget.x + ox, 11.2 + oy, this.camTarget.z - 7.7);
    this.camera.setTarget(new Vector3(this.camTarget.x + ox, 0, this.camTarget.z + 0.2));
    // sun + shadow frustum follow the action
    const c = new Vector3(this.camTarget.x, 0, this.camTarget.z + 2);
    this.sun.position = c.subtract(this.sun.direction.scale(30));
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
        this.particleColors.set([p.c.r, p.c.g, p.c.b, 1], i * 4);
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

  dispose() {
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
