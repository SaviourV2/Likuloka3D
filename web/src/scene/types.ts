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

export interface WallNode extends Base<'wall'> {
  readonly parent: Id;
  /** The wall's openings. */
  readonly children: readonly Id[];
  readonly a: Vec2;
  readonly b: Vec2;
  readonly thickness: number;
  readonly height: number;
}

export type RoomType =
  | 'living' | 'kitchen' | 'dining' | 'bedroom' | 'bathroom'
  | 'office' | 'hallway' | 'laundry' | 'storage' | 'studio';

export interface ZoneNode extends Base<'zone'> {
  readonly parent: Id;
  readonly points: readonly Vec2[];
  readonly use: RoomType;
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

/** A door or window in a wall. Its place is measured along the wall from end `a`. */
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
}

export type SceneNode = BuildingNode | LevelNode | WallNode | ZoneNode | SlabNode | OpeningNode;
export type NodeOf<T extends NodeType> = Extract<SceneNode, { type: T }>;

export interface SceneDoc {
  /** The project's name. */
  readonly name: string;
  readonly nodes: Readonly<Record<Id, SceneNode>>;
  /** Buildings, in order. */
  readonly roots: readonly Id[];
}

/** How a building shows its levels. Not part of the document, so not undone. */
export type LevelMode = 'stack' | 'explode' | 'solo';

export const GRID = 0.25;
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
export const UNTITLED = 'Untitled project';
export const MIN_WALL = GRID;
export const ROOM_TYPES: readonly RoomType[] = [
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom',
  'office', 'hallway', 'laundry', 'storage', 'studio',
];
