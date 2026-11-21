/**
 * Buildability checks. They never block an edit: they list what a builder or
 * inspector would query, so it can be fixed before anything is ordered.
 *
 * The thresholds are in the catalogue's `rules` (millimetres and m²), so they
 * can follow your local regulations. The defaults are common minimums, not
 * any one country's code: check them against the rules where you build.
 *
 * Results are cached per document. Documents are immutable, so the same
 * document always gives the same issues, and a drag recomputes only when the
 * document actually changes.
 */
import { frameSize, type Id, type OpeningNode, type RoomType, type SceneDoc, type Vec2, type WallNode, type ZoneNode } from './types';
import { area } from './ops';
import { furnishLevel } from './furnish';
import type { Catalogue, Rules } from './catalogue';

export type Severity = 'warning' | 'note';

export interface Issue {
  /** Stable for one node and rule, so lists keep their order. */
  key: string;
  node: Id;
  rule: string;
  severity: Severity;
  message: string;
}

const HABITABLE: RoomType[] = ['living', 'kitchen', 'dining', 'bedroom', 'office', 'studio'];
const mm = (m: number) => Math.round(m * 1000);

interface Placed { o: OpeningNode; wall: WallNode; at: Vec2; ref: string }

function distToSegment(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Whether an opening sits on the boundary of a room (zone), so it serves that room. */
function serves(z: ZoneNode, p: Placed) {
  const reach = p.wall.thickness / 2 + 0.05;
  return z.points.some((a, i) => distToSegment(p.at, a, z.points[(i + 1) % z.points.length]) <= reach);
}

/** Every opening with its plan position and its schedule reference. */
function placed(doc: SceneDoc): Placed[] {
  const out: Placed[] = [];
  let doors = 0, windows = 0;
  for (const b of doc.roots) {
    const building = doc.nodes[b];
    if (building?.type !== 'building') continue;
    const levels = building.children.map(c => doc.nodes[c]).filter(n => n?.type === 'level').sort((p, q) => (p as { elevation: number }).elevation - (q as { elevation: number }).elevation);
    for (const level of levels) {
      if (level?.type !== 'level') continue;
      for (const c of level.children) {
        const wall = doc.nodes[c];
        if (wall?.type !== 'wall') continue;
        const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
        const ux = (wall.b[0] - wall.a[0]) / len, uy = (wall.b[1] - wall.a[1]) / len;
        const os = wall.children.map(o => doc.nodes[o]).filter((o): o is OpeningNode => o?.type === 'opening').sort((p, q) => p.offset - q.offset);
        for (const o of os) {
          const ref = o.kind === 'door' ? `D${String(++doors).padStart(2, '0')}` : `W${String(++windows).padStart(2, '0')}`;
          out.push({ o, wall, ref, at: [wall.a[0] + ux * o.offset, wall.a[1] + uy * o.offset] });
        }
      }
    }
  }
  return out;
}

export function runChecks(doc: SceneDoc, rules: Rules): Issue[] {
  const issues: Issue[] = [];
  const add = (node: Id, rule: string, severity: Severity, message: string, about = '') => {
    const key = `${node}:${rule}${about && `:${about}`}`;
    if (!issues.some(i => i.key === key)) issues.push({ key, node, rule, severity, message });
  };
  const all = placed(doc);
  const tol = doc.settings.tolerance;

  for (const p of all) {
    const { o, wall, ref } = p;
    const frame = frameSize(o, tol);
    const head = o.sill + o.height;
    if (o.kind === 'door') {
      if (mm(frame.width) < rules.minDoorWidth) {
        add(o.id, 'door-width', 'warning', `${ref} has a ${mm(frame.width)} mm frame. Doors should be at least ${rules.minDoorWidth} mm for wheelchair access and moving furniture.`);
      }
      if (mm(head) < rules.minDoorHeadHeight) {
        add(o.id, 'door-head', 'warning', `${ref}'s head is ${mm(head)} mm above the floor; at least ${rules.minDoorHeadHeight} mm is needed to walk through.`);
      }
    }
    if (o.shape === 'square' && mm(wall.height - head) < rules.minWallAboveOpening) {
      add(o.id, 'lintel-room', 'warning', `${ref} leaves ${mm(wall.height - head)} mm of wall above it; a lintel needs at least ${rules.minWallAboveOpening} mm.`);
    }
    if (mm(o.width) > rules.lintelSpanNeedsEngineer) {
      add(o.id, 'lintel-span', 'note', `${ref} spans ${mm(o.width)} mm: its lintel should be sized by an engineer.`);
    }
    // Another wall joining this one inside the opening, or too close to its edge.
    const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
    const ux = (wall.b[0] - wall.a[0]) / len, uy = (wall.b[1] - wall.a[1]) / len;
    const level = doc.nodes[wall.parent];
    if (level?.type === 'level') {
      for (const c of level.children) {
        const other = doc.nodes[c];
        if (other?.type !== 'wall' || other.id === wall.id) continue;
        for (const end of [other.a, other.b]) {
          const s = (end[0] - wall.a[0]) * ux + (end[1] - wall.a[1]) * uy;
          const d = Math.abs((end[0] - wall.a[0]) * -uy + (end[1] - wall.a[1]) * ux);
          if (d > wall.thickness / 2 + 1e-6 || s < 0 || s > len) continue;
          const clear = other.thickness / 2 + rules.junctionClearance / 1000;
          if (s > o.offset - o.width / 2 - clear && s < o.offset + o.width / 2 + clear) {
            add(o.id, 'junction', 'warning', `${ref} runs into ${other.name}, which joins its wall there. Move it at least ${rules.junctionClearance} mm clear of the joining wall.`, other.id);
          }
        }
      }
    }
  }

  for (const n of Object.values(doc.nodes)) {
    if (n.type !== 'zone') continue;
    const z = n;
    const level = z.parent;
    const lv = doc.nodes[level];
    const room = `${z.name}${lv?.type === 'level' ? ` (${lv.name})` : ''}`;
    const here = all.filter(p => p.wall.parent === level && serves(z, p));
    const doors = here.filter(p => p.o.kind === 'door');
    const windows = here.filter(p => p.o.kind === 'window');
    // A furnishing option the room is too small for is not drawn; say so instead of leaving a choice that does nothing.
    if (z.option !== 'standard') {
      const tag = z.option === 'island' ? 'island' : 'sunken-bed';
      if (!furnishLevel(doc, level).some(p => p.zone === z.id && p.tag === tag)) {
        add(z.id, 'option', 'note', z.option === 'island'
          ? `${room} is too small for an island with a 1 m aisle; it is furnished along the wall. Widen the room or choose "Along the wall".`
          : `${room} has no wall a sunken bed fits against; it has a standard bed. A sunken bed needs its width plus 350 mm of deck each side.`);
      }
    }
    if (z.use === 'pool') continue; // open to the garden: no door, no daylight to count
    if (!doors.length) add(z.id, 'no-door', 'warning', `${room} has no door.`);
    if (z.use === 'bedroom') {
      const escape = windows.some(p => {
        const f = frameSize(p.o, tol);
        return f.width * f.height >= rules.escapeWindowArea && mm(p.o.sill) <= rules.escapeWindowMaxSill;
      });
      if (!escape) {
        add(z.id, 'escape', 'warning', `${room} has no window big enough to escape through in a fire: one needs at least ${rules.escapeWindowArea} m² of frame with its sill no higher than ${rules.escapeWindowMaxSill} mm.`);
      }
    }
    if (HABITABLE.includes(z.use)) {
      const floor = Math.abs(area(z.points));
      const glass = windows.reduce((s, p) => { const f = frameSize(p.o, tol); return s + f.width * f.height; }, 0);
      if (floor > 0 && glass < floor * rules.daylightRatio) {
        add(z.id, 'daylight', 'note', `${room} has ${glass.toFixed(2)} m² of window for ${floor.toFixed(1)} m² of floor; ${Math.round(rules.daylightRatio * 100)}% (${(floor * rules.daylightRatio).toFixed(2)} m²) gives good daylight.`);
      }
    }
  }

  // The plot: each building stays inside the boundary, and the project's distance away from it.
  if (doc.plot) {
    const plot = doc.plot, setback = doc.settings.setback;
    const inside = (p: Vec2) => {
      let k = false;
      for (let i = 0, j = plot.length - 1; i < plot.length; j = i++) {
        const [xi, yi] = plot[i], [xj, yj] = plot[j];
        if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) k = !k;
      }
      return k;
    };
    for (const b of doc.roots) {
      const building = doc.nodes[b];
      if (building?.type !== 'building') continue;
      let out = 0, nearest = Infinity;
      for (const l of building.children) {
        const level = doc.nodes[l];
        if (level?.type !== 'level') continue;
        for (const c of level.children) {
          // walls by their ends, and a pool by its corners: a pool has no walls
          const w = doc.nodes[c];
          const ends = w?.type === 'wall' ? [w.a, w.b] : w?.type === 'zone' && w.use === 'pool' ? w.points : [];
          for (const end of ends) {
            const p: Vec2 = [end[0] + building.origin[0], end[1] + building.origin[1]];
            const d = Math.min(...plot.map((a, i) => distToSegment(p, a, plot[(i + 1) % plot.length])));
            if (!inside(p) && d > 1e-6) out++;
            else nearest = Math.min(nearest, d);
          }
        }
      }
      if (out) add(building.id, 'outside-plot', 'warning', `${building.name} crosses the plot's boundary: ${out} corner${out === 1 ? ' is' : 's are'} outside it. Move the building or correct the plot.`);
      else if (nearest < setback - 1e-6) add(building.id, 'setback', 'warning', `${building.name} comes within ${mm(nearest)} mm of the plot's boundary; the project keeps ${mm(setback)} mm clear. Check the setback your permit requires.`);
    }
  }

  return issues.sort((p, q) => (p.severity === q.severity ? 0 : p.severity === 'warning' ? -1 : 1));
}

const cache = new WeakMap<SceneDoc, WeakMap<Rules, Issue[]>>();

/** The issues in a document, computed once per document and rules. */
export function checks(doc: SceneDoc, catalogue: Catalogue): Issue[] {
  let byRules = cache.get(doc);
  if (!byRules) { byRules = new WeakMap(); cache.set(doc, byRules); }
  let issues = byRules.get(catalogue.rules);
  if (!issues) { issues = runChecks(doc, catalogue.rules); byRules.set(catalogue.rules, issues); }
  return issues;
}
