/**
 * What a client may change. Designers change anything; a client chooses
 * from what the designer has drawn:
 *
 * - a door or window's product, finish, head shape, open or closed, and name;
 *   its type or size only by choosing a catalogue product, so every size a
 *   client picks is one that can be made;
 * - a room's name, use and floor finish;
 * - the project's name.
 *
 * Walls, levels, slabs, buildings, the plot, where openings sit and the
 * project's settings stay as the designer drew them. This is checked on the edit
 * itself, by comparing the documents before and after, so it holds for
 * buttons, keys, drags and scripts alike.
 *
 * It compares values, not object identity, because the server runs it too
 * (`functions/src/index.ts`) on two scenes freshly read from text, where no
 * node shares identity with the other scene.
 */
import { diff, sameData } from './ops';
import type { OpeningNode, SceneDoc, SceneNode, ZoneNode } from './types';

export type Role = { kind: 'designer' } | { kind: 'client'; fixed: boolean };

export const CLIENT_REFUSAL = 'In the client view you can choose doors, windows, finishes and room uses. Ask your designer for other changes.';

const OPENING_FREE: (keyof OpeningNode)[] = ['product', 'finish', 'state', 'shape', 'name'];
const OPENING_BY_PRODUCT: (keyof OpeningNode)[] = ['kind', 'width', 'height', 'sill'];
const ZONE_FREE: (keyof ZoneNode)[] = ['name', 'use', 'floor'];

function changedKeys(p: SceneNode, n: SceneNode): string[] {
  const keys = new Set([...Object.keys(p), ...Object.keys(n)]);
  return [...keys].filter(k => !sameData((p as unknown as Record<string, unknown>)[k], (n as unknown as Record<string, unknown>)[k]));
}

/** Null if a client may make this change, otherwise why not. */
export function clientRefusal(prev: SceneDoc, next: SceneDoc): string | null {
  if (prev === next) return null;
  if (!sameData(prev.settings, next.settings) || !sameData(prev.roots, next.roots) || !sameData(prev.plot, next.plot)) return CLIENT_REFUSAL;
  for (const id of diff(prev, next)) {
    const p = prev.nodes[id];
    const n = next.nodes[id];
    if (!p || !n || p.type !== n.type) return CLIENT_REFUSAL;
    const keys = changedKeys(p, n);
    if (!keys.length) continue;
    if (n.type === 'opening') {
      const sized = keys.filter(k => OPENING_BY_PRODUCT.includes(k as keyof OpeningNode));
      if (keys.some(k => !OPENING_FREE.includes(k as keyof OpeningNode) && !sized.includes(k))) return CLIENT_REFUSAL;
      if (sized.length && !n.product) return 'In the client view, sizes come from the catalogue: choose a product.';
    } else if (n.type === 'zone') {
      if (keys.some(k => !ZONE_FREE.includes(k as keyof ZoneNode))) return CLIENT_REFUSAL;
    } else return CLIENT_REFUSAL;
  }
  return null;
}
