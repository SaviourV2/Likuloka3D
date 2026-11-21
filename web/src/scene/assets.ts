/**
 * The asset library: what can be placed on a floor by hand. Each asset makes
 * the same kind of piece the furnishing recipes do (boxes, and model files
 * where the kit has them), so a placed item and an automatic one are drawn the
 * same way. A stair is made for the height of the level it is placed on.
 *
 * The model files are the CC0 kit in `public/models`. An asset without a model
 * there is drawn from its boxes alone.
 */
import { addItem, SceneError, updateZone } from './ops';
import { bedItem, C, carItem, furnishLevel, islandItem, kitchenRun, lighten, plantItem, shelfItem, sofaItem, stoolsItem, sunkenBedItem, tableSet, type Item, type Part } from './furnish';
import type { Id, SceneDoc, Vec2 } from './types';

export type AssetGroup = 'Living' | 'Bedroom' | 'Kitchen and dining' | 'Bathroom and laundry' | 'Decor' | 'Stairs' | 'Outdoor and garage';
export interface Asset { key: string; label: string; group: AssetGroup; make: (o: { height: number; tint: number }) => Item }

/** Risers are near 175 mm and treads are 250 mm, a grid step, so a stair lines up with the walls. */
const RISER = 0.175, TREAD = 0.25;
const steps = (height: number) => Math.max(2, Math.round(height / RISER));
/** A flight of solid steps: `n` of them from step `from`, each `rise` high, going back from `d0` (or forward when `back`). */
function flight(P: Part[], a0: number, a1: number, d0: number, n: number, from: number, rise: number, back = false) {
  for (let i = 0; i < n; i++) {
    const d = back ? d0 - (i + 1) * TREAD : d0 + i * TREAD;
    P.push([a0, a1, d, d + TREAD, 0, (from + i + 1) * rise, i % 2 ? C.wood : lighten(C.wood, 0.12)]);
  }
}
const straightStair = (height: number, width = 1): Item => {
  const n = steps(height), P: Part[] = [];
  flight(P, 0, width, 0, n, 0, height / n);
  return { w: width, dep: n * TREAD, parts: P, label: 'Straight stair' };
};
const uStair = (height: number, width = 1): Item => {
  const n = steps(height), rise = height / n, n1 = Math.ceil((n - 1) / 2), n2 = n - 1 - n1, gap = 0.1, P: Part[] = [];
  flight(P, 0, width, 0, n1, 0, rise);
  P.push([0, 2 * width + gap, n1 * TREAD, n1 * TREAD + width, 0, (n1 + 1) * rise, C.wood]); // the landing is a step too
  flight(P, width + gap, 2 * width + gap, n1 * TREAD, n2, n1 + 1, rise, true);
  return { w: 2 * width + gap, dep: n1 * TREAD + width, parts: P, label: 'U stair' };
};
const lStair = (height: number, width = 1): Item => {
  const n = steps(height), rise = height / n, n1 = Math.ceil((n - 1) / 2), n2 = n - 1 - n1, P: Part[] = [];
  flight(P, 0, width, 0, n1, 0, rise);
  P.push([0, width, n1 * TREAD, n1 * TREAD + width, 0, (n1 + 1) * rise, C.wood]);
  for (let i = 0; i < n2; i++) P.push([width + i * TREAD, width + (i + 1) * TREAD, n1 * TREAD, n1 * TREAD + width, 0, (n1 + 2 + i) * rise, i % 2 ? C.wood : lighten(C.wood, 0.12)]);
  return { w: width + n2 * TREAD, dep: n1 * TREAD + width, parts: P, label: 'L stair' };
};

const one = (label: string, w: number, dep: number, parts: Part[], models?: Item['models'], more: Partial<Item> = {}): Item => ({ w, dep, parts, label, ...(models ? { models } : {}), ...more });

export const ASSETS: Asset[] = [
  { key: 'sofa-3', label: 'Sofa, 3 seats', group: 'Living', make: o => ({ ...sofaItem(2.2, o.tint), label: 'Sofa' }) },
  { key: 'sofa-2', label: 'Sofa, 2 seats', group: 'Living', make: o => ({ ...sofaItem(1.7, o.tint), label: 'Sofa' }) },
  { key: 'armchair', label: 'Armchair', group: 'Living', make: o => one('Armchair', 0.9, 0.9, [[0, 0.9, 0.04, 0.9, 0.08, 0.42, o.tint], [0, 0.9, 0.04, 0.24, 0.42, 0.82, o.tint], [0, 0.14, 0.04, 0.9, 0.42, 0.6, o.tint], [0.76, 0.9, 0.04, 0.9, 0.42, 0.6, o.tint]], [['loungeChair', 0, 0.9, 0.04, 0.9, 0, 0.86]]) },
  { key: 'coffee-table', label: 'Coffee table', group: 'Living', make: () => one('Coffee table', 1.1, 0.6, [[0, 1.1, 0, 0.6, 0.34, 0.39, C.wood], [0.04, 0.1, 0.04, 0.1, 0, 0.34, C.dark], [1.0, 1.06, 0.04, 0.1, 0, 0.34, C.dark], [0.04, 0.1, 0.5, 0.56, 0, 0.34, C.dark], [1.0, 1.06, 0.5, 0.56, 0, 0.34, C.dark]], [['tableCoffee', 0, 1.1, 0, 0.6, 0, 0.42]]) },
  { key: 'tv-rack', label: 'TV rack with TV', group: 'Living', make: () => one('TV rack', 1.6, 0.42, [[0, 1.6, 0, 0.42, 0.06, 0.48, C.wood], [0.2, 1.4, 0.16, 0.2, 0.56, 1.26, C.black]], [['cabinetTelevision', 0, 1.6, 0, 0.42, 0, 0.5], ['televisionModern', 0.25, 1.35, 0.12, 0.32, 0.5, 1.22]]) },
  { key: 'bookcase', label: 'Bookcase', group: 'Living', make: () => ({ ...shelfItem(1.0), label: 'Bookcase' }) },
  { key: 'desk', label: 'Desk with chair', group: 'Living', make: () => one('Desk', 1.4, 1.25, [[0, 1.4, 0, 0.65, 0.7, 0.74, C.wood], [0, 0.04, 0.02, 0.63, 0, 0.7, C.dark], [1.36, 1.4, 0.02, 0.63, 0, 0.7, C.dark], [0.48, 0.92, 0.74, 1.18, 0.44, 0.5, C.black], [0.48, 0.92, 1.14, 1.18, 0.5, 0.95, C.black]], [['desk', 0, 1.4, 0, 0.65, 0, 0.75], ['computerScreen', 0.45, 0.95, 0.1, 0.26, 0.75, 1.2], ['chairDesk', 0.42, 0.98, 0.7, 1.22, 0, 1.05, 'flip']]) },

  { key: 'bed-double', label: 'Double bed with side tables', group: 'Bedroom', make: o => ({ ...bedItem(1.6, true, o.tint), label: 'Double bed' }) },
  { key: 'bed-king', label: 'King bed', group: 'Bedroom', make: o => ({ ...bedItem(1.8, false, o.tint), label: 'King bed' }) },
  { key: 'bed-single', label: 'Single bed', group: 'Bedroom', make: o => ({ ...bedItem(0.95, false, o.tint), label: 'Single bed' }) },
  { key: 'bed-sunken', label: 'Sunken bed', group: 'Bedroom', make: o => ({ ...sunkenBedItem(1.6, o.tint), label: 'Sunken bed' }) },
  { key: 'wardrobe', label: 'Wardrobe', group: 'Bedroom', make: () => one('Wardrobe', 1.8, 0.6, [[0, 1.8, 0, 0.6, 0, 2.1, C.ward], [0.89, 0.91, 0.6, 0.605, 0.05, 2.05, C.dark]], [['bookcaseClosedDoors', 0, 0.9, 0, 0.6, 0, 2.1], ['bookcaseClosedDoors', 0.9, 1.8, 0, 0.6, 0, 2.1]], { tall: true }) },
  { key: 'side-table', label: 'Bedside table with lamp', group: 'Bedroom', make: () => one('Bedside table', 0.44, 0.4, [[0, 0.44, 0, 0.4, 0, 0.46, C.wood], [0.13, 0.31, 0.11, 0.29, 0.46, 0.76, 0xf1e3c4, 'cyl']], [['cabinetBed', 0, 0.44, 0, 0.4, 0, 0.48], ['lampRoundTable', 0.11, 0.33, 0.09, 0.31, 0.48, 0.9]]) },

  { key: 'kitchen-run', label: 'Kitchen run, 3 m', group: 'Kitchen and dining', make: () => ({ ...kitchenRun(3, true), label: 'Kitchen run' }) },
  { key: 'island', label: 'Kitchen island', group: 'Kitchen and dining', make: () => ({ ...islandItem(1.8), label: 'Kitchen island' }) },
  { key: 'stools', label: 'Bar stools', group: 'Kitchen and dining', make: () => ({ ...stoolsItem(1.8), label: 'Bar stools' }) },
  { key: 'dining-6', label: 'Dining table, 4 chairs', group: 'Kitchen and dining', make: () => ({ ...tableSet(1.6, 0.9), label: 'Dining table' }) },
  { key: 'dining-2', label: 'Small table, 2 chairs', group: 'Kitchen and dining', make: () => ({ ...tableSet(0.9, 0.8), label: 'Small table' }) },
  { key: 'sideboard', label: 'Sideboard', group: 'Kitchen and dining', make: () => one('Sideboard', 1.4, 0.42, [[0, 1.4, 0, 0.42, 0.08, 0.82, C.wood], [0, 1.4, 0, 0.44, 0.82, 0.85, C.dark]], [['cabinetTelevision', 0, 1.4, 0, 0.42, 0, 0.85]]) },

  { key: 'toilet', label: 'Toilet', group: 'Bathroom and laundry', make: () => one('Toilet', 0.42, 0.68, [[0, 0.42, 0, 0.18, 0.36, 0.8, C.white], [0.03, 0.39, 0.18, 0.66, 0, 0.4, C.white]], [['toilet', 0, 0.42, 0, 0.68, 0, 0.82]]) },
  { key: 'basin', label: 'Basin with mirror', group: 'Bathroom and laundry', make: () => one('Basin', 0.8, 0.48, [[0, 0.8, 0.02, 0.46, 0.3, 0.8, C.wood], [0, 0.8, 0, 0.48, 0.8, 0.84, C.white], [0.05, 0.75, 0, 0.025, 1.1, 1.75, 0xbcd2de]], [['bathroomCabinetDrawer', 0, 0.8, 0, 0.48, 0, 0.9], ['bathroomMirror', 0.1, 0.7, 0, 0.08, 1.1, 1.75]]) },
  { key: 'shower', label: 'Shower', group: 'Bathroom and laundry', make: () => one('Shower', 0.9, 0.9, [[0, 0.9, 0, 0.9, 0, 0.06, C.white], [0.87, 0.9, 0, 0.9, 0.06, 2.0, 0, 'glass'], [0, 0.9, 0.87, 0.9, 0.06, 2.0, 0, 'glass']], [['shower', 0, 0.9, 0, 0.9, 0, 2.0]]) },
  { key: 'bathtub', label: 'Bathtub', group: 'Bathroom and laundry', make: () => one('Bathtub', 1.7, 0.75, [[0, 1.7, 0, 0.75, 0, 0.56, C.white], [0.07, 1.63, 0.07, 0.68, 0.56, 0.566, 0xcfe3ea]], [['bathtub', 0, 1.7, 0, 0.75, 0, 0.6]]) },
  { key: 'washer-dryer', label: 'Washer and dryer', group: 'Bathroom and laundry', make: () => one('Washer and dryer', 1.26, 0.64, [[0, 0.6, 0.02, 0.62, 0, 0.85, C.white], [0.64, 1.24, 0.02, 0.62, 0, 0.85, C.white], [0, 1.26, 0, 0.64, 0.85, 0.89, C.stone]], [['washer', 0, 0.6, 0.02, 0.62, 0, 0.86], ['dryer', 0.64, 1.24, 0.02, 0.62, 0, 0.86]]) },

  { key: 'rug', label: 'Rug, 2.4 × 1.6 m', group: 'Decor', make: o => one('Rug', 2.4, 1.6, [[0, 2.4, 0, 1.6, 0.004, 0.018, C.rug], [0.12, 2.28, 0.12, 1.48, 0.018, 0.022, lighten(o.tint, 0.55)]], [['rugRectangle', 0, 2.4, 0, 1.6, 0.004, 0.026]], { soft: true }) },
  { key: 'rug-small', label: 'Rug, 1.4 × 0.9 m', group: 'Decor', make: o => one('Rug', 1.4, 0.9, [[0, 1.4, 0, 0.9, 0.004, 0.018, C.rug], [0.1, 1.3, 0.1, 0.8, 0.018, 0.022, lighten(o.tint, 0.55)]], [['rugRectangle', 0, 1.4, 0, 0.9, 0.004, 0.026]], { soft: true }) },
  { key: 'small-table', label: 'Small table', group: 'Decor', make: () => one('Small table', 0.5, 0.5, [[0, 0.5, 0, 0.5, 0.5, 0.54, C.wood], [0.21, 0.29, 0.21, 0.29, 0, 0.5, C.dark, 'cyl']]) },
  { key: 'small-chair', label: 'Small chair', group: 'Decor', make: () => one('Small chair', 0.44, 0.44, [[0.01, 0.43, 0.01, 0.43, 0.41, 0.45, C.dark], [0.01, 0.43, 0.01, 0.05, 0.45, 0.88, C.dark], [0.02, 0.055, 0.02, 0.055, 0, 0.41, C.dark], [0.385, 0.42, 0.02, 0.055, 0, 0.41, C.dark], [0.02, 0.055, 0.385, 0.42, 0, 0.41, C.dark], [0.385, 0.42, 0.385, 0.42, 0, 0.41, C.dark]], [['chairCushion', 0, 0.44, 0, 0.44, 0, 0.92]]) },
  { key: 'console', label: 'Console table', group: 'Decor', make: () => one('Console table', 1.0, 0.3, [[0, 1.0, 0, 0.3, 0.74, 0.78, C.wood], [0.02, 0.06, 0.02, 0.28, 0, 0.74, C.dark], [0.94, 0.98, 0.02, 0.28, 0, 0.74, C.dark]], [['sideTable', 0, 1.0, 0, 0.3, 0, 0.78]]) },
  { key: 'shoe-rack', label: 'Shoe rack', group: 'Decor', make: () => one('Shoe rack', 0.9, 0.32, [[0, 0.03, 0, 0.32, 0, 0.95, C.wood], [0.87, 0.9, 0, 0.32, 0, 0.95, C.wood], [0.03, 0.87, 0, 0.32, 0.05, 0.08, C.wood], [0.03, 0.87, 0, 0.32, 0.34, 0.37, C.wood], [0.03, 0.87, 0, 0.32, 0.63, 0.66, C.wood], [0, 0.9, 0, 0.32, 0.92, 0.95, C.wood],
    [0.08, 0.3, 0.04, 0.28, 0.08, 0.18, C.dark], [0.36, 0.58, 0.04, 0.28, 0.08, 0.18, 0x8a5a3c], [0.1, 0.32, 0.04, 0.28, 0.37, 0.47, 0xd9d2c4], [0.5, 0.72, 0.04, 0.28, 0.37, 0.47, C.black], [0.2, 0.42, 0.04, 0.28, 0.66, 0.76, 0x6f8ba3]]) },
  { key: 'floor-lamp', label: 'Floor lamp', group: 'Decor', make: () => one('Floor lamp', 0.4, 0.4, [[0.17, 0.23, 0.17, 0.23, 0, 1.45, C.dark, 'cyl'], [0.07, 0.33, 0.07, 0.33, 1.45, 1.72, 0xf1e3c4, 'cyl']], [['lampRoundFloor', 0.08, 0.32, 0.08, 0.32, 0, 1.72]]) },
  { key: 'plant', label: 'Potted plant', group: 'Decor', make: () => ({ ...plantItem(), label: 'Potted plant' }) },

  { key: 'stair-straight', label: 'Straight stair', group: 'Stairs', make: o => straightStair(o.height) },
  { key: 'stair-l', label: 'L stair with landing', group: 'Stairs', make: o => lStair(o.height) },
  { key: 'stair-u', label: 'U stair with landing', group: 'Stairs', make: o => uStair(o.height) },

  { key: 'car', label: 'Car', group: 'Outdoor and garage', make: () => carItem() },
  { key: 'sunbed', label: 'Sun lounger', group: 'Outdoor and garage', make: o => one('Sun lounger', 0.7, 2.0, [[0, 0.7, 0, 2.0, 0.22, 0.3, C.wood], [0.03, 0.67, 0.03, 1.97, 0.3, 0.36, o.tint], [0.03, 0.67, 0.03, 0.6, 0.36, 0.52, o.tint], [0.03, 0.1, 0.1, 0.17, 0, 0.22, C.dark], [0.6, 0.67, 0.1, 0.17, 0, 0.22, C.dark], [0.03, 0.1, 1.8, 1.87, 0, 0.22, C.dark], [0.6, 0.67, 1.8, 1.87, 0, 0.22, C.dark]]) },
  { key: 'outdoor-table', label: 'Outdoor table, 4 chairs', group: 'Outdoor and garage', make: () => ({ ...tableSet(1.2, 0.8), label: 'Outdoor table' }) },
];
export const ASSET_GROUPS: AssetGroup[] = ['Living', 'Bedroom', 'Kitchen and dining', 'Bathroom and laundry', 'Decor', 'Stairs', 'Outdoor and garage'];
const TINTS = [0x6f8ba3, 0xb9805f, 0x86a184, 0xa48db5];

/** Places an asset on a level, at `at` or in the middle of a room or of the level. Returns the new document and the item's id. */
export function placeAsset(doc: SceneDoc, levelId: Id, key: string, where: { at?: Vec2; zone?: Id } = {}): [SceneDoc, Id] {
  const asset = ASSETS.find(a => a.key === key), level = doc.nodes[levelId];
  if (!asset) throw new SceneError(`There is no asset ${key}`);
  if (level?.type !== 'level') throw new SceneError('Choose a level to place it on');
  const items = level.children.filter(c => doc.nodes[c]?.type === 'item').length;
  const item = asset.make({ height: level.height, tint: TINTS[items % TINTS.length] });
  const zone = where.zone ? doc.nodes[where.zone] : undefined;
  let pts: readonly Vec2[] = zone?.type === 'zone' ? zone.points : level.children.flatMap(c => { const n = doc.nodes[c]; return n?.type === 'slab' ? [...n.points] : []; });
  if (!pts.length) pts = [[0, 0], [4, 4]];
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const at: Vec2 = where.at ?? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  return addItem(doc, levelId, { asset: key, name: item.label ?? asset.label, at, size: [item.w, item.dep], parts: item.parts, models: item.models ?? null, tint: TINTS[items % TINTS.length] });
}

/**
 * Turns a room's automatic furniture into items of its own, each of which can
 * then be moved, turned or deleted, and stops furnishing the room
 * automatically. Returns the new document and how many pieces it made.
 */
export function ownFurniture(doc: SceneDoc, zoneId: Id): [SceneDoc, number] {
  const z = doc.nodes[zoneId];
  if (z?.type !== 'zone') throw new SceneError('Choose a room');
  if (!z.auto) return [doc, 0];
  const pieces = furnishLevel(doc, z.parent).filter(p => p.zone === zoneId);
  let next = updateZone(doc, zoneId, { auto: false });
  for (const p of pieces) [next] = addItem(next, z.parent, { asset: p.tag ?? 'furniture', name: p.local.label, at: p.local.at, turn: p.local.turn, size: p.local.size, parts: p.local.parts, models: p.local.models, tint: p.tint });
  return [next, pieces.length];
}
