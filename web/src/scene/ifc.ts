/**
 * IFC4 export, for engineers and BIM tools (Revit, ArchiCAD, BlenderBIM…).
 *
 * The file has the project, site, each building and its storeys; walls as
 * swept solids with their build-up as an IFC material layer set; openings
 * that void the walls, filled by doors and windows with their frame sizes;
 * floor slabs; and each room as a space. Door and window properties carry
 * the schedule reference, product code, finish and price.
 *
 * GlobalIds are derived from the project and node ids, so exporting again
 * gives the same ids and a BIM tool updates its elements instead of adding
 * copies.
 *
 * Plan y runs down the page; IFC's y runs north, so plan y becomes -y.
 * Rounded heads are exported with rectangular openings: the IFC door and
 * window keep their overall sizes and say the head is rounded in their
 * properties.
 */
import { schedule } from './schedule';
import { area } from './ops';
import { frameSize, FINISH_LABELS, type LevelNode, type OpeningNode, type SceneDoc, type SlabNode, type Vec2, type WallNode, type ZoneNode } from './types';
import { productFor, type Catalogue } from './catalogue';

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** A 128-bit hash of a string, as four 32-bit words (cyrb128). */
function hash128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** An IFC GlobalId: 128 bits as 22 characters of IFC's base 64. Stable for the same key. */
export function globalId(key: string): string {
  const words = hash128(key);
  let big = 0n;
  for (const w of words) big = (big << 32n) | BigInt(w);
  let out = '';
  for (let i = 0; i < 22; i++) {
    out = B64[Number(big & 63n)] + out;
    big >>= 6n;
  }
  // The first character holds only the top two bits.
  return B64[B64.indexOf(out[0]) & 3] + out.slice(1);
}

/** A STEP string: quotes doubled, anything outside printable ASCII as \X2\…\X0\. */
function str(s: string | null | undefined): string {
  if (s === null || s === undefined) return '$';
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (code >= 32 && code < 127) out += ch;
    else {
      const units = code > 0xffff ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)] : [code];
      out += `\\X2\\${units.map(u => u.toString(16).toUpperCase().padStart(4, '0')).join('')}\\X0\\`;
    }
  }
  return `'${out}'`;
}

/** A STEP real: always with a decimal point. */
function real(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  const s = String(r === 0 ? 0 : r);
  return /[.eE]/.test(s) ? s : `${s}.`;
}

class Writer {
  lines: string[] = [];
  private n = 0;
  add(entity: string): string {
    const id = `#${++this.n}`;
    this.lines.push(`${id}=${entity};`);
    return id;
  }
  point(x: number, y: number, z?: number) {
    return this.add(z === undefined ? `IFCCARTESIANPOINT((${real(x)},${real(y)}))` : `IFCCARTESIANPOINT((${real(x)},${real(y)},${real(z)}))`);
  }
  dir(x: number, y: number, z?: number) {
    return this.add(z === undefined ? `IFCDIRECTION((${real(x)},${real(y)}))` : `IFCDIRECTION((${real(x)},${real(y)},${real(z)}))`);
  }
  placement3(x: number, y: number, z: number, xdir?: [number, number, number]) {
    const p = this.point(x, y, z);
    return xdir ? this.add(`IFCAXIS2PLACEMENT3D(${p},${this.dir(0, 0, 1)},${this.dir(...xdir)})`) : this.add(`IFCAXIS2PLACEMENT3D(${p},$,$)`);
  }
  local(relTo: string | null, place: string) {
    return this.add(`IFCLOCALPLACEMENT(${relTo ?? '$'},${place})`);
  }
}

export function ifcFile(doc: SceneDoc, opts: { projectId: string; catalogue?: Catalogue; fileName?: string; author?: string }): string {
  const w = new Writer();
  const gid = (key: string) => str(globalId(`${opts.projectId}:${key}`));
  const refs = new Map(schedule(doc, opts.catalogue).map(r => [r.id, r.ref]));
  const tol = doc.settings.tolerance;

  const person = w.add(`IFCPERSON($,${str(opts.author || 'Designer')},$,$,$,$,$,$)`);
  const org = w.add(`IFCORGANIZATION($,'Likuloka',$,$,$)`);
  const pando = w.add(`IFCPERSONANDORGANIZATION(${person},${org},$)`);
  const app = w.add(`IFCAPPLICATION(${org},'1','Likuloka 3D','Likuloka3D')`);
  const owner = w.add(`IFCOWNERHISTORY(${pando},${app},$,.ADDED.,$,$,$,${Math.floor(Date.now() / 1000)})`);

  const units = [
    w.add(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`),
    w.add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`),
    w.add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`),
    w.add(`IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)`),
  ];
  const unitAssignment = w.add(`IFCUNITASSIGNMENT((${units.join(',')}))`);
  const worldOrigin = w.placement3(0, 0, 0);
  const context = w.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${worldOrigin},$)`);
  const body = w.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${context},$,.MODEL_VIEW.,$)`);
  const project = w.add(`IFCPROJECT(${gid('project')},${owner},${str(doc.name)},$,$,$,$,(${context}),${unitAssignment})`);

  const sitePlace = w.local(null, w.placement3(0, 0, 0));
  const site = w.add(`IFCSITE(${gid('site')},${owner},'Site',$,$,${sitePlace},$,$,.ELEMENT.,$,$,$,$,$)`);
  w.add(`IFCRELAGGREGATES(${gid('rel:project-site')},${owner},$,$,${project},(${site}))`);

  const shape = (items: string[], kind = 'SweptSolid') => {
    const rep = w.add(`IFCSHAPEREPRESENTATION(${body},'Body',${str(kind)},(${items.join(',')}))`);
    return w.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
  };
  /** A box: a rectangle `x` by `y` centred on (cx, cy) in its placement, extruded `z` up. */
  const box = (cx: number, cy: number, x: number, y: number, z: number, z0 = 0) => {
    const profile = w.add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${w.add(`IFCAXIS2PLACEMENT2D(${w.point(cx, cy)},$)`)},${real(x)},${real(y)})`);
    return w.add(`IFCEXTRUDEDAREASOLID(${profile},${w.placement3(0, 0, z0)},${w.dir(0, 0, 1)},${real(z)})`);
  };
  const polygonSolid = (pts: readonly Vec2[], depth: number, z0: number) => {
    const ring = [...pts, pts[0]].map(p => w.point(p[0], -p[1]));
    const profile = w.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${w.add(`IFCPOLYLINE((${ring.join(',')}))`)})`);
    return w.add(`IFCEXTRUDEDAREASOLID(${profile},${w.placement3(0, 0, z0)},${w.dir(0, 0, 1)},${real(depth)})`);
  };
  const props = (owner_: string, element: string, name: string, values: [string, string][]) => {
    if (!values.length) return;
    const list = values.map(([k, v]) => w.add(`IFCPROPERTYSINGLEVALUE(${str(k)},$,${v},$)`));
    const pset = w.add(`IFCPROPERTYSET(${gid(`pset:${name}:${element}`)},${owner},${str(name)},$,(${list.join(',')}))`);
    w.add(`IFCRELDEFINESBYPROPERTIES(${gid(`rel:pset:${name}:${element}`)},${owner},$,$,(${owner_}),${pset})`);
  };
  const label = (v: string) => `IFCLABEL(${str(v)})`;
  const length = (v: number) => `IFCPOSITIVELENGTHMEASURE(${real(v)})`;
  const materials = new Map<string, string>();
  const material = (name: string) => {
    let m = materials.get(name);
    if (!m) { m = w.add(`IFCMATERIAL(${str(name)},$,$)`); materials.set(name, m); }
    return m;
  };

  const buildings: string[] = [];
  for (const b of doc.roots) {
    const building = doc.nodes[b];
    if (building?.type !== 'building') continue;
    const bPlace = w.local(sitePlace, w.placement3(building.origin[0], -building.origin[1], 0));
    const bEnt = w.add(`IFCBUILDING(${gid(building.id)},${owner},${str(building.name)},$,$,${bPlace},$,$,.ELEMENT.,$,$,$)`);
    buildings.push(bEnt);
    const storeys: string[] = [];
    const levels = building.children.map(c => doc.nodes[c]).filter((l): l is LevelNode => l?.type === 'level').sort((p, q) => p.elevation - q.elevation);
    for (const level of levels) {
      const sPlace = w.local(bPlace, w.placement3(0, 0, level.elevation));
      const storey = w.add(`IFCBUILDINGSTOREY(${gid(level.id)},${owner},${str(level.name)},$,$,${sPlace},$,$,.ELEMENT.,${real(level.elevation)})`);
      storeys.push(storey);
      const contained: string[] = [];
      const spaces: string[] = [];
      for (const c of level.children) {
        const n = doc.nodes[c];
        if (n?.type === 'wall') contained.push(...wall(n, sPlace));
        else if (n?.type === 'slab') contained.push(slab(n, sPlace));
        else if (n?.type === 'zone') spaces.push(space(n, sPlace, level));
      }
      if (contained.length) w.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${gid(`rel:contains:${level.id}`)},${owner},$,$,(${contained.join(',')}),${storey})`);
      if (spaces.length) w.add(`IFCRELAGGREGATES(${gid(`rel:spaces:${level.id}`)},${owner},$,$,${storey},(${spaces.join(',')}))`);
    }
    if (storeys.length) w.add(`IFCRELAGGREGATES(${gid(`rel:storeys:${building.id}`)},${owner},$,$,${bEnt},(${storeys.join(',')}))`);
  }
  if (buildings.length) w.add(`IFCRELAGGREGATES(${gid('rel:site-buildings')},${owner},$,$,${site},(${buildings.join(',')}))`);

  function wall(n: WallNode, storeyPlace: string): string[] {
    const len = Math.hypot(n.b[0] - n.a[0], n.b[1] - n.a[1]);
    const ux = (n.b[0] - n.a[0]) / len, uy = -(n.b[1] - n.a[1]) / len;
    const place = w.local(storeyPlace, w.placement3(n.a[0], -n.a[1], 0, [ux, uy, 0]));
    const t = n.thickness;
    // Along local x from -t/2 to len + t/2 (corners close), centred across.
    const solid = box(len / 2, 0, len + t, t, n.height);
    const wallEnt = w.add(`IFCWALL(${gid(n.id)},${owner},${str(n.name)},$,$,${place},${shape([solid])},${str(n.id)},.STANDARD.)`);
    // Build-up as a layer set; a plain wall is one layer.
    const layers = (n.layers.length ? n.layers : [{ name: 'Wall', thickness: t, kind: 'structure' as const }])
      .map(l => w.add(`IFCMATERIALLAYER(${material(l.name)},${real(l.thickness)},$,${str(l.name)},$,${str(l.kind)},$)`));
    const set = w.add(`IFCMATERIALLAYERSET((${layers.join(',')}),${str(n.wallType ?? (n.layers.length ? 'Custom build-up' : 'Plain wall'))},$)`);
    const usage = w.add(`IFCMATERIALLAYERSETUSAGE(${set},.AXIS2.,.POSITIVE.,${real(-t / 2)},$)`);
    w.add(`IFCRELASSOCIATESMATERIAL(${gid(`rel:material:${n.id}`)},${owner},$,$,(${wallEnt}),${usage})`);
    props(wallEnt, n.id, 'Pset_WallCommon', [['Reference', label(n.wallType ?? 'Plain wall')], ['IsExternal', 'IFCBOOLEAN(.U.)']]);
    const out = [wallEnt];
    for (const id of n.children) {
      const o = doc.nodes[id];
      if (o?.type === 'opening') out.push(opening(o, n, place, wallEnt));
    }
    return out;
  }

  function opening(o: OpeningNode, wallNode: WallNode, wallPlace: string, wallEnt: string): string {
    const t = wallNode.thickness;
    const place = w.local(wallPlace, w.placement3(o.offset, 0, o.sill));
    // The void runs a little past both faces so it cuts cleanly.
    const voidEnt = w.add(`IFCOPENINGELEMENT(${gid(`void:${o.id}`)},${owner},${str(`${o.kind} opening`)},$,$,${place},${shape([box(0, 0, o.width, t + 0.1, o.height)])},$,.OPENING.)`);
    w.add(`IFCRELVOIDSELEMENT(${gid(`rel:void:${o.id}`)},${owner},$,$,${wallEnt},${voidEnt})`);
    const frame = frameSize(o, tol);
    const fillPlace = w.local(place, w.placement3(0, 0, o.kind === 'door' ? 0 : tol));
    const fill = shape([box(0, 0, frame.width, Math.min(0.07, t), frame.height)]);
    const ref = refs.get(o.id) ?? '';
    const name = `${ref} ${o.product ?? (o.kind === 'door' ? 'Door' : 'Window')}`.trim();
    const ent = o.kind === 'door'
      ? w.add(`IFCDOOR(${gid(o.id)},${owner},${str(name)},$,$,${fillPlace},${fill},${str(ref)},${real(frame.height)},${real(frame.width)},.DOOR.,.SINGLE_SWING_LEFT.,$)`)
      : w.add(`IFCWINDOW(${gid(o.id)},${owner},${str(name)},$,$,${fillPlace},${fill},${str(ref)},${real(frame.height)},${real(frame.width)},.WINDOW.,.SINGLE_PANEL.,$)`);
    w.add(`IFCRELFILLSELEMENT(${gid(`rel:fill:${o.id}`)},${owner},$,$,${voidEnt},${ent})`);
    const product = opts.catalogue ? productFor(opts.catalogue, o.product) : null;
    props(ent, o.id, o.kind === 'door' ? 'Pset_DoorCommon' : 'Pset_WindowCommon', [['Reference', label(ref)]]);
    const values: [string, string][] = [
      ['ScheduleReference', label(ref)],
      ['ProductCode', label(o.product ?? 'Custom size')],
      ['Finish', label(FINISH_LABELS[o.finish])],
      ['Head', label(o.shape === 'arched' ? 'Rounded' : 'Square')],
      ['StructuralOpeningWidth', length(o.width)],
      ['StructuralOpeningHeight', length(o.height)],
      ['SillHeight', `IFCLENGTHMEASURE(${real(o.sill)})`],
    ];
    if (product?.name) values.push(['ProductName', label(product.name)]);
    if (product?.price !== undefined) values.push(['Price', `IFCREAL(${real(product.price)})`]);
    props(ent, o.id, 'Likuloka_Opening', values);
    return ent;
  }

  function slab(n: SlabNode, storeyPlace: string): string {
    const place = w.local(storeyPlace, w.placement3(0, 0, 0));
    return w.add(`IFCSLAB(${gid(n.id)},${owner},${str(n.name)},$,$,${place},${shape([polygonSolid(n.points, n.thickness, -n.thickness)])},$,.FLOOR.)`);
  }

  function space(n: ZoneNode, storeyPlace: string, level: LevelNode): string {
    const place = w.local(storeyPlace, w.placement3(0, 0, 0));
    const ent = w.add(`IFCSPACE(${gid(n.id)},${owner},${str(n.name)},$,$,${place},${shape([polygonSolid(n.points, level.height, 0)])},${str(n.use)},.ELEMENT.,.SPACE.,$)`);
    props(ent, n.id, 'Pset_SpaceCommon', [['Reference', label(n.use)], ['GrossPlannedArea', `IFCAREAMEASURE(${real(Math.abs(area(n.points)))})`]]);
    return ent;
  }

  const now = new Date().toISOString().slice(0, 19);
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');",
    `FILE_NAME(${str(opts.fileName ?? 'project.ifc')},${str(now)},(${str(opts.author || 'Designer')}),('Likuloka'),'Likuloka 3D','Likuloka 3D','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...w.lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
