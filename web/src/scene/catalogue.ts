/**
 * The catalogue: your doors, windows and wall build-ups, the thresholds the
 * buildability checks use, and the columns of the schedule's CSV.
 *
 * It is `public/catalogue.json`, read when the editor opens, so it can be
 * changed on the server without rebuilding. The same file is bundled as a
 * fallback for when it cannot be fetched. Sizes in the file are millimetres;
 * this module converts them to the model's metres.
 */
import bundled from '../../public/catalogue.json';
import { openingFor, OPENING_FINISHES, OPENING_SHAPES, type OpeningFinish, type OpeningKind, type OpeningShape, type SceneDoc, type WallLayer, type Id } from './types';
import { updateOpening, updateWall } from './ops';
import { asset } from '@/scene/site';

export interface Product {
  code: string;
  name: string;
  kind: OpeningKind;
  shape: OpeningShape;
  finish: OpeningFinish;
  /** Frame size, millimetres. */
  width: number;
  height: number;
  /** Default sill for a window, millimetres. */
  sill?: number;
  price?: number;
}

export interface WallType { code: string; name: string; layers: { name: string; kind: WallLayer['kind']; thickness: number }[] }

export interface Rules {
  minDoorWidth: number;
  minDoorHeadHeight: number;
  escapeWindowArea: number;
  escapeWindowMaxSill: number;
  daylightRatio: number;
  minWallAboveOpening: number;
  lintelSpanNeedsEngineer: number;
  junctionClearance: number;
}

export interface Catalogue {
  currency: string;
  products: Product[];
  wallTypes: WallType[];
  rules: Rules;
  scheduleColumns: string[];
  /** Entries that were skipped because they were not valid, so they can be reported. */
  problems: string[];
}

const DEFAULT_RULES: Rules = {
  minDoorWidth: 800, minDoorHeadHeight: 2000, escapeWindowArea: 0.33, escapeWindowMaxSill: 1100,
  daylightRatio: 0.1, minWallAboveOpening: 150, lintelSpanNeedsEngineer: 1800, junctionClearance: 100,
};

const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Reads a catalogue file, keeping every valid entry and listing the rest. */
export function parseCatalogue(raw: unknown): Catalogue {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const products: Product[] = [];
  const seen = new Set<string>();
  for (const [i, p] of (Array.isArray(c.products) ? c.products : []).entries()) {
    const e = p as Partial<Product>;
    const ok = typeof e?.code === 'string' && e.code && !seen.has(e.code)
      && typeof e.name === 'string' && (e.kind === 'door' || e.kind === 'window')
      && OPENING_SHAPES.includes(e.shape as OpeningShape) && OPENING_FINISHES.includes(e.finish as OpeningFinish)
      && num(e.width, 300, 6000) && num(e.height, 300, 4000)
      && (e.sill === undefined || num(e.sill, 0, 3000)) && (e.price === undefined || num(e.price, 0, 1e9));
    if (!ok) { problems.push(`Product ${i + 1}${e?.code ? ` (${e.code})` : ''} is not valid`); continue; }
    seen.add(e.code!);
    products.push(e as Product);
  }
  const wallTypes: WallType[] = [];
  for (const [i, w] of (Array.isArray(c.wallTypes) ? c.wallTypes : []).entries()) {
    const e = w as Partial<WallType>;
    const ok = typeof e?.code === 'string' && typeof e.name === 'string' && Array.isArray(e.layers) && e.layers.length > 0
      && e.layers.every(l => typeof l?.name === 'string' && ['structure', 'insulation', 'cavity', 'finish'].includes(l.kind) && num(l.thickness, 3, 600));
    if (!ok) { problems.push(`Wall type ${i + 1}${e?.code ? ` (${e.code})` : ''} is not valid`); continue; }
    wallTypes.push(e as WallType);
  }
  const rules = { ...DEFAULT_RULES };
  const r = (c.rules && typeof c.rules === 'object' ? c.rules : {}) as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_RULES) as (keyof Rules)[]) if (typeof r[k] === 'number' && Number.isFinite(r[k])) rules[k] = r[k] as number;
  const scheduleColumns = Array.isArray(c.scheduleColumns) && c.scheduleColumns.every(x => typeof x === 'string') ? c.scheduleColumns as string[] : [];
  return { currency: typeof c.currency === 'string' ? c.currency : 'USD', products, wallTypes, rules, scheduleColumns, problems };
}

export const BUNDLED = parseCatalogue(bundled);

/** Fetches the catalogue from the site, falling back to the bundled copy. */
export async function fetchCatalogue(): Promise<Catalogue> {
  try {
    const res = await fetch(asset('catalogue.json'), { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    return parseCatalogue(await res.json());
  } catch {
    return { ...BUNDLED, problems: ['The catalogue file could not be loaded; the built-in copy is used.'] };
  }
}

export const productFor = (c: Catalogue, code: string | null) => (code ? c.products.find(p => p.code === code) ?? null : null);
export const wallTypeFor = (c: Catalogue, code: string | null) => (code ? c.wallTypes.find(w => w.code === code) ?? null : null);

/** Makes an opening this product: its type, head, frame and the structural opening the frame needs. */
export function applyProduct(doc: SceneDoc, id: Id, p: Product): SceneDoc {
  const size = openingFor(p.kind, { width: p.width / 1000, height: p.height / 1000 }, doc.settings.tolerance);
  return updateOpening(doc, id, {
    kind: p.kind, shape: p.shape, finish: p.finish, product: p.code,
    width: size.width, height: size.height,
    sill: p.kind === 'door' ? 0 : p.sill !== undefined ? p.sill / 1000 - doc.settings.tolerance : undefined,
  });
}

/** Gives a wall this build-up; its thickness becomes the layers' total. */
export function applyWallType(doc: SceneDoc, id: Id, w: WallType): SceneDoc {
  return updateWall(doc, id, { layers: w.layers.map(l => ({ ...l, thickness: l.thickness / 1000 })), wallType: w.code });
}

export function formatPrice(c: Catalogue, value: number) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: c.currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${c.currency} ${Math.round(value)}`;
  }
}
