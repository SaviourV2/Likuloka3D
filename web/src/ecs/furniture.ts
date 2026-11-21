/**
 * Draws each level's furniture.
 *
 * The pieces are not in the document: `furnishLevel` works them out from the
 * level's rooms, so this system redraws a level whenever one of its zones,
 * walls or openings is a different object than last time. React mounts one
 * empty group per level (`attach`); everything inside it is built here.
 *
 * A piece is drawn from its model files once they have loaded, and from its
 * boxes until then, or always if the files are missing. A model is stretched
 * to the box the layout gave it, so it fits the room the way the boxes did.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { furnishLevel, wallSkins, type FurnitureBox, type FurnitureModel } from '@/scene/furnish';
import { WALL_PAINTS } from '@/scene/types';
import type { Id, ItemNode, SceneDoc } from '@/scene/types';
import { CUT, UNIT_BOX, wallTileMaterial } from './materials';

export const MODEL_NAMES = [
  'bathroomCabinetDrawer', 'bathroomMirror', 'bathtub', 'bedDouble', 'bedSingle', 'bookcaseClosedDoors', 'bookcaseOpen',
  'cabinetBed', 'cabinetTelevision', 'chairCushion', 'chairDesk', 'computerScreen', 'desk', 'dryer', 'hoodModern',
  'kitchenCabinet', 'kitchenCabinetDrawer', 'kitchenCabinetUpper', 'kitchenFridge', 'kitchenSink', 'kitchenStove',
  'lampRoundFloor', 'lampRoundTable', 'loungeChair', 'loungeSofa', 'pottedPlant', 'rugRectangle', 'shower', 'sideTable',
  'table', 'tableCoffee', 'televisionModern', 'toilet', 'washer',
];

interface Source { scene: THREE.Object3D; min: THREE.Vector3; size: THREE.Vector3; centre: THREE.Vector3 }
/** What a mesh of a kit model was painted with: the kit's material name and its colour. */
interface Paint { name: string; hex: number }

const CYLINDER = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
const BALL = new THREE.SphereGeometry(0.5, 16, 12);
const WOOD = 0xb58d62, DARK = 0x6a5242;
const lighten = (c: number, k: number) => { const r = c >> 16 & 255, g = c >> 8 & 255, b = c & 255, m = (v: number) => Math.round(v + (255 - v) * k); return m(r) << 16 | m(g) << 8 | m(b); };

class Furniture {
  /** Where the model files are: not asked for yet, on their way, loaded, or not there (boxes are drawn). */
  models: 'idle' | 'loading' | 'ready' | 'missing' = 'idle';
  /** What the last redraw drew, for the tests and the status line. */
  stats = { pieces: 0, models: 0, boxes: 0, skins: 0, redraws: 0 };
  private lib = new Map<string, Source>();
  private groups = new Map<Id, THREE.Group>();
  /** The objects each level's furniture was last worked out from. */
  private seen = new Map<Id, unknown[]>();
  private shown: { on: boolean; cut: boolean; models: string } = { on: false, cut: true, models: 'idle' };
  private counts = new Map<Id, { pieces: number; models: number; boxes: number; skins: number }>();
  private flat = new Map<number, THREE.MeshStandardMaterial>();
  private lit = new Map<string, THREE.Material>();
  private glass = new THREE.MeshStandardMaterial({ color: 0xbfe4f2, transparent: true, opacity: 0.3, roughness: 0.05, depthWrite: false });
  private mark = new THREE.MeshBasicNodeMaterial({ color: '#6fd0ff', toneMapped: false });
  private leaf = new THREE.MeshStandardMaterial({ color: 0x5d8f5c, roughness: 0.9, flatShading: true });

  attach(level: Id, group: THREE.Group) { this.groups.set(level, group); this.seen.delete(level); }
  detach(level: Id, group: THREE.Group) {
    if (this.groups.get(level) !== group) return;
    this.groups.delete(level); this.seen.delete(level); this.counts.delete(level);
  }

  /** Fetches the model files once. `done` is called when they are in, so the view can be drawn again. */
  load(done: () => void) {
    if (this.models !== 'idle') return;
    this.models = 'loading';
    const loader = new GLTFLoader();
    Promise.all(MODEL_NAMES.map(async name => {
      const gltf = await loader.loadAsync(`models/${name}.glb`);
      const scene = gltf.scene; scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene), size = box.getSize(new THREE.Vector3());
      if (!(size.x > 0 && size.y > 0 && size.z > 0)) throw new Error(`empty model ${name}`);
      scene.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = mesh.material as THREE.MeshStandardMaterial;
        mesh.userData.paint = { name: m.name || '', hex: m.color ? m.color.getHex() : 0xcccccc } satisfies Paint;
      });
      this.lib.set(name, { scene, min: box.min.clone(), size, centre: box.getCenter(new THREE.Vector3()) });
    })).then(() => { this.models = 'ready'; }, () => { this.lib.clear(); this.models = 'missing'; }).finally(done);
  }

  /** Redraws the levels whose rooms, walls or openings changed. Returns whether anything was redrawn. */
  step(doc: SceneDoc, on: boolean, cut: boolean): boolean {
    const all = on !== this.shown.on || cut !== this.shown.cut || this.models !== this.shown.models;
    this.shown = { on, cut, models: this.models };
    let drew = false;
    for (const [id, group] of this.groups) {
      const level = doc.nodes[id];
      if (level?.type !== 'level') continue;
      // Furniture depends on the level's zones, walls and openings, and on nothing else.
      const deps: unknown[] = [];
      for (const c of level.children) {
        const n = doc.nodes[c];
        if (n?.type === 'zone') deps.push(n);
        else if (n?.type === 'wall') { deps.push(n); for (const o of n.children) deps.push(doc.nodes[o]); }
      }
      const was = this.seen.get(id);
      if (!all && was && was.length === deps.length && was.every((d, i) => d === deps[i])) continue;
      this.seen.set(id, deps);
      this.draw(group, doc, id, on, cut);
      drew = true;
    }
    if (drew) {
      const t = { pieces: 0, models: 0, boxes: 0, skins: 0 };
      for (const c of this.counts.values()) { t.pieces += c.pieces; t.models += c.models; t.boxes += c.boxes; t.skins += c.skins; }
      this.stats = { ...t, redraws: this.stats.redraws + 1 };
    }
    return drew;
  }

  private draw(group: THREE.Group, doc: SceneDoc, level: Id, on: boolean, cut: boolean) {
    group.clear(); // geometries and materials are shared, so there is nothing to dispose
    const count = { pieces: 0, models: 0, boxes: 0, skins: 0 };
    this.counts.set(level, count);
    // Paint and tiles are part of the room, so they are drawn whether or not furniture is shown.
    for (const s of wallSkins(doc, level)) {
      const z1 = cut ? Math.min(s.z1, CUT) : s.z1;
      if (z1 - s.z0 < 0.005) continue;
      const mesh = new THREE.Mesh(UNIT_BOX, s.tile !== 'none' ? wallTileMaterial(s.tile) : this.colour(new THREE.Color(WALL_PAINTS[s.paint as Exclude<typeof s.paint, 'none'>].colour).getHex()));
      mesh.scale.set(s.len, z1 - s.z0, 0.012);
      mesh.position.set(s.cx, (s.z0 + z1) / 2, s.cz);
      mesh.rotation.y = s.yaw;
      mesh.receiveShadow = true; mesh.raycast = () => {};
      group.add(mesh); count.skins++;
    }
    if (!on) return;
    // With the walls cut, what hangs above the cut (upper cabinets, mirrors) is left out, like the walls it hangs on.
    const hidden = (z0: number) => cut && z0 >= CUT - 0.2;
    for (const piece of furnishLevel(doc, level)) {
      count.pieces++;
      if (piece.models && piece.models.every(m => this.lib.has(m.name))) {
        for (const m of piece.models) if (!hidden(m.y0)) { group.add(this.model(m, piece.tint)); count.models++; }
      } else for (const b of piece.boxes) if (!hidden(b.z0)) { group.add(this.box(b)); count.boxes++; }
    }
  }

  /**
   * Builds a placed item into its group: the same boxes or models, in the
   * item's own frame, with the group carrying its place and turn. A selected
   * item stands on a lit outline of its footprint.
   */
  item(group: THREE.Object3D, it: ItemNode, cut: boolean, selected: boolean) {
    group.clear();
    group.position.set(it.at[0], 0, it.at[1]);
    group.rotation.y = it.turn * Math.PI / 180;
    const [w, d] = it.size, hidden = (z0: number) => cut && z0 >= CUT - 0.2;
    if (it.models && it.models.every(m => this.lib.has(m[0]))) {
      for (const m of it.models) if (!hidden(m[5])) group.add(this.model({ name: m[0], cx: (m[1] + m[2]) / 2 - w / 2, cz: (m[3] + m[4]) / 2 - d / 2, w: m[2] - m[1], d: m[4] - m[3], y0: m[5], h: m[6] - m[5], yaw: m[7] === 'flip' ? Math.PI : 0 }, it.tint));
    } else for (const p of it.parts) if (!hidden(p[4])) {
      group.add(this.box({ kind: (p[7] || 'box') as FurnitureBox['kind'], cx: (p[0] + p[1]) / 2 - w / 2, cz: (p[2] + p[3]) / 2 - d / 2, lw: p[1] - p[0], ld: p[3] - p[2], z0: p[4], z1: p[5], yaw: 0, color: p[6], x0: 0, x1: 0, y0: 0, y1: 0 }));
    }
    if (selected) {
      const t = 0.05;
      for (const [x, z, sx, sz] of [[0, -d / 2 - t, w + 4 * t, t], [0, d / 2 + t, w + 4 * t, t], [-w / 2 - t, 0, t, d + 2 * t], [w / 2 + t, 0, t, d + 2 * t]]) {
        const edge = new THREE.Mesh(UNIT_BOX, this.mark);
        edge.position.set(x, 0.02, z); edge.scale.set(sx, 0.02, sz); edge.raycast = () => {};
        group.add(edge);
      }
    }
  }

  private box(b: FurnitureBox): THREE.Object3D {
    const round = b.kind === 'cyl' || b.kind === 'ball';
    const mesh = new THREE.Mesh(b.kind === 'cyl' ? CYLINDER : b.kind === 'ball' ? BALL : UNIT_BOX, b.kind === 'glass' ? this.glass : b.kind === 'ball' ? this.leaf : this.colour(b.color));
    const d = Math.min(b.lw, b.ld);
    mesh.scale.set(round ? d : b.lw, b.z1 - b.z0, round ? d : b.ld);
    mesh.position.set(b.cx, (b.z0 + b.z1) / 2, b.cz);
    mesh.rotation.y = b.yaw;
    mesh.castShadow = b.kind !== 'glass'; mesh.receiveShadow = true;
    return mesh;
  }

  private model(m: FurnitureModel, tint: number): THREE.Object3D {
    const src = this.lib.get(m.name)!, inner = src.scene.clone(true), holder = new THREE.Group();
    inner.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) { mesh.material = this.paint(mesh.userData.paint as Paint, tint); mesh.castShadow = true; mesh.receiveShadow = true; }
    });
    inner.position.set(-src.centre.x, -src.min.y, -src.centre.z);
    holder.add(inner);
    holder.scale.set(m.w / src.size.x, m.h / src.size.y, m.d / src.size.z);
    holder.rotation.y = m.yaw;
    holder.position.set(m.cx, m.y0, m.cz);
    return holder;
  }

  private colour(hex: number) {
    let m = this.flat.get(hex);
    if (!m) { m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8 }); this.flat.set(hex, m); }
    return m;
  }

  /** The kit's materials are flat colours. Fabric takes the room's colour and wood matches the boxes' wood. */
  private paint(p: Paint, tint: number): THREE.Material {
    if (p.name === 'glass') return this.glass;
    const fabric = p.name === 'carpet' || p.name === 'carpetDarker', key = `${p.name}|${p.hex}${fabric ? `|${tint}` : ''}`;
    let m = this.lit.get(key);
    if (!m) {
      const c = p.name === 'carpet' ? tint : p.name === 'carpetDarker' ? lighten(tint, 0.45) : p.name === 'wood' ? WOOD : p.name === 'woodDark' ? DARK : p.hex;
      m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, flatShading: true });
      this.lit.set(key, m);
    }
    return m;
  }
}

export const furniture = new Furniture();
