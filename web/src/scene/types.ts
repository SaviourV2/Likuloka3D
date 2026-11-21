/**
 * The scene document: a flat table of nodes that form a tree.
 *
 *   building → level → wall | zone | slab
 *                       wall → opening (door or window)
 *
 * Every node is immutable. An edit replaces only the nodes it touches, so the
 * previous document stays intact (that is what undo keeps) and the set of
 * changed nodes is exactly the set whose object identity changed.
 *
 * All lengths are metres on a 0.25 m grid. Plan `x` runs left to right and
 * plan `y` top to bottom; in 3D, plan x is world x and plan y is world z.
 */

export type Id = string;
export type Vec2 = readonly [number, number];

export type NodeType = 'building' | 'level' | 'wall' | 'zone' | 'slab' | 'opening';

interface Base<T extends NodeType> {
  readonly id: Id;
  readonly type: T;
  readonly parent: Id | null;
  readonly name: string;
}

export interface BuildingNode extends Base<'building'> {
  readonly parent: null;
  readonly children: readonly Id[];
  /** Plan position of the building's origin. */
  readonly origin: Vec2;
}

export interface LevelNode extends Base<'level'> {
  readonly parent: Id;
  readonly children: readonly Id[];
  /** Height of the finished floor above the building's ground, in metres. */
  readonly elevation: number;
  /** Floor-to-floor height. */
  readonly height: number;
}

export type LayerKind = 'structure' | 'insulation' | 'cavity' | 'finish';
/** One layer of a wall's build-up, listed from the side facing the wall's left (its normal) to the right. */
export interface WallLayer { readonly name: string; readonly thickness: number; readonly kind: LayerKind }

export interface WallNode extends Base<'wall'> {
  readonly parent: Id;
  /** The wall's openings. */
  readonly children: readonly Id[];
  readonly a: Vec2;
  readonly b: Vec2;
  /** The total thickness: the sum of `layers` when the wall has a build-up. */
  readonly thickness: number;
  readonly height: number;
  /** The build-up, or empty for a plain wall of `thickness`. */
  readonly layers: readonly WallLayer[];
  /** The catalogue wall type the build-up came from, or null when it is custom. */
  readonly wallType: string | null;
}

export type RoomType =
  | 'living' | 'kitchen' | 'dining' | 'bedroom' | 'bathroom'
  | 'office' | 'hallway' | 'laundry' | 'storage' | 'studio';

/** A floor finish. These are generic finishes drawn by the shader, not products. */
export type FloorFinish = 'none' | 'oak' | 'walnut' | 'tile-60' | 'tile-60x120' | 'tile-30x60' | 'tile-20' | 'terrazzo' | 'concrete';

export interface ZoneNode extends Base<'zone'> {
  readonly parent: Id;
  readonly points: readonly Vec2[];
  readonly use: RoomType;
  /** The floor finish drawn in the room, or 'none' to show the colour of its use. */
  readonly floor: FloorFinish;
}

export interface SlabNode extends Base<'slab'> {
  readonly parent: Id;
  readonly points: readonly Vec2[];
  readonly thickness: number;
}

export type OpeningKind = 'door' | 'window';
/** A square head, or a rounded (semicircular) arch whose radius is half the width. */
export type OpeningShape = 'square' | 'arched';
/** What the frame, and a door's leaf, are made of. */
export type OpeningFinish = 'timber' | 'steel' | 'aluminium' | 'upvc';
/** Drawn with the door leaf or window sash shut, or swung open. */
export type OpeningState = 'closed' | 'open';

/**
 * A door or window in a wall. Its place is measured along the wall from end
 * `a`. Its width and height are the structural opening, the hole in the wall;
 * the frame is smaller by the project's fitting gap (`frameSize`).
 */
export interface OpeningNode extends Base<'opening'> {
  readonly parent: Id;
  readonly kind: OpeningKind;
  /** Distance from the wall's end `a` to the opening's centre. */
  readonly offset: number;
  readonly width: number;
  readonly height: number;
  /** Height of the bottom of the opening above the floor; 0 for a door. */
  readonly sill: number;
  readonly shape: OpeningShape;
  readonly finish: OpeningFinish;
  readonly state: OpeningState;
  /** The catalogue product it is, or null for a custom size. */
  readonly product: string | null;
}

export type SceneNode = BuildingNode | LevelNode | WallNode | ZoneNode | SlabNode | OpeningNode;
export type NodeOf<T extends NodeType> = Extract<SceneNode, { type: T }>;

export interface ProjectSettings {
  /** The fitting gap between a frame and the structural opening, on each side (and at a door's head). */
  readonly tolerance: number;
}

export interface SceneDoc {
  /** The project's name. */
  readonly name: string;
  readonly settings: ProjectSettings;
  readonly nodes: Readonly<Record<Id, SceneNode>>;
  /** Buildings, in order. */
  readonly roots: readonly Id[];
}

/** How a building shows its levels. Not part of the document, so not undone. */
export type LevelMode = 'stack' | 'explode' | 'solo';

export const GRID = 0.25;
/** Door and window sizes are ordered in millimetres; they are kept to 5 mm. */
export const SIZE_STEP = 0.005;
export const DEFAULT_SETTINGS: ProjectSettings = { tolerance: 0.01 };
/** Openings keep at least this much wall at each end and between each other. */
export const OPENING_MARGIN = 0.1;
export const OPENING_DEFAULTS: Record<OpeningKind, { width: number; height: number; sill: number; finish: OpeningFinish }> = {
  door: { width: 1, height: 2.1, sill: 0, finish: 'timber' },
  window: { width: 1.5, height: 1.2, sill: 0.9, finish: 'aluminium' },
};
export const OPENING_SHAPES: readonly OpeningShape[] = ['square', 'arched'];
export const OPENING_FINISHES: readonly OpeningFinish[] = ['timber', 'steel', 'aluminium', 'upvc'];
export const FINISH_LABELS: Record<OpeningFinish, string> = { timber: 'Timber', steel: 'Steel', aluminium: 'Aluminium', upvc: 'uPVC' };
/** An arched opening keeps at least this much straight side below the arch. */
export const MIN_ARCH_SIDE = 0.3;
/**
 * How each floor finish is drawn: its colour, the colour of its joints and the
 * size of one tile or plank in metres (0 for a finish with no joints).
 */
export const FLOOR_FINISHES: Record<Exclude<FloorFinish, 'none'>, { label: string; base: string; joint: string; size: readonly [number, number] }> = {
  'oak': { label: 'Oak planks', base: '#c49a62', joint: '#8a6a3f', size: [0.15, 1.5] },
  'walnut': { label: 'Walnut planks', base: '#7a5236', joint: '#4a3020', size: [0.15, 1.5] },
  'tile-60': { label: 'Tile 60 × 60, warm grey', base: '#d9d6cf', joint: '#8f8b83', size: [0.6, 0.6] },
  'tile-60x120': { label: 'Marble look 60 × 120', base: '#eceae6', joint: '#a9a6a0', size: [0.6, 1.2] },
  'tile-30x60': { label: 'Tile 30 × 60, white', base: '#eef0ef', joint: '#9ea5a5', size: [0.3, 0.6] },
  'tile-20': { label: 'Tile 20 × 20, blue-grey', base: '#cfdde2', joint: '#7f96a0', size: [0.2, 0.2] },
  'terrazzo': { label: 'Terrazzo', base: '#d8d2c8', joint: '#d8d2c8', size: [0, 0] },
  'concrete': { label: 'Polished concrete', base: '#a8aaab', joint: '#a8aaab', size: [0, 0] },
};
export const FLOOR_KEYS = ['none', ...Object.keys(FLOOR_FINISHES)] as readonly FloorFinish[];
export const UNTITLED = 'Untitled project';
export const MIN_WALL = GRID;
export const ROOM_TYPES: readonly RoomType[] = [
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom',
  'office', 'hallway', 'laundry', 'storage', 'studio',
];

/** The frame that fits a structural opening: smaller by the fitting gap each side, and at a door's head. */
export function frameSize(o: { kind: OpeningKind; width: number; height: number }, tolerance: number) {
  return { width: o.width - 2 * tolerance, height: o.kind === 'door' ? o.height - tolerance : o.height - 2 * tolerance };
}

/** The structural opening a frame needs: the inverse of `frameSize`. */
export function openingFor(kind: OpeningKind, frame: { width: number; height: number }, tolerance: number) {
  return { width: frame.width + 2 * tolerance, height: kind === 'door' ? frame.height + tolerance : frame.height + 2 * tolerance };
}
