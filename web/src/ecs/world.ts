/**
 * The ECS side of the editor.
 *
 * Entities are scene node ids. Their components are the node's data in the
 * document plus the three.js object React mounted for them. Systems run once
 * per frame, in order, and only touch entities in the dirty set:
 *
 *   wallSystem        walls: a few boxes per dirty wall, cut around its doors
 *                     and windows, all sharing one unit box geometry
 *   openingSystem     doors and windows: frame, leaf or glass, as boxes
 *   outlineSystem     slabs and zones: rebuild the dirty outlines' buffers
 *   layoutSystem      buildings and levels: stack, explode or solo, eased
 *   selectionSystem   swaps the material of the old and new selection
 *
 * The dirty set is fed by diffing documents: an edit replaces only the nodes
 * it touches, so a node is dirty exactly when its object identity changed.
 * Dependencies are added before the systems run: a dirty opening makes its
 * wall dirty (the wall's pieces are cut around it), and a wall whose
 * thickness changed makes its openings dirty (their frames span the wall).
 * React mounts and unmounts entities when a parent's `children` change; it
 * does not re-render when a wall moves, because no component reads wall data.
 */
import * as THREE from 'three/webgpu';
import { ancestor } from '@/scene/ops';
import type { BuildingView } from '@/scene/store';
import type { Id, NodeType, OpeningNode, SceneDoc, SlabNode, Vec2, WallNode, ZoneNode } from '@/scene/types';
import { CUT, materials, UNIT_BOX } from './materials';
import { archBand, archedPanel, spandrel } from './shapes';

export interface Entity { id: Id; kind: NodeType; object: THREE.Object3D }

export interface Stats {
  frames: number;
  /** Updates per kind since the page loaded. */
  updates: Record<'wall' | 'opening' | 'zone' | 'slab' | 'layout' | 'selection', number>;
  /** Ids each system updated in the most recent frame that updated anything. */
  last: { frame: number; ids: Id[] };
}

export const EXPLODE_GAP = 2.75;

class World {
  readonly entities = new Map<Id, Entity>();
  readonly dirty = new Set<Id>();
  /** Where each level is drawn now, and where it is heading. */
  readonly levels = new Map<Id, { y: number; target: number; visible: boolean }>();
  selected: Id | null = null;
  reducedMotion = false;
  stats: Stats = { frames: 0, updates: { wall: 0, opening: 0, zone: 0, slab: 0, layout: 0, selection: 0 }, last: { frame: 0, ids: [] } };
  /** Whether walls are cut at the section height. */
  cut = true;
  private layoutDirty = true;
  /** Each wall's thickness when it was last built, to know when its openings need rebuilding. */
  private thickness = new Map<Id, number>();

  register(id: Id, kind: NodeType, object: THREE.Object3D) {
    object.userData.id = id;
    this.entities.set(id, { id, kind, object });
    this.dirty.add(id);
    this.layoutDirty = true;
  }

  unregister(id: Id, object: THREE.Object3D) {
    if (this.entities.get(id)?.object !== object) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry !== UNIT_BOX) mesh.geometry.dispose();
    this.entities.delete(id);
    this.levels.delete(id);
    this.thickness.delete(id);
  }

  markDirty(ids: Iterable<Id>) {
    for (const id of ids) this.dirty.add(id);
    this.layoutDirty = true;
  }

  /** Runs every system once. Returns the ids updated this frame. */
  step(doc: SceneDoc, views: Record<Id, BuildingView>, selection: Id | null, cut: boolean, dt: number): Id[] {
    this.stats.frames++;
    const touched: Id[] = [];
    if (this.selected !== selection) {
      // Walls and openings are rebuilt with the selection's materials; it is a few matrix uploads.
      for (const id of [this.selected, selection]) {
        const kind = id ? this.entities.get(id)?.kind : undefined;
        if (id && (kind === 'wall' || kind === 'opening')) this.dirty.add(id);
      }
    }
    if (cut !== this.cut) {
      // Which pieces sit wholly above the cut changes, so every wall and opening is rebuilt.
      this.cut = cut;
      for (const e of this.entities.values()) if (e.kind === 'wall' || e.kind === 'opening') this.dirty.add(e.id);
    }
    if (this.dirty.size) {
      const work = new Set(this.dirty);
      for (const id of this.dirty) {
        const node = doc.nodes[id];
        if (node?.type === 'opening') work.add(node.parent);
        if (node?.type === 'wall' && this.thickness.get(id) !== node.thickness) node.children.forEach(c => work.add(c));
      }
      this.dirty.clear();
      for (const id of work) {
        const node = doc.nodes[id];
        const entity = this.entities.get(id);
        if (!node || !entity) continue;
        const selected = id === selection;
        if (node.type === 'wall') {
          buildWall(entity.object, node, openingsOf(doc, node), this.cut, selected);
          this.thickness.set(id, node.thickness);
          this.stats.updates.wall++;
        } else if (node.type === 'opening') {
          const wall = doc.nodes[node.parent];
          if (wall?.type !== 'wall') continue;
          buildOpening(entity.object, node, wall, this.cut, selected);
          this.stats.updates.opening++;
        } else if (node.type === 'slab') {
          slabGeometry(entity.object as THREE.Mesh, node);
          paintOutline(entity.object as THREE.Mesh, node, selected);
          this.stats.updates.slab++;
        } else if (node.type === 'zone') {
          zoneGeometry(entity.object as THREE.Mesh, node);
          paintOutline(entity.object as THREE.Mesh, node, selected);
          this.stats.updates.zone++;
        } else if (node.type === 'building') {
          entity.object.position.set(node.origin[0], 0, node.origin[1]);
        } else continue;
        touched.push(id);
      }
    }
    if (this.layout(doc, views, dt)) { this.stats.updates.layout++; }
    if (this.selected !== selection) {
      for (const id of [this.selected, selection]) {
        const node = id ? doc.nodes[id] : undefined;
        const entity = id ? this.entities.get(id) : undefined;
        if (node?.type === 'zone' || node?.type === 'slab') paintOutline(entity!.object as THREE.Mesh, node, id === selection);
      }
      this.selected = selection;
      this.stats.updates.selection++;
    }
    if (touched.length) this.stats.last = { frame: this.stats.frames, ids: touched };
    return touched;
  }

  /** Eases each level toward its place for the building's mode. Returns whether anything moved. */
  private layout(doc: SceneDoc, views: Record<Id, BuildingView>, dt: number): boolean {
    let moving = this.layoutDirty;
    if (!moving) for (const l of this.levels.values()) if (Math.abs(l.y - l.target) > 1e-4) { moving = true; break; }
    if (!moving) return false;
    this.layoutDirty = false;
    for (const b of doc.roots) {
      const building = doc.nodes[b];
      if (building?.type !== 'building') continue;
      const view = views[b] ?? { mode: 'stack', solo: null };
      const levels = building.children.map(c => doc.nodes[c]).filter(n => n?.type === 'level').sort((p, q) => p!.elevation - q!.elevation);
      levels.forEach((level, i) => {
        if (!level || level.type !== 'level') return;
        const target = level.elevation + (view.mode === 'explode' ? i * EXPLODE_GAP : 0);
        const visible = view.mode !== 'solo' || view.solo === level.id;
        const cur = this.levels.get(level.id);
        const k = this.reducedMotion || !cur ? 1 : 1 - Math.exp(-dt * 12);
        const y = cur ? cur.y + (target - cur.y) * k : target;
        const done = Math.abs(target - y) < 1e-3 ? target : y;
        this.levels.set(level.id, { y: done, target, visible });
        const obj = this.entities.get(level.id)?.object;
        if (obj) { obj.position.y = done; obj.visible = visible; }
      });
    }
    return true;
  }

  /** World position of a plan point on a level, as the level is drawn now. */
  toWorld(doc: SceneDoc, levelId: Id, p: Vec2, lift = 0): THREE.Vector3 {
    const building = ancestor(doc, levelId, 'building');
    const y = this.levels.get(levelId)?.y ?? (doc.nodes[levelId]?.type === 'level' ? (doc.nodes[levelId] as { elevation: number }).elevation : 0);
    return new THREE.Vector3(p[0] + (building?.origin[0] ?? 0), y + lift, p[1] + (building?.origin[1] ?? 0));
  }

  /** The plan point under a world position on a level's floor plane. */
  toPlan(doc: SceneDoc, levelId: Id, v: THREE.Vector3): Vec2 {
    const building = ancestor(doc, levelId, 'building');
    return [v.x - (building?.origin[0] ?? 0), v.z - (building?.origin[1] ?? 0)];
  }

  levelY(levelId: Id): number { return this.levels.get(levelId)?.y ?? 0; }

  resetStats() {
    this.stats = { frames: this.stats.frames, updates: { wall: 0, opening: 0, zone: 0, slab: 0, layout: 0, selection: 0 }, last: { frame: this.stats.frames, ids: [] } };
  }
}

export const world = new World();

// ---- per-kind updates -------------------------------------------------------------

const openingsOf = (doc: SceneDoc, w: WallNode) =>
  w.children.map(c => doc.nodes[c]).filter((n): n is OpeningNode => n?.type === 'opening').sort((p, q) => p.offset - q.offset);

/**
 * A box in the local space of a wall or opening group: x along the wall, y up
 * from the floor, z across. `geometry` swaps the unit cube for a curved part
 * normalised to the same cube; `hinge` swings the box about a vertical axis
 * at x = `hinge.x`, z = 0, as an open door leaf or window sash does.
 */
interface Box {
  x0: number; x1: number; y0: number; y1: number; depth: number; material: THREE.Material;
  geometry?: THREE.BufferGeometry;
  hinge?: { x: number; angle: number };
}

const PART = 'part';
const cutTop = () => (world.cut ? CUT : Infinity);

/**
 * Picks a box as it is drawn: the shader clamps boxes at the cut, so the ray
 * is tested against the part of the box below the cut.
 */
function cutRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, out: THREE.Intersection[]) {
  if (!this.visible) return;
  const y0 = (this.userData.y0 as number) ?? 0;
  const top = Math.min(0.5, (cutTop() - y0) / this.scale.y - 0.5);
  if (top <= -0.5) return;
  inverse.copy(this.matrixWorld).invert();
  localRay.copy(raycaster.ray).applyMatrix4(inverse);
  hitBox.min.set(-0.5, -0.5, -0.5);
  hitBox.max.set(0.5, top, 0.5);
  if (!localRay.intersectBox(hitBox, hitAt)) return;
  const point = hitAt.clone().applyMatrix4(this.matrixWorld);
  const distance = raycaster.ray.origin.distanceTo(point);
  if (distance < raycaster.near || distance > raycaster.far) return;
  out.push({ distance, point, object: this });
}
const inverse = new THREE.Matrix4();
const localRay = new THREE.Ray();
const hitBox = new THREE.Box3();
const hitAt = new THREE.Vector3();

/**
 * Puts a group's boxes in place, reusing its meshes. Every box is the shared
 * unit cube, scaled: rebuilding a wall uploads matrices, never geometry.
 */
function placeBoxes(group: THREE.Object3D, boxes: Box[], cut: boolean) {
  const parts = group.children.filter(c => c.userData[PART]) as THREE.Mesh[];
  while (parts.length < boxes.length) {
    const m = new THREE.Mesh(UNIT_BOX, boxes[0].material);
    m.userData[PART] = true;
    m.castShadow = true;
    m.receiveShadow = true;
    m.raycast = cutRaycast;
    group.add(m);
    parts.push(m);
  }
  while (parts.length > boxes.length) group.remove(parts.pop()!);
  boxes.forEach((b, i) => {
    const m = parts[i];
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    if (b.hinge) {
      const d = cx - b.hinge.x;
      m.position.set(b.hinge.x + d * Math.cos(b.hinge.angle), cy, -d * Math.sin(b.hinge.angle));
      m.rotation.set(0, b.hinge.angle, 0);
    } else {
      m.position.set(cx, cy, 0);
      m.rotation.set(0, 0, 0);
    }
    m.scale.set(Math.max(b.x1 - b.x0, 1e-3), Math.max(b.y1 - b.y0, 1e-3), b.depth);
    m.geometry = b.geometry ?? UNIT_BOX;
    m.userData.y0 = b.y0;
    // A box that starts above the cut would collapse to a sheet at the cut; it is hidden instead.
    m.visible = !(cut && b.y0 >= CUT - 1e-6);
    m.material = b.material;
    m.updateMatrix();
  });
}

/**
 * A wall runs along its group's x axis from end `a`. It is built as boxes:
 * full height between openings, and below and above each opening. Its ends
 * run on by half the thickness so that corners close.
 */
function buildWall(group: THREE.Object3D, w: WallNode, openings: OpeningNode[], cut: boolean, selected: boolean) {
  const dx = w.b[0] - w.a[0];
  const dz = w.b[1] - w.a[1];
  const len = Math.hypot(dx, dz);
  group.position.set(w.a[0], 0, w.a[1]);
  group.rotation.set(0, -Math.atan2(dz, dx), 0);
  group.updateMatrix();
  const material = selected ? materials.wallSelected : materials.wall;
  const t = w.thickness, H = w.height;
  const boxes: Box[] = [];
  let at = -t / 2;
  for (const o of openings) {
    const x0 = o.offset - o.width / 2, x1 = o.offset + o.width / 2;
    const top = Math.min(o.sill + o.height, H);
    if (x0 > at + 1e-6) boxes.push({ x0: at, x1: x0, y0: 0, y1: H, depth: t, material });
    if (o.sill > 1e-6) boxes.push({ x0, x1, y0: 0, y1: o.sill, depth: t, material });
    if (o.shape === 'arched') {
      // The wall over a rounded head follows the arch down to where it springs.
      const spring = top - o.width / 2;
      boxes.push({ x0, x1, y0: spring, y1: H, depth: t, material, geometry: spandrel(o.width, H - spring) });
    } else if (top < H - 1e-6) boxes.push({ x0, x1, y0: top, y1: H, depth: t, material });
    at = x1;
  }
  boxes.push({ x0: at, x1: len + t / 2, y0: 0, y1: H, depth: t, material });
  placeBoxes(group, boxes, cut);
}

/** How far an open door leaf and an open window sash swing, in radians. */
const DOOR_SWING = 1.25;
const SASH_SWING = 0.55;
const BAND = 0.05;

/**
 * A door is a frame and a leaf; a window is a frame, a sill board and a pane
 * of glass. A rounded opening has a curved head and a leaf or pane that
 * follows it. An open leaf or pane swings about its left side.
 */
function buildOpening(group: THREE.Object3D, o: OpeningNode, wall: WallNode, cut: boolean, selected: boolean) {
  group.position.set(o.offset, 0, 0);
  group.updateMatrix();
  const f = BAND;
  const depth = wall.thickness + 0.02;
  const w = o.width / 2;
  const a = w - f;
  const top = Math.min(o.sill + o.height, wall.height);
  const arched = o.shape === 'arched';
  const spring = arched ? top - w : top;
  const frame = selected ? materials.partSelected : materials.finish(o.finish, 'frame');
  const leaf = selected ? materials.partSelected : materials.finish(o.finish, 'leaf');
  const glass = selected ? materials.glassSelected : materials.glass;
  const boxes: Box[] = [
    { x0: -w, x1: -w + f, y0: o.sill, y1: spring, depth, material: frame },
    { x0: w - f, x1: w, y0: o.sill, y1: spring, depth, material: frame },
    arched
      ? { x0: -w, x1: w, y0: spring, y1: top, depth, material: frame, geometry: archBand(w, f) }
      : { x0: -w, x1: w, y0: top - f, y1: top, depth, material: frame },
  ];
  const panel = (y0: number, d: number, material: THREE.Material, swing: number): Box => {
    const hinge = o.state === 'open' ? { x: -a, angle: swing } : undefined;
    return arched
      ? { x0: -a, x1: a, y0, y1: spring + a, depth: d, material, hinge, geometry: archedPanel(a, spring - y0) }
      : { x0: -a, x1: a, y0, y1: top - f, depth: d, material, hinge };
  };
  if (o.kind === 'door') {
    boxes.push(panel(0, 0.045, leaf, DOOR_SWING));
  } else {
    boxes.push({ x0: -w, x1: w, y0: o.sill, y1: o.sill + f, depth: depth + 0.04, material: frame });
    boxes.push(panel(o.sill + f, 0.02, glass, SASH_SWING));
  }
  placeBoxes(group, boxes, cut);
}

function shapeOf(points: readonly Vec2[]): THREE.Shape {
  // three.js fixes the winding itself, so either direction gives the same faces.
  return new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
}

function swap(mesh: THREE.Mesh, geometry: THREE.BufferGeometry) {
  // The rotation lays the shape's XY plane onto the floor: (x, y, z) → (x, -z, y).
  geometry.rotateX(Math.PI / 2);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const old = mesh.geometry;
  mesh.geometry = geometry;
  if (old && old !== UNIT_BOX) old.dispose();
}

function slabGeometry(mesh: THREE.Mesh, s: SlabNode) {
  swap(mesh, new THREE.ExtrudeGeometry(shapeOf(s.points), { depth: s.thickness, bevelEnabled: false }));
}

function zoneGeometry(mesh: THREE.Mesh, z: ZoneNode) {
  const g = new THREE.ShapeGeometry(shapeOf(z.points));
  swap(mesh, g);
  mesh.position.y = 0.012;
  mesh.updateMatrix();
}

function paintOutline(mesh: THREE.Mesh, node: ZoneNode | SlabNode, selected: boolean) {
  if (node.type === 'slab') mesh.material = selected ? materials.slabSelected : materials.slab;
  else mesh.material = materials.zone(node.use, selected, node.floor);
}
