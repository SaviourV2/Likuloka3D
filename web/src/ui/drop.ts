/** Placing things from the asset library, by a press or by a drop on the view. */
import { placeAsset, placeRoom, ROOM_PRESETS } from '@/scene/assets';
import * as store from '@/scene/store';
import type { Vec2 } from '@/scene/types';
import { rig } from '@/render/interact';

/** What a drag from the asset library carries: the key of an asset or of a room. */
export const DROP_TYPE = 'application/x-likuloka-asset';

/** Puts an asset or a room on a level at a plan point, selects it, and returns whether it was placed. */
export function dropAsset(level: string, key: string, at?: Vec2, zone?: string): boolean {
  let made: string | null = null;
  const room = ROOM_PRESETS.some(r => r.key === key);
  const ok = store.commit(d => {
    const [next, id] = room ? placeRoom(d, level, key, at ?? [0, 0]) : placeAsset(d, level, key, at ? { at } : zone ? { zone } : {});
    made = id; return next;
  }, room ? 'Place room' : 'Place item');
  if (ok && made) { store.setTool('select'); store.select(made); }
  rig.invalidate();
  return ok;
}
