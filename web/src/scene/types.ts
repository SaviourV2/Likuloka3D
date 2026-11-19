/**
 * The scene document: a flat table of nodes that form a tree.
 *
 *   building → level → wall | zone | slab
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

export type NodeType = 'building' | 'level' | 'wall' | 'zone' | 'slab';

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

export type SceneNode = BuildingNode | LevelNode | WallNode | ZoneNode | SlabNode;
export type NodeOf<T extends NodeType> = Extract<SceneNode, { type: T }>;

export interface SceneDoc {
  readonly nodes: Readonly<Record<Id, SceneNode>>;
  /** Buildings, in order. */
  readonly roots: readonly Id[];
}

/** How a building shows its levels. Not part of the document, so not undone. */
export type LevelMode = 'stack' | 'explode' | 'solo';

export const GRID = 0.25;
export const MIN_WALL = GRID;
export const ROOM_TYPES: readonly RoomType[] = [
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom',
  'office', 'hallway', 'laundry', 'storage', 'studio',
];
