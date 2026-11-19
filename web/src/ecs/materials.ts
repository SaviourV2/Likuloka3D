/**
 * Materials are TSL node materials, compiled to WGSL on WebGPU (or GLSL on
 * the WebGL 2 fallback). Shading work that depends on position or time runs
 * in the shaders, so nothing on the CPU changes per frame for it:
 *
 * - walls are cut to a section height in the vertex shader: each wall's top
 *   vertices are clamped to `cutHeight`, so cutting every wall costs one
 *   uniform write and no geometry;
 * - walls darken toward the floor from their local height, a cheap contact shade;
 * - the selected zone pulses from the shader's own clock.
 *
 * Materials are shared: an entity changes look by switching material, which
 * costs no shader compile after the first use.
 */
import * as THREE from 'three/webgpu';
import { color, float, min, mix, modelScale, oscSine, positionLocal, smoothstep, time, uniform, vec3 } from 'three/tsl';
import type { RoomType } from '@/scene/types';

/** One unit cube shared by every wall; walls are scaled into place. */
export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/** 1 normally, 0 with reduced motion: scales the pulse in the shader. */
export const motion = uniform(1);

/** Walls are drawn up to this height above their floor, in metres. */
export const CUT = 1.2;
export const cutHeight = uniform(CUT);

const ACCENT = '#1428a0';

function wallMaterial(base: string, shade: string) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  // Unit box: local y runs from -0.5 at the floor to 0.5 at the top.
  const h = smoothstep(float(-0.5), float(-0.25), positionLocal.y);
  m.colorNode = mix(color(shade), color(base), h);
  // The cut, as a local y: the unit box is scaled by the wall's height.
  const top = cutHeight.div(modelScale.y).sub(0.5);
  m.positionNode = vec3(positionLocal.x, min(positionLocal.y, top), positionLocal.z);
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
    m.positionNode = vec3(positionLocal.x, min(positionLocal.y, cutHeight.div(modelScale.y).sub(0.5)), positionLocal.z);
    return m;
  })(),
  ground: new THREE.MeshStandardNodeMaterial({ color: '#dfe3f1', roughness: 1 }),
};

export const USE_COLOURS = USE;
