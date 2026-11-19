/**
 * Versions and sign-off.
 *
 * A version is a named snapshot of the project. A client (or anyone) can
 * approve a version by typing their name: the approval records who and when,
 * and an approved version can no longer be deleted. Comparing a version with
 * another, or with the design now, lists what changed in the door and window
 * schedule and in the structure, so changes are agreed before anything is
 * ordered.
 *
 * An approval here is a record of agreement, not a verified electronic
 * signature.
 *
 * Versions are stored where the project is: in the browser for a local
 * project, in the cloud for a cloud project (`cloud.ts` supplies that store).
 */
import { migrate, validate } from './ops';
import { schedule, type ScheduleRow } from './schedule';
import type { Catalogue } from './catalogue';
import type { SceneDoc } from './types';

export interface Approval { by: string; at: number; note: string }

export interface Version {
  id: string;
  /** 1, 2, 3… in the order they were saved. */
  number: number;
  createdAt: number;
  author: string;
  note: string;
  doc: SceneDoc;
  approval: Approval | null;
}

export interface VersionStore {
  list(projectId: string): Promise<Version[]>;
  add(projectId: string, v: Omit<Version, 'id' | 'number'>): Promise<Version>;
  approve(projectId: string, versionId: string, approval: Approval): Promise<Version>;
  remove(projectId: string, versionId: string): Promise<void>;
}

const KEY = (projectId: string) => `likuloka3d.versions:${projectId}`;
const versionId = () => `version-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function readLocal(projectId: string): Version[] {
  try {
    const raw = localStorage.getItem(KEY(projectId));
    const list = raw ? (JSON.parse(raw) as Version[]) : [];
    return list.map(v => ({ ...v, doc: validate(migrate(v.doc)) }));
  } catch {
    return [];
  }
}
function writeLocal(projectId: string, list: Version[]) {
  try {
    localStorage.setItem(KEY(projectId), JSON.stringify(list));
  } catch {
    throw new Error('The browser would not store the version. Download the project to keep a copy.');
  }
}

/** Versions kept in this browser, next to the project. */
export const localVersions: VersionStore = {
  async list(projectId) {
    return readLocal(projectId).sort((p, q) => q.number - p.number);
  },
  async add(projectId, v) {
    const list = readLocal(projectId);
    const version: Version = { ...v, id: versionId(), number: list.reduce((m, x) => Math.max(m, x.number), 0) + 1 };
    writeLocal(projectId, [...list, version]);
    return version;
  },
  async approve(projectId, id, approval) {
    const list = readLocal(projectId);
    const v = list.find(x => x.id === id);
    if (!v) throw new Error('That version no longer exists.');
    if (v.approval) throw new Error(`Version ${v.number} was already approved by ${v.approval.by}.`);
    const approved = { ...v, approval };
    writeLocal(projectId, list.map(x => (x.id === id ? approved : x)));
    return approved;
  },
  async remove(projectId, id) {
    const list = readLocal(projectId);
    const v = list.find(x => x.id === id);
    if (v?.approval) throw new Error('An approved version is kept as a record and cannot be deleted.');
    writeLocal(projectId, list.filter(x => x.id !== id));
  },
};

/** Checks an approval before it is stored. */
export function approvalFrom(by: string, note: string): Approval {
  const name = by.trim();
  if (name.length < 2) throw new Error('Type your full name to approve.');
  return { by: name.slice(0, 80), at: Date.now(), note: note.trim().slice(0, 500) };
}

// ---- comparing ------------------------------------------------------------------

/** JSON with keys in a fixed order, so equal data gives equal text whatever order it was built in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export interface FieldChange { field: string; from: string; to: string }
export interface Comparison {
  added: ScheduleRow[];
  removed: ScheduleRow[];
  changed: { ref: string; was: string; id: string; fields: FieldChange[] }[];
  /** Changes outside doors and windows, counted by kind. */
  structure: { kind: string; added: number; removed: number; changed: number }[];
  /** Whether anything at all differs. */
  same: boolean;
}

const FIELDS: [keyof ScheduleRow, string][] = [
  ['product', 'Product'], ['kind', 'Type'], ['shape', 'Head'], ['finish', 'Frame'],
  ['width', 'Opening width'], ['height', 'Opening height'], ['frameWidth', 'Frame width'], ['frameHeight', 'Frame height'],
  ['sill', 'Sill'], ['wall', 'Wall'], ['state', 'Drawn'], ['level', 'Level'], ['building', 'Building'],
];

/** What changed from `before` to `after`: the schedule opening by opening, and the rest by kind. */
export function compare(before: SceneDoc, after: SceneDoc, catalogue?: Catalogue): Comparison {
  const a = new Map(schedule(before, catalogue).map(r => [r.id, r]));
  const b = new Map(schedule(after, catalogue).map(r => [r.id, r]));
  const added = [...b.values()].filter(r => !a.has(r.id));
  const removed = [...a.values()].filter(r => !b.has(r.id));
  const changed: Comparison['changed'] = [];
  for (const [id, r] of b) {
    const old = a.get(id);
    if (!old) continue;
    const fields = FIELDS.filter(([k]) => old[k] !== r[k]).map(([k, label]) => ({ field: label, from: String(old[k] || '—'), to: String(r[k] || '—') }));
    if (fields.length) changed.push({ ref: r.ref, was: old.ref, id, fields });
  }
  // By content, not identity: a version read back from storage is a fresh copy of every node.
  const counts = new Map<string, { added: number; removed: number; changed: number }>();
  const own = (n: object) => {
    // A parent's children list changes when a child is added; that is counted on the child.
    const { children: _c, ...rest } = n as { children?: unknown };
    void _c;
    return stable(rest);
  };
  for (const id of new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])) {
    const p = before.nodes[id], n = after.nodes[id];
    const kind = (n ?? p)!.type;
    if (kind === 'opening') continue;
    const c = counts.get(kind) ?? { added: 0, removed: 0, changed: 0 };
    if (!p) c.added++;
    else if (!n) c.removed++;
    else if (p !== n && own(p) !== own(n)) c.changed++;
    else continue;
    counts.set(kind, c);
  }
  const structure = [...counts].map(([kind, c]) => ({ kind, ...c })).filter(c => c.added + c.removed + c.changed > 0);
  if (before.name !== after.name) structure.unshift({ kind: 'project name', added: 0, removed: 0, changed: 1 });
  if (stable(before.settings) !== stable(after.settings)) structure.push({ kind: 'settings', added: 0, removed: 0, changed: 1 });
  return { added, removed, changed, structure, same: !added.length && !removed.length && !changed.length && !structure.length };
}

const AUTHOR = 'likuloka3d.author';
export function rememberedName(): string {
  try { return localStorage.getItem(AUTHOR) ?? ''; } catch { return ''; }
}
export function rememberName(name: string) {
  try { localStorage.setItem(AUTHOR, name.trim()); } catch { /* storage may be off */ }
}

let cloudVersions: VersionStore | null = null;
/** Called by the cloud module once it is set up. */
export function setCloudVersions(store: VersionStore | null) {
  cloudVersions = store;
}
/** Where the open project's versions are kept. */
export function versionStore(where: 'local' | 'cloud'): VersionStore {
  return where === 'cloud' && cloudVersions ? cloudVersions : localVersions;
}
