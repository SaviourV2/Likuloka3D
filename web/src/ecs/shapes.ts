/**
 * Curved parts for rounded (arched) doors and windows.
 *
 * Each shape is extruded and then normalised to the unit cube, centred on
 * the origin, like the shared box. A part is then placed exactly as a box
 * is, by position and scale. So the cut shader (which reads local y and the
 * scale) and picking work unchanged. Geometries are cached by their
 * proportions, so dragging or rebuilding never makes new ones for the same size.
 */
import * as THREE from 'three/webgpu';

const cache = new Map<string, THREE.BufferGeometry>();
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function normalised(key: string, shape: () => THREE.Shape): THREE.BufferGeometry {
  let g = cache.get(key);
  if (g) return g;
  g = new THREE.ExtrudeGeometry(shape(), { depth: 1, bevelEnabled: false, curveSegments: 28 });
  g.computeBoundingBox();
  const box = g.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  g.translate(-centre.x, -centre.y, -centre.z);
  g.scale(1 / size.x, 1 / size.y, 1 / size.z);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  cache.set(key, g);
  return g;
}

/**
 * The wall above a rounded opening: a rectangle `w` wide and `h` tall whose
 * bottom edge follows the arch (radius w/2, springing from the bottom corners).
 */
export function spandrel(w: number, h: number) {
  return normalised(`spandrel:${r3(w / h)}`, () => {
    const r = w / 2;
    const s = new THREE.Shape();
    s.moveTo(-r, 0);
    s.lineTo(-r, h);
    s.lineTo(r, h);
    s.lineTo(r, 0);
    s.absarc(0, 0, r, 0, Math.PI, false);
    return s;
  });
}

/** The curved head of a frame: a half ring from radius `r` in to `r - band`. */
export function archBand(r: number, band: number) {
  return normalised(`band:${r3(band / r)}`, () => {
    const inner = r - band;
    const s = new THREE.Shape();
    s.moveTo(r, 0);
    s.absarc(0, 0, r, 0, Math.PI, false);
    s.lineTo(-inner, 0);
    s.absarc(0, 0, inner, Math.PI, 0, true);
    s.closePath();
    return s;
  });
}

/** A door leaf or pane: `a` either side of centre, straight for `straight`, then a half circle. */
export function archedPanel(a: number, straight: number) {
  return normalised(`panel:${r3(straight / a)}`, () => {
    const s = new THREE.Shape();
    s.moveTo(-a, -straight);
    s.lineTo(a, -straight);
    s.lineTo(a, 0);
    s.absarc(0, 0, a, 0, Math.PI, false);
    s.closePath();
    return s;
  });
}
