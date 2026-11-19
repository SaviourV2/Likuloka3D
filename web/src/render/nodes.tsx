'use client';
/**
 * React mounts one three.js object per scene node and registers it with the
 * ECS world. A component subscribes only to its node's `children` list, so
 * React re-renders when nodes are added or removed and never when a node's
 * data changes: the world's systems update those objects directly.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { world } from '@/ecs/world';
import { CUT, materials, UNIT_BOX } from '@/ecs/materials';
import { editor, select, useEditor } from '@/scene/store';
import type { Id, NodeType, SceneNode, Vec2 } from '@/scene/types';
import { edits, rig, shown, startDrag } from './interact';

const EMPTY: readonly Id[] = [];

function useEntity<T extends THREE.Object3D>(id: Id, kind: NodeType) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const o = ref.current!;
    world.register(id, kind, o);
    rig.invalidate();
    return () => { world.unregister(id, o); rig.invalidate(); };
  }, [id, kind]);
  return ref;
}

const children = (id: Id) => (s: { doc: { nodes: Record<Id, SceneNode> } }) => {
  const n = s.doc.nodes[id];
  return n && 'children' in n ? n.children : EMPTY;
};

function cursor(c: string) { if (rig.dom) rig.dom.style.cursor = c; }

/** Selects on a click that did not travel; a drag on content still orbits. */
function clickSelect(id: Id) {
  return (e: ThreeEvent<MouseEvent>) => {
    if (!shown(e.object) || e.delta > 4 || editor.getState().tool !== 'select') return;
    e.stopPropagation();
    select(id);
    rig.invalidate();
  };
}

export function SceneRoot() {
  const roots = useEditor(s => s.doc.roots);
  return <>{roots.map(id => <Building key={id} id={id} />)}</>;
}

function Building({ id }: { id: Id }) {
  const ref = useEntity<THREE.Group>(id, 'building');
  const levels = useEditor(children(id));
  return <group ref={ref}>{levels.map(l => <Level key={l} id={l} />)}</group>;
}

function Level({ id }: { id: Id }) {
  const ref = useEntity<THREE.Group>(id, 'level');
  const kids = useEditor(children(id));
  const types = useEditor(s => kids.map(k => s.doc.nodes[k]?.type).join());
  const list = types.split(',');
  return (
    <group ref={ref}>
      {kids.map((k, i) => list[i] === 'wall' ? <Wall key={k} id={k} />
        : list[i] === 'zone' ? <Zone key={k} id={k} />
        : list[i] === 'slab' ? <Slab key={k} id={k} /> : null)}
      <Handles level={id} />
      <WallPreview level={id} />
    </group>
  );
}

const inverse = new THREE.Matrix4();
const localRay = new THREE.Ray();
const box = new THREE.Box3();
const at = new THREE.Vector3();

/**
 * Picks a wall as it is drawn: the shader cuts walls at the section height,
 * so the ray is tested against the box up to the cut, not the full wall.
 */
function wallRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, out: THREE.Intersection[]) {
  const cut = editor.getState().cut ? CUT : Infinity;
  const top = Math.min(0.5, cut / this.scale.y - 0.5);
  inverse.copy(this.matrixWorld).invert();
  localRay.copy(raycaster.ray).applyMatrix4(inverse);
  box.min.set(-0.5, -0.5, -0.5);
  box.max.set(0.5, top, 0.5);
  if (!localRay.intersectBox(box, at)) return;
  const point = at.clone().applyMatrix4(this.matrixWorld);
  const distance = raycaster.ray.origin.distanceTo(point);
  if (distance < raycaster.near || distance > raycaster.far) return;
  out.push({ distance, point, object: this });
}

function Wall({ id }: { id: Id }) {
  const ref = useEntity<THREE.Mesh>(id, 'wall');
  return (
    <mesh
      ref={ref}
      raycast={wallRaycast}
      geometry={UNIT_BOX}
      material={materials.wall}
      castShadow
      receiveShadow
      onPointerDown={e => startDrag(e, id, 'wall', 'Move wall', edits.wall(id))}
      // A click on a wall stops at the wall, so it never selects what is behind it.
      onClick={clickSelect(id)}
      onPointerOver={e => { if (shown(e.object) && editor.getState().tool === 'select') { e.stopPropagation(); cursor('grab'); } }}
      onPointerOut={() => cursor('')}
    />
  );
}

function Slab({ id }: { id: Id }) {
  const ref = useEntity<THREE.Mesh>(id, 'slab');
  const geometry = useMemo(() => new THREE.BufferGeometry(), []);
  return <mesh ref={ref} geometry={geometry} material={materials.slab} receiveShadow onClick={clickSelect(id)} />;
}

function Zone({ id }: { id: Id }) {
  const ref = useEntity<THREE.Mesh>(id, 'zone');
  const geometry = useMemo(() => new THREE.BufferGeometry(), []);
  return (
    <mesh
      ref={ref}
      geometry={geometry}
      renderOrder={2}
      onClick={clickSelect(id)}
      // A selected zone moves with a drag; an unselected one lets the drag orbit.
      onPointerDown={e => { if (editor.getState().selection === id) startDrag(e, id, 'zone', 'Move zone', edits.translate(id)); }}
    />
  );
}

// ---- handles ----------------------------------------------------------------------

const BALL = new THREE.SphereGeometry(0.16, 20, 12);
const SMALL = new THREE.SphereGeometry(0.1, 16, 10);

function Handle({ at, lift, small, onDown }: { at: Vec2; lift: number; small?: boolean; onDown: (e: ThreeEvent<PointerEvent>) => void }) {
  return (
    <mesh
      geometry={small ? SMALL : BALL}
      material={small ? materials.insert : materials.handleRing}
      position={[at[0], lift, at[1]]}
      renderOrder={10}
      userData={{ handle: true }}
      onPointerDown={onDown}
      onPointerOver={e => { if (shown(e.object)) { e.stopPropagation(); cursor('move'); } }}
      onPointerOut={() => cursor('')}
    />
  );
}

/** Handles for the selected node, if it is on this level. Re-renders only when that node changes. */
function Handles({ level }: { level: Id }) {
  const node = useEditor(s => {
    const n = s.selection ? s.doc.nodes[s.selection] : undefined;
    return n && n.parent === level ? n : null;
  });
  const tool = useEditor(s => s.tool);
  const cut = useEditor(s => s.cut);
  if (!node || tool !== 'select') return null;
  if (node.type === 'wall') {
    const top = cut ? Math.min(node.height, CUT) : node.height;
    return (
      <>
        {(['a', 'b'] as const).map(end => (
          <Handle key={end} at={node[end]} lift={top + 0.2}
            onDown={e => startDrag(e, node.id, 'wall-end', 'Move wall end', edits.wallEnd(node.id, end))} />
        ))}
      </>
    );
  }
  if (node.type !== 'zone' && node.type !== 'slab') return null;
  const label = node.type === 'slab' ? 'Reshape slab' : 'Reshape zone';
  const lift = node.type === 'slab' ? 0.06 : 0.08;
  return (
    <>
      {node.points.map((p, i) => (
        <Handle key={`p${i}`} at={p} lift={lift} onDown={e => startDrag(e, node.id, 'point', label, edits.point(node.id, i))} />
      ))}
      {node.points.map((p, i) => {
        const q = node.points[(i + 1) % node.points.length];
        return <Handle key={`m${i}`} small at={[(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]} lift={lift}
          onDown={e => startDrag(e, node.id, 'insert', label, edits.insert(node.id, i))} />;
      })}
    </>
  );
}

/** The wall being drawn, from the last point to the pointer. */
function WallPreview({ level }: { level: Id }) {
  const i = useEditor(s => s.interaction);
  const height = useEditor(s => { const l = s.doc.nodes[level]; return l?.type === 'level' ? l.height : 3; });
  if (i.kind !== 'drawing-wall' || i.level !== level || !i.to) return null;
  const dot = <mesh geometry={SMALL} material={materials.preview} position={[i.to[0], 0.05, i.to[1]]} renderOrder={10} />;
  if (!i.from) return dot;
  const dx = i.to[0] - i.from[0], dz = i.to[1] - i.from[1];
  const len = Math.hypot(dx, dz);
  return (
    <>
      {dot}
      {len > 0 && (
        <mesh geometry={UNIT_BOX} material={materials.preview}
          position={[(i.from[0] + i.to[0]) / 2, height / 2, (i.from[1] + i.to[1]) / 2]}
          rotation={[0, -Math.atan2(dz, dx), 0]}
          scale={[len + 0.2, height, 0.2]} />
      )}
    </>
  );
}
