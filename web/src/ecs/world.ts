/**
 * The ECS side of the editor.
 *
 * Entities are scene node ids. Their components are the node's data in the
 * document plus the three.js object React mounted for them. Systems run once
 * per frame, in order, and only touch entities in the dirty set:
 *
 *   transformSystem   walls: one matrix per dirty wall on a shared unit box
 *   outlineSystem     slabs and zones: rebuild the dirty outlines' buffers
 *   layoutSystem      buildings and levels: stack, explode or solo, eased
 *   selectionSystem   swaps the material of the old and new selection
 *
 * The dirty set is fed by diffing documents: an edit replaces only the nodes
 * it touches, so a node is dirty exactly when its object identity changed.
 * React mounts and unmounts entities when a parent's `children` change; it
 * does not re-render when a wall moves, because no component reads wall data.
 */
import * as THREE from 'three/webgpu';
import { ancestor } from '@/scene/ops';
import type { BuildingView } from '@/scene/store';
import type { Id, NodeType, SceneDoc, SlabNode, Vec2, WallNode, ZoneNode } from '@/scene/types';
import { materials, UNIT_BOX } from './materials';

export interface Entity { id: Id; kind: NodeType; object: THREE.Object3D }

export interface Stats {
  frames: number;
  /** Updates per kind since the page loaded. */
  updates: Record<'wall' | 'zone' | 'slab' | 'layout' | 'selection', number>;
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
  stats: Stats = { frames: 0, updates: { wall: 0, zone: 0, slab: 0, layout: 0, selection: 0 }, last: { frame: 0, ids: [] } };
  private layoutDirty = true;

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
  }

  markDirty(ids: Iterable<Id>) {
    for (const id of ids) this.dirty.add(id);
    this.layoutDirty = true;
  }

  /** Runs every system once. Returns the ids updated this frame. */
  step(doc: SceneDoc, views: Record<Id, BuildingView>, selection: Id | null, dt: number): Id[] {
    this.stats.frames++;
    const touched: Id[] = [];
    if (this.dirty.size) {
      for (const id of this.dirty) {
        const node = doc.nodes[id];
        const entity = this.entities.get(id);
        if (!node || !entity) continue;
        if (node.type === 'wall') { wallTransform(entity.object as THREE.Mesh, node); this.stats.updates.wall++; touched.push(id); }
        else if (node.type === 'slab') { slabGeometry(entity.object as THREE.Mesh, node); this.stats.updates.slab++; touched.push(id); }
        else if (node.type === 'zone') { zoneGeometry(entity.object as THREE.Mesh, node); this.stats.updates.zone++; touched.push(id); }
        else if (node.type === 'building') { entity.object.position.set(node.origin[0], 0, node.origin[1]); touched.push(id); }
        if (node.type === 'wall' || node.type === 'zone' || node.type === 'slab') paint(entity.object as THREE.Mesh, node.type, node, id === selection);
      }
      this.dirty.clear();
    }
    if (this.layout(doc, views, dt)) { this.stats.updates.layout++; }
    if (this.selected !== selection) {
      for (const id of [this.selected, selection]) {
        const node = id ? doc.nodes[id] : undefined;
        const entity = id ? this.entities.get(id) : undefined;
        if (node && entity && (node.type === 'wall' || node.type === 'zone' || node.type === 'slab')) paint(entity.object as THREE.Mesh, node.type, node, id === selection);
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
    this.stats = { frames: this.stats.frames, updates: { wall: 0, zone: 0, slab: 0, layout: 0, selection: 0 }, last: { frame: this.stats.frames, ids: [] } };
  }
}

export const world = new World();

// ---- per-kind updates -------------------------------------------------------------

/** A wall is the shared unit box, scaled and turned into place: no new geometry. */
function wallTransform(mesh: THREE.Mesh, w: WallNode) {
  const dx = w.b[0] - w.a[0];
  const dz = w.b[1] - w.a[1];
  const len = Math.hypot(dx, dz);
  mesh.position.set((w.a[0] + w.b[0]) / 2, w.height / 2, (w.a[1] + w.b[1]) / 2);
  mesh.rotation.set(0, -Math.atan2(dz, dx), 0);
  // Ends run on by half the thickness so that corners close.
  mesh.scale.set(len + w.thickness, w.height, w.thickness);
  mesh.updateMatrix();
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

function paint(mesh: THREE.Mesh, kind: 'wall' | 'zone' | 'slab', node: WallNode | ZoneNode | SlabNode, selected: boolean) {
  if (kind === 'wall') mesh.material = selected ? materials.wallSelected : materials.wall;
  else if (kind === 'slab') mesh.material = selected ? materials.slabSelected : materials.slab;
  else mesh.material = materials.zone((node as ZoneNode).use, selected);
}
