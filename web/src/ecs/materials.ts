/**
 * Materials are TSL node materials, compiled to WGSL on WebGPU (or GLSL on
 * the WebGL 2 fallback). Shading work that depends on position or time runs
 * in the shaders, so nothing on the CPU changes per frame for it:
 *
 * - walls, doors and windows are cut to a section height in the vertex
 *   shader: every box clamps its vertices to `cutHeight`, measured from the
 *   floor using the box's own bottom height (`userData.y0`), so cutting
 *   everything costs one uniform write and no geometry;
 * - walls darken toward the floor from their local height, a cheap contact shade;
 * - the selected zone pulses from the shader's own clock.
 *
 * Materials are shared: an entity changes look by switching material, which
 * costs no shader compile after the first use.
 */
import * as THREE from 'three/webgpu';
import { color, float, floor, fract, max, min, mod, mix, modelScale, oscSine, positionLocal, positionWorld, smoothstep, step, time, uniform, userData, vec3 } from 'three/tsl';
import { FLOOR_FINISHES, WALL_TILES, type WallTile, type FloorFinish, type OpeningFinish, type RoomType } from '@/scene/types';

/** One unit cube shared by every wall piece and door or window part; each is scaled into place. */
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/** 1 normally, 0 with reduced motion: scales the pulse in the shader. */
export const motion = uniform(1);

/** Walls are drawn up to this height above their floor, in metres. */
export const CUT = 1.2;
export const cutHeight = uniform(CUT);

/** Light blue: the night edition's accent. */
const ACCENT = '#6fd0ff';
const COBALT = '#2f6bff';

/** A slow glow, from the shader's clock; still with reduced motion. */
const glow = () => float(0.55).add(oscSine(time.mul(0.5)).mul(0.45).mul(motion));

/**
 * The rendered object's `userData.y0`, read per object. @types/three types the
 * node without its math methods, so it is typed here as the float node it is.
 */
const objectY0 = () => userData('y0', 'float') as unknown as typeof cutHeight;

/**
 * Clamps a unit box at the cut. The box spans local y -0.5..0.5, scaled by
 * its height and lifted so its bottom sits `y0` metres above the floor.
 * Boxes that start above the cut are hidden by the walls system instead.
 */
function cutPosition() {
  const y0 = objectY0();
  const h = modelScale.y;
  const metres = min(y0.add(positionLocal.y.add(0.5).mul(h)), cutHeight);
  return vec3(positionLocal.x, metres.sub(y0).div(h).sub(0.5), positionLocal.z);
}

function wallMaterial(base: string, shade: string, emissive?: string) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  // A selected wall glows, pulsing slowly.
  if (emissive) m.emissiveNode = color(emissive).mul(glow()).mul(0.6);
  // Darker in the bottom quarter of the full-height pieces, a cheap contact shade.
  const y0 = objectY0();
  const h = smoothstep(float(-0.5), float(-0.25), positionLocal.y).max(y0.greaterThan(0.01).select(float(1), float(0)));
  m.colorNode = mix(color(shade), color(base), h);
  m.positionNode = cutPosition();
  return m;
}

function partMaterial(c: string, opts: { roughness?: number; metalness?: number; glass?: boolean } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ color: c, roughness: opts.roughness ?? 0.6, metalness: opts.metalness ?? 0 });
  if (opts.glass) { m.transparent = true; m.opacity = 0.38; m.depthWrite = false; m.roughness = 0.05; }
  m.positionNode = cutPosition();
  return m;
}

/** Room colours: vivid against the night floor. */
const USE: Record<RoomType, string> = {
  living: '#ffb547', kitchen: '#ff7a59', dining: '#ffd166', bedroom: '#8c7bff',
  bathroom: '#38e1ff', office: '#5cf2a0', hallway: '#7f95bd', laundry: '#4fb8ff',
  storage: '#c9a77a', studio: '#ff6bd6', pool: '#19b5e6', garage: '#9aa7b8',
};

const wallTiles = new Map<string, THREE.MeshStandardNodeMaterial>();
/**
 * Tiles on a wall panel. The panel is the unit box scaled to its length and
 * height, so the joints are laid out along it from its own coordinates and
 * up it from world height, which keeps rows level across a room.
 */
export function wallTileMaterial(tile: Exclude<WallTile, 'none'>) {
  let m = wallTiles.get(tile);
  if (!m) {
    const t = WALL_TILES[tile], [w, h] = t.size;
    m = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0 });
    if (!w) m.colorNode = color(t.base);
    else {
      const row = positionWorld.y.div(h), along = positionLocal.x.mul(modelScale.x).div(w).add(t.bond ? mod(floor(row), float(2)).mul(0.5) : float(0));
      m.colorNode = mix(color(t.base), color(t.joint), max(step(fract(along), float(0.006 / w)), step(fract(row), float(0.006 / h))));
    }
    wallTiles.set(tile, m);
  }
  return m;
}

const zones = new Map<string, THREE.MeshBasicNodeMaterial>();
/** Joints are drawn this wide, in metres: wider than real ones, so they still show from above the house. */
const JOINT = 0.012;

/** A floor finish: its colour, with the joints of its tiles or planks laid out in world metres. */
function floorColour(floor: Exclude<FloorFinish, 'none'>) {
  const f = FLOOR_FINISHES[floor];
  const [w, l] = f.size;
  if (!w) return color(f.base);
  const joint = max(step(fract(positionWorld.x.div(w)), float(JOINT / w)), step(fract(positionWorld.z.div(l)), float(JOINT / l)));
  return mix(color(f.base), color(f.joint), joint);
}

function zoneMaterial(use: RoomType, selected: boolean, floor: FloorFinish = 'none') {
  const key = `${use}:${selected}:${floor}`;
  let m = zones.get(key);
  if (!m) {
    m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    if (use === 'pool') {
      // Water: pool tiles seen through it, 150 mm square, whatever floor the zone was given.
      const joint = max(step(fract(positionWorld.x.div(0.15)), float(0.1)), step(fract(positionWorld.z.div(0.15)), float(0.1)));
      const water = mix(color('#27c1ee'), color('#0e86c4'), joint);
      m.colorNode = selected ? mix(water, color(ACCENT), float(0.35)) : water;
      m.opacityNode = float(0.92);
    } else if (floor !== 'none') {
      // A finished floor is solid; selected, it takes the accent and pulses like any zone.
      m.colorNode = selected ? mix(floorColour(floor), color(ACCENT), float(0.3).add(oscSine(time.mul(0.6)).sub(0.5).mul(0.2).mul(motion))) : floorColour(floor);
      m.opacityNode = float(0.96);
    } else if (selected) {
      m.colorNode = mix(color(USE[use]), color(ACCENT), float(0.45));
      m.opacityNode = float(0.85).add(oscSine(time.mul(0.6)).sub(0.5).mul(0.24).mul(motion));
    } else {
      m.colorNode = color(USE[use]);
      m.opacityNode = float(0.5);
    }
    zones.set(key, m);
  }
  return m;
}

/**
 * The look of each frame finish, for the frame and for a door leaf. These are
 * generic material colours, not any manufacturer's product.
 */
const FINISH: Record<OpeningFinish, { frame: string; leaf: string; roughness: number; metalness: number }> = {
  timber: { frame: '#9c6f45', leaf: '#b98a5a', roughness: 0.75, metalness: 0 },
  steel: { frame: '#3f444c', leaf: '#555b64', roughness: 0.45, metalness: 0.55 },
  aluminium: { frame: '#bfc4cb', leaf: '#cdd1d7', roughness: 0.35, metalness: 0.7 },
  upvc: { frame: '#f4f4f0', leaf: '#ecece6', roughness: 0.5, metalness: 0 },
};
const finishes = new Map<string, THREE.MeshStandardNodeMaterial>();
function finishMaterial(finish: OpeningFinish, part: 'frame' | 'leaf') {
  const key = `${finish}:${part}`;
  let m = finishes.get(key);
  if (!m) {
    const f = FINISH[finish];
    m = partMaterial(f[part], { roughness: f.roughness, metalness: f.metalness });
    finishes.set(key, m);
  }
  return m;
}
export const FINISH_SWATCH: Record<OpeningFinish, string> = {
  timber: FINISH.timber.leaf, steel: FINISH.steel.frame, aluminium: FINISH.aluminium.frame, upvc: FINISH.upvc.frame,
};

function slabMaterial(top: string) {
  return new THREE.MeshStandardNodeMaterial({ color: top, roughness: 0.95, metalness: 0 });
}

function handleMaterial(c: string) {
  const m = new THREE.MeshBasicNodeMaterial({ color: c, depthTest: false, transparent: true });
  return m;
}

export const materials = {
  wall: wallMaterial('#e9eef8', '#4c5d80'),
  wallSelected: wallMaterial('#9fe3ff', COBALT, ACCENT),
  slab: slabMaterial('#161d2c'),
  slabSelected: slabMaterial('#1f3a6e'),
  zone: zoneMaterial,
  handle: handleMaterial('#ffffff'),
  handleRing: handleMaterial(ACCENT),
  insert: handleMaterial('#c6f0ff'),
  preview: (() => {
    const m = new THREE.MeshBasicNodeMaterial({ color: ACCENT, transparent: true, opacity: 0.55 });
    m.positionNode = cutPosition();
    return m;
  })(),
  finish: finishMaterial,
  glass: partMaterial('#9cc7e8', { glass: true }),
  partSelected: (() => { const m = partMaterial(ACCENT, { roughness: 0.5 }); m.emissiveNode = color(ACCENT).mul(glow()).mul(0.5); return m; })(),
  glassSelected: partMaterial('#5b6fe0', { glass: true }),
  ground: new THREE.MeshStandardNodeMaterial({ color: '#070b14', roughness: 1 }),
};

export const USE_COLOURS = USE;
