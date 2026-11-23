/**
 * The asset library: what can be placed on a floor by hand. Each asset makes
 * the same kind of piece the furnishing recipes do (boxes, and model files
 * where the kit has them), so a placed item and an automatic one are drawn the
 * same way. A stair is made for the height of the level it is placed on.
 *
 * The model files are the CC0 kit in `public/models`. An asset without a model
 * there is drawn from its boxes alone.
 */
import { addItem, addOpeningAt, addWall, addZone, SceneError, snap, updateZone } from './ops';
import { bedItem, C, carItem, furnishLevel, islandItem, kitchenRun, lighten, plantItem, shelfItem, sofaItem, stoolsItem, sunkenBedItem, tableSet, type Item, type Part } from './furnish';
import { wallAt } from './furnish';
import type { Id, RoomType, SceneDoc, Vec2, WallNode } from './types';

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
  { key: 'cupboard', label: 'Cupboard', group: 'Bedroom', make: () => one('Cupboard', 0.9, 0.5, [[0, 0.9, 0, 0.5, 0, 1.1, C.ward], [0.44, 0.46, 0.5, 0.505, 0.05, 1.05, C.dark], [0, 0.9, 0, 0.52, 1.1, 1.13, C.wood]]) },
  { key: 'side-table', label: 'Bedside table with lamp', group: 'Bedroom', make: () => one('Bedside table', 0.44, 0.4, [[0, 0.44, 0, 0.4, 0, 0.46, C.wood], [0.13, 0.31, 0.11, 0.29, 0.46, 0.76, 0xf1e3c4, 'cyl']], [['cabinetBed', 0, 0.44, 0, 0.4, 0, 0.48], ['lampRoundTable', 0.11, 0.33, 0.09, 0.31, 0.48, 0.9]]) },

  { key: 'stove', label: 'Stove', group: 'Kitchen and dining', make: () => one('Stove', 0.6, 0.63, [[0, 0.6, 0.02, 0.6, 0, 0.86, C.cab], [0, 0.6, 0, 0.63, 0.86, 0.9, C.stone], [0.04, 0.56, 0.08, 0.56, 0.9, 0.908, C.black]], [['kitchenStove', 0, 0.6, 0, 0.63, 0, 0.92]]) },
  { key: 'fridge', label: 'Fridge', group: 'Kitchen and dining', make: () => one('Fridge', 0.66, 0.68, [[0, 0.66, 0.02, 0.68, 0, 1.9, C.steel]], [['kitchenFridge', 0, 0.66, 0.02, 0.68, 0, 1.9]], { tall: true }) },
  { key: 'kitchen-sink', label: 'Kitchen sink', group: 'Kitchen and dining', make: () => one('Kitchen sink', 0.8, 0.63, [[0, 0.8, 0.02, 0.6, 0, 0.86, C.cab], [0, 0.8, 0, 0.63, 0.86, 0.9, C.stone], [0.15, 0.65, 0.12, 0.5, 0.9, 0.906, 0x99a3ac]], [['kitchenSink', 0, 0.8, 0, 0.63, 0, 1.0]]) },
  { key: 'kitchen-cabinet', label: 'Kitchen cabinet', group: 'Kitchen and dining', make: () => one('Kitchen cabinet', 0.6, 0.63, [[0, 0.6, 0.02, 0.6, 0, 0.86, C.cab], [0, 0.6, 0, 0.63, 0.86, 0.9, C.stone]], [['kitchenCabinetDrawer', 0, 0.6, 0, 0.63, 0, 0.92]]) },
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

  { key: 'parking', label: 'Parking bay with car', group: 'Outdoor and garage', make: () => { const car = carItem(); return one('Parking bay', 2.5, 5, [[0, 0.08, 0, 5, 0.004, 0.012, 0xf4f1e6], [2.42, 2.5, 0, 5, 0.004, 0.012, 0xf4f1e6], [0, 2.5, 0, 0.08, 0.004, 0.012, 0xf4f1e6], ...car.parts.map(p => [p[0] + 0.35, p[1] + 0.35, p[2] + 0.3, p[3] + 0.3, p[4], p[5], p[6]] as Part)]); } },
  { key: 'parking-empty', label: 'Parking bay, empty', group: 'Outdoor and garage', make: () => one('Parking bay', 2.5, 5, [[0, 0.08, 0, 5, 0.004, 0.012, 0xf4f1e6], [2.42, 2.5, 0, 5, 0.004, 0.012, 0xf4f1e6], [0, 2.5, 0, 0.08, 0.004, 0.012, 0xf4f1e6]], undefined, { soft: true }) },
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

/** Rooms to drop onto a level: a use and a size on the 0.25 m grid. */
export interface RoomPreset { key: string; label: string; use: RoomType; size: readonly [number, number] }
export const ROOM_PRESETS: RoomPreset[] = [
  { key: 'room-bedroom', label: 'Bedroom 3.5 × 4', use: 'bedroom', size: [3.5, 4] },
  { key: 'room-master', label: 'Master bedroom 4.5 × 5', use: 'bedroom', size: [4.5, 5] },
  { key: 'room-bathroom', label: 'Bathroom 2 × 2.5', use: 'bathroom', size: [2, 2.5] },
  { key: 'room-kitchen', label: 'Kitchen 3.5 × 4', use: 'kitchen', size: [3.5, 4] },
  { key: 'room-living', label: 'Living room 5 × 4.5', use: 'living', size: [5, 4.5] },
  { key: 'room-dining', label: 'Dining room 4 × 3.5', use: 'dining', size: [4, 3.5] },
  { key: 'room-office', label: 'Office 3 × 3', use: 'office', size: [3, 3] },
  { key: 'room-laundry', label: 'Laundry 2 × 2', use: 'laundry', size: [2, 2] },
  { key: 'room-storage', label: 'Storage 2 × 1.5', use: 'storage', size: [2, 1.5] },
  { key: 'room-garage', label: 'Garage 3.5 × 6', use: 'garage', size: [3.5, 6] },
  { key: 'room-pool', label: 'Pool 8 × 4', use: 'pool', size: [8, 4] },
];

/**
 * Drops a room onto a level, centred on `at` and on the grid: a zone, a wall on
 * each side that does not already have one, and a door in the first new wall.
 * A pool gets no walls. The level's slab is left as it is.
 */
export function placeRoom(doc: SceneDoc, levelId: Id, key: string, at: Vec2): [SceneDoc, Id] {
  const preset = ROOM_PRESETS.find(r => r.key === key), level = doc.nodes[levelId];
  if (!preset) throw new SceneError(`There is no room ${key}`);
  if (level?.type !== 'level') throw new SceneError('Choose a level to place it on');
  const [w, d] = preset.size, x = snap(at[0] - w / 2), y = snap(at[1] - d / 2);
  const P: Vec2[] = [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
  let [next, zone] = addZone(doc, levelId, { name: preset.label.replace(/ [\d.]+ × [\d.]+$/, ''), use: preset.use, points: P });
  if (preset.use === 'pool') return [next, zone];
  const walls = level.children.map(c => doc.nodes[c]).filter((n): n is WallNode => n?.type === 'wall');
  let door = false;
  P.forEach((a, i) => {
    const b = P[(i + 1) % 4];
    if (wallAt([a[0], a[1]], [b[0], b[1]], walls)) return; // a wall is there already: the room shares it
    let wall: Id;
    [next, wall] = addWall(next, levelId, { a, b, thickness: 0.15, name: 'Wall' });
    if (!door) {
      try { [next] = addOpeningAt(next, wall, 'door', [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], preset.use === 'garage' ? { width: 2.5, height: 2.1 } : {}); door = true; }
      catch (e) { if (!(e instanceof SceneError)) throw e; }
    }
  });
  return [next, zone];
}

/** A copy of an item, half a metre along and across from it. */
export function duplicateItem(doc: SceneDoc, id: Id): [SceneDoc, Id] {
  const it = doc.nodes[id];
  if (it?.type !== 'item') throw new SceneError('Choose an item to copy');
  return addItem(doc, it.parent, { asset: it.asset, name: it.name, at: [it.at[0] + 0.5, it.at[1] + 0.5], turn: it.turn, size: it.size, parts: it.parts, models: it.models, tint: it.tint });
}

/** A top view of an asset, as SVG: its boxes from above, lowest first, to show in the library. */
export function assetIcon(key: string): string {
  const a = ASSETS.find(k => k.key === key);
  if (!a) return '';
  const it = a.make({ height: 3, tint: 0x6f8ba3 }), s = 40 / Math.max(it.w, it.dep), ox = (44 - it.w * s) / 2, oy = (44 - it.dep * s) / 2;
  const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
  const rects = [...it.parts].sort((p, q) => p[5] - q[5]).map(p => p[7] === 'cyl' || p[7] === 'ball'
    ? `<ellipse cx="${(ox + (p[0] + p[1]) / 2 * s).toFixed(1)}" cy="${(oy + (p[2] + p[3]) / 2 * s).toFixed(1)}" rx="${((p[1] - p[0]) / 2 * s).toFixed(1)}" ry="${((p[3] - p[2]) / 2 * s).toFixed(1)}" fill="${hex(p[7] === 'ball' ? 0x5d8f5c : p[6])}"/>`
    : `<rect x="${(ox + p[0] * s).toFixed(1)}" y="${(oy + p[2] * s).toFixed(1)}" width="${Math.max(0.6, (p[1] - p[0]) * s).toFixed(1)}" height="${Math.max(0.6, (p[3] - p[2]) * s).toFixed(1)}" fill="${p[7] === 'glass' ? '#bfe4f2' : hex(p[6])}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44">${rects}</svg>`;
}
