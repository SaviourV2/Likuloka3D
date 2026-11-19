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
import { color, float, min, mix, modelScale, oscSine, positionLocal, smoothstep, time, uniform, userData, vec3 } from 'three/tsl';
import type { OpeningFinish, RoomType } from '@/scene/types';

/** One unit cube shared by every wall piece and door or window part; each is scaled into place. */
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/** 1 normally, 0 with reduced motion: scales the pulse in the shader. */
export const motion = uniform(1);

/** Walls are drawn up to this height above their floor, in metres. */
export const CUT = 1.2;
export const cutHeight = uniform(CUT);

const ACCENT = '#1428a0';

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

function wallMaterial(base: string, shade: string) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
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

const USE: Record<RoomType, string> = {
  living: '#f0b45a', kitchen: '#e98a5c', dining: '#d9a35f', bedroom: '#8fa4ef',
  bathroom: '#6cc3cf', office: '#9dc26f', hallway: '#c9cbd6', laundry: '#86b9d9',
  storage: '#b5a58f', studio: '#c08ad8',
};

const zones = new Map<string, THREE.MeshBasicNodeMaterial>();
function zoneMaterial(use: RoomType, selected: boolean) {
  const key = `${use}:${selected}`;
  let m = zones.get(key);
  if (!m) {
    m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    if (selected) {
      m.colorNode = mix(color(USE[use]), color(ACCENT), float(0.55));
      m.opacityNode = float(0.82).add(oscSine(time.mul(0.6)).sub(0.5).mul(0.24).mul(motion));
    } else {
      m.colorNode = color(USE[use]);
      m.opacityNode = float(0.62);
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
  wall: wallMaterial('#f6f4ef', '#b9bccb'),
  wallSelected: wallMaterial('#5b6fe0', ACCENT),
  slab: slabMaterial('#dcdfea'),
  slabSelected: slabMaterial('#b8c2f2'),
  zone: zoneMaterial,
  handle: handleMaterial('#ffffff'),
  handleRing: handleMaterial(ACCENT),
  insert: handleMaterial('#93a3ff'),
  preview: (() => {
    const m = new THREE.MeshBasicNodeMaterial({ color: ACCENT, transparent: true, opacity: 0.55 });
    m.positionNode = cutPosition();
    return m;
  })(),
  finish: finishMaterial,
  glass: partMaterial('#9cc7e8', { glass: true }),
  partSelected: partMaterial(ACCENT, { roughness: 0.5 }),
  glassSelected: partMaterial('#5b6fe0', { glass: true }),
  ground: new THREE.MeshStandardNodeMaterial({ color: '#dfe3f1', roughness: 1 }),
};

export const USE_COLOURS = USE;
