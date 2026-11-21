'use client';
/**
 * Measurements in the 3D view: sizes in millimetres on doors and windows,
 * and the length of the selected wall.
 *
 * This works like the ECS systems: it runs in the frame loop, after the
 * systems, and moves DOM labels directly, so React never re-renders for it.
 * Labels show for the selected door, window or wall, or for every opening
 * when Measure is on. A label on a hidden (solo) level, or behind the
 * camera, gets the `hidden` attribute.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { CUT } from '@/ecs/materials';
import { world } from '@/ecs/world';
import { editor } from '@/scene/store';
import type { Id, OpeningNode, SceneDoc, WallNode } from '@/scene/types';
import { shown } from './interact';

export const mm = (m: number) => String(Math.round(m * 1000));

export function openingLabel(o: OpeningNode) {
  return `${mm(o.width)} × ${mm(o.height)}`;
}

function wanted(doc: SceneDoc, selection: Id | null, measure: boolean): Id[] {
  const ids: Id[] = [];
  if (measure) for (const n of Object.values(doc.nodes)) if (n.type === 'opening') ids.push(n.id);
  const sel = selection ? doc.nodes[selection] : undefined;
  if (sel && (sel.type === 'wall' || (sel.type === 'opening' && !measure))) ids.push(sel.id);
  return ids;
}

const v = new THREE.Vector3();

export function Labels() {
  const gl = useThree(s => s.gl);
  const layer = useRef<HTMLDivElement | null>(null);
  const els = useRef(new Map<Id, HTMLDivElement>());

  useEffect(() => {
    // The layer sits over the canvas, in the same box, and takes no pointer events.
    const host = (gl.domElement as HTMLElement).parentElement?.parentElement;
    if (!host) return;
    const div = document.createElement('div');
    div.className = 'labels';
    div.setAttribute('aria-hidden', 'true');
    host.appendChild(div);
    layer.current = div;
    const map = els.current;
    return () => { div.remove(); map.clear(); layer.current = null; };
  }, [gl]);

  useFrame(({ camera, size }) => {
    const div = layer.current;
    if (!div) return;
    const s = editor.getState();
    const ids = wanted(s.doc, s.selection, s.measure);
    const keep = new Set(ids);
    for (const [id, el] of els.current) if (!keep.has(id)) { el.remove(); els.current.delete(id); }
    const cutAt = s.cut ? CUT : Infinity;
    for (const id of ids) {
      const node = s.doc.nodes[id] as OpeningNode | WallNode;
      const object = world.entities.get(id)?.object;
      let el = els.current.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'label';
        el.dataset.id = id;
        div.appendChild(el);
        els.current.set(id, el);
      }
      let text: string;
      if (node.type === 'opening') {
        text = openingLabel(node);
        v.set(0, Math.min(node.sill + node.height, cutAt) + 0.18, 0);
      } else {
        const len = Math.hypot(node.b[0] - node.a[0], node.b[1] - node.a[1]);
        text = mm(len);
        v.set(len / 2, Math.min(node.height, cutAt) + 0.3, 0);
      }
      if (el.textContent !== text) el.textContent = text;
      el.dataset.kind = node.type === 'opening' ? node.kind : 'wall';
      if (!object || !shown(object)) { el.hidden = true; continue; }
      object.localToWorld(v);
      v.project(camera);
      const behind = v.z > 1;
      el.hidden = behind;
      if (!behind) el.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-50%, -100%)`;
    }
    // Priority 0: after the systems (-1). A positive priority would take over rendering from R3F.
  }, 0);

  return null;
}
