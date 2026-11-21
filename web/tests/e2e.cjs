/*
 * Browser tests for the web editor. Serves the static export in out/ and
 * drives it in Chromium with Playwright: through window.likuloka for state,
 * and with the real mouse for drags in the 3D view.
 *
 * WebGPU is tried first (SwiftShader's Vulkan adapter works headless); if
 * that browser cannot start, the tests run on the WebGL 2 fallback.
 *
 *   npm test            # builds, then runs this
 *   node tests/e2e.cjs  # runs against an existing out/
 *   LIKULOKA_RENDERER=webgl node tests/e2e.cjs   # on the WebGL 2 fallback
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'out');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
let passed = 0, failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
}

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function launch() {
  // LIKULOKA_RENDERER=webgl runs the suite on the WebGL 2 fallback.
  if (process.env.LIKULOKA_RENDERER === 'webgl') return chromium.launch();
  const gpu = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader'];
  try { return await chromium.launch({ channel: 'chromium', args: gpu }); }
  catch { return chromium.launch(); }
}

const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));

async function open(browser, url, viewport = { width: 1400, height: 900 }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  // Fonts are decoration; the tests do not depend on the network.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(url);
  await page.waitForFunction(() => window.likuloka && ['WebGPU', 'WebGL 2'].includes(document.documentElement.dataset.backend), null, { timeout: 60000 });
  await page.evaluate(() => localStorage.clear());
  await frames(page);
  return { page, context, errors };
}

/** Ids of the sample scene's nodes, found by name. */
async function ids(page) {
  return page.evaluate(() => {
    const d = likuloka.getDoc();
    const [house, studio] = d.roots.map(r => d.nodes[r]);
    const level = (b, name) => b.children.map(c => d.nodes[c]).find(l => l.name === name);
    const of = (l, t) => l.children.map(c => d.nodes[c]).filter(n => n.type === t);
    const studioLevel = level(studio, 'Ground floor');
    const wallAt = (l, fn) => of(l, 'wall').find(fn);
    return {
      house: house.id, studio: studio.id,
      ground: level(house, 'Ground floor').id, upper: level(house, 'Level 1').id,
      studioLevel: studioLevel.id,
      studioSlab: of(studioLevel, 'slab')[0].id,
      studioZone: of(studioLevel, 'zone').find(z => z.name === 'Studio').id,
      // The wall between the studio and the store: its ends sit mid-way along other walls.
      partition: wallAt(studioLevel, w => w.a[0] === 4.5 && w.b[0] === 4.5).id,
      // The left outside wall: its ends are the ends of the front and back walls.
      leftWall: wallAt(studioLevel, w => w.a[0] === 0 && w.b[0] === 0).id,
      // The back wall, joined to the left wall, with a door and a window in it.
      backWall: wallAt(studioLevel, w => w.a[1] === 3.5 && w.b[1] === 3.5).id,
    };
  });
}

/** Opens the toolbar's Project menu and picks an item. */
async function menu(page, action) {
  await page.locator('[data-action="menu"]').click();
  await page.locator(`.menu-items [data-action="${action}"]`).click();
}

const node = (page, id) => page.evaluate(i => likuloka.getDoc().nodes[i], id);
const state = page => page.evaluate(() => likuloka.getState());

/** Drags in the 3D view by the screen distance that one plan step covers on the level's floor. */
async function drag(page, level, grab, by, lift = 0) {
  const start = await page.evaluate(([l, g, h]) => likuloka.project(l, g[0], g[1], h), [level, grab, lift]);
  const a = await page.evaluate(([l, g]) => likuloka.project(l, g[0], g[1], 0), [level, grab]);
  const b = await page.evaluate(([l, g, d]) => likuloka.project(l, g[0] + d[0], g[1] + d[1], 0), [level, grab, by]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + (b.x - a.x) / 2, start.y + (b.y - a.y) / 2, { steps: 4 });
  await page.mouse.move(start.x + (b.x - a.x), start.y + (b.y - a.y), { steps: 4 });
  await page.mouse.up();
  await frames(page);
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) { console.error('Run `npm run build` first: out/index.html is missing.'); process.exit(1); }
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await launch();
  const { page, context, errors } = await open(browser, url);
  // Confirm prompts (discard changes, restore a version, delete) are accepted.
  page.on('dialog', d => d.accept());
  const backend = await page.evaluate(() => likuloka.backend());
  console.log(`# renderer: ${backend}`);

  try {
    // ---- the scene and its hierarchy -----------------------------------------------------
    const id = await ids(page);
    const summary = await page.evaluate(() => {
      const d = likuloka.getDoc();
      return d.roots.map(r => {
        const b = d.nodes[r];
        return { name: b.name, levels: b.children.map(l => {
          const lv = d.nodes[l];
          const count = t => lv.children.filter(c => d.nodes[c].type === t).length;
          return { name: lv.name, elevation: lv.elevation, walls: count('wall'), zones: count('zone'), slabs: count('slab') };
        }) };
      });
    });
    ok('the sample has two buildings', summary.length === 2 && summary[0].name === 'Two bedroom house' && summary[1].name === 'Garden studio', summary);
    ok('the house has two levels, one above the other', summary[0].levels.length === 2 && summary[0].levels[0].elevation === 0 && summary[0].levels[1].elevation === 3, summary[0].levels);
    ok('each house level has a slab, six zones and nine walls', summary[0].levels.every(l => l.slabs === 1 && l.zones === 6 && l.walls === 9), summary[0].levels);
    ok('the studio has a slab, two zones and five walls', JSON.stringify(summary[1].levels[0]).includes('"walls":5,"zones":2,"slabs":1'), summary[1].levels);
    const slab = await node(page, id.studioSlab);
    ok('a Roomlines import outlines the rooms as the slab', slab.points.length === 4 && JSON.stringify(slab.points) === '[[0,0],[6,0],[6,3.5],[0,3.5]]', slab.points);
    ok('every node is drawn as an entity', await page.evaluate(() => Object.keys(likuloka.getDoc().nodes).every(i => likuloka.world.entities.has(i))));
    ok('the tree lists buildings and levels', await page.evaluate(() => {
      const names = [...document.querySelectorAll('.tree .row-name')].map(b => b.textContent);
      return names.includes('Two bedroom house') && names.includes('Garden studio') && names.includes('Level 1') && names.includes('Ground floor');
    }));
    const pixels = await page.locator('.stage').screenshot();
    ok('the 3D view draws the scene', pixels.length > 20000, pixels.length);

    // ---- dirty tracking ---------------------------------------------------------------
    await page.evaluate(() => likuloka.resetStats());
    await page.evaluate(i => likuloka.commit(d => likuloka.ops.updateWall(d, i, { thickness: 0.3 }), 'Thicken'), id.partition);
    await frames(page);
    let stats = await page.evaluate(() => likuloka.stats());
    ok('editing one wall updates only that wall', JSON.stringify(stats.last.ids) === JSON.stringify([id.partition]) && stats.updates.wall === 1 && stats.updates.zone === 0 && stats.updates.slab === 0, stats);

    await page.evaluate(() => likuloka.resetStats());
    await page.evaluate(i => likuloka.commit(d => likuloka.ops.offsetWall(d, i, -0.5), 'Slide'), id.leftWall);
    await frames(page);
    stats = await page.evaluate(() => likuloka.stats());
    const left = await node(page, id.leftWall);
    const kinds = await page.evaluate(list => list.map(i => likuloka.getDoc().nodes[i].type), stats.last.ids);
    ok('sliding a wall moves it and stretches the two walls joined to it, nothing else',
      kinds.filter(k => k === 'wall').length === 3 && kinds.every(k => k === 'wall' || k === 'opening') && stats.last.ids.includes(id.leftWall) && stats.updates.zone === 0, { ids: stats.last.ids, kinds });
    const back = await node(page, id.backWall);
    const backOpenings = await page.evaluate(w => likuloka.getDoc().nodes[w].children.map(c => likuloka.getDoc().nodes[c]), id.backWall);
    ok('doors and windows in a stretched wall keep their place in the room',
      backOpenings.map(o => back.a[0] + o.offset).sort((p, q) => p - q).join() === '2.25,5.25', { a: back.a, offsets: backOpenings.map(o => o.offset) });
    ok('the slid wall keeps to the grid', left.a[0] === 0.5 || left.a[0] === -0.5, left);

    // ---- undo and redo ------------------------------------------------------------------
    const before = await state(page);
    ok('every commit is one undo step', before.undo === 2, before);
    await page.evaluate(() => likuloka.undo());
    ok('undo puts the wall back', (await node(page, id.leftWall)).a[0] === 0);
    await page.evaluate(() => likuloka.undo());
    ok('undo again restores the thickness', (await node(page, id.partition)).thickness === 0.15);
    await page.evaluate(() => likuloka.redo());
    ok('redo reapplies it', (await node(page, id.partition)).thickness === 0.3);
    await page.keyboard.press('Control+z');
    ok('Ctrl+Z undoes', (await node(page, id.partition)).thickness === 0.15);
    await page.keyboard.press('Control+Shift+z');
    ok('Ctrl+Shift+Z redoes', (await node(page, id.partition)).thickness === 0.3);
    await page.evaluate(() => likuloka.undo());
    ok('the toolbar offers redo after an undo', await page.locator('[data-action="redo"]').isEnabled());
    const refused = await page.evaluate(i => likuloka.commit(d => likuloka.ops.updateWall(d, i, { thickness: -1 }), 'Bad'), id.partition);
    ok('an invalid edit is refused with a message and adds no step', !refused && (await state(page)).error && (await state(page)).undo === 0, await state(page));

    // Solo the studio's building view out of the way: frame it for the mouse tests.
    await page.evaluate(i => { likuloka.setView(i, { mode: 'solo' }); }, id.house);
    await page.evaluate(i => likuloka.setView(i, { mode: 'stack' }), id.house);

    // ---- dragging in 3D -----------------------------------------------------------------
    await page.evaluate(() => likuloka.resetStats());
    await drag(page, id.studioLevel, [4.5, 1.75], [1, 0], 0.6);
    let partition = await node(page, id.partition);
    let s = await state(page);
    ok('dragging a wall slides it sideways on the grid', partition.a[0] > 4.5 && partition.a[0] === partition.b[0] && (partition.a[0] * 4) % 1 === 0, partition);
    ok('the drag selected the wall', s.selection === id.partition, s.selection);
    ok('a whole drag is one undo step', s.undo === 1 && !s.gesture, s);
    stats = await page.evaluate(() => likuloka.stats());
    ok('a drag updates only the dragged wall', stats.updates.wall >= 1 && stats.updates.zone === 0 && stats.updates.slab === 0 && stats.last.ids.every(i => i === id.partition), stats);
    await page.keyboard.press('Control+z');
    ok('undoing the drag puts the wall back', (await node(page, id.partition)).a[0] === 4.5);

    await drag(page, id.studioLevel, [0, 1.75], [-1, 0], 0.6);
    const lw = await node(page, id.leftWall);
    const front = await page.evaluate(() => { const d = likuloka.getDoc(); return Object.values(d.nodes).filter(n => n.type === 'wall' && n.a[1] === 0 && n.b[1] === 0 && n.b[0] === 6); });
    ok('dragging an outside wall carries the ends of the walls joined to it', lw.a[0] < 0 && front.some(w => w.a[0] === lw.a[0]), { lw, front });
    await page.keyboard.press('Control+z');

    // Wall end handle.
    await page.evaluate(i => likuloka.select(i), id.partition);
    await frames(page);
    const ends = await node(page, id.partition);
    const top = Math.min(ends.height, 1.2) + 0.2;
    await drag(page, id.studioLevel, ends.b, [0, -1], top);
    const moved = await node(page, id.partition);
    ok('dragging a wall-end handle moves that end only', moved.a[1] === ends.a[1] && moved.b[1] < ends.b[1] && moved.b[0] === ends.b[0], moved);
    await page.keyboard.press('Control+z');

    // Slab corner handle and edge-midpoint handle.
    await page.evaluate(i => likuloka.select(i), id.studioSlab);
    await frames(page);
    await drag(page, id.studioLevel, [6, 3.5], [1, 1], 0.06);
    let sl = await node(page, id.studioSlab);
    ok('dragging a slab corner reshapes the slab', sl.points.length === 4 && sl.points[2][0] > 6 && sl.points[2][1] > 3.5, sl.points);
    await page.keyboard.press('Control+z');
    await drag(page, id.studioLevel, [3, 0], [0, -1], 0.06);
    sl = await node(page, id.studioSlab);
    ok('dragging an edge midpoint adds a corner there', sl.points.length === 5 && sl.points[1][0] === 3 && sl.points[1][1] < 0, sl.points);
    await page.keyboard.press('Control+z');
    ok('undo removes the added corner', (await node(page, id.studioSlab)).points.length === 4);

    // Zones: a click selects, then a drag moves.
    // A point near the front: from the camera, the back wall hides points near it.
    const zp = await page.evaluate(i => likuloka.project(i, 1.5, 1, 0.012), id.studioLevel);
    await page.mouse.click(zp.x, zp.y);
    await frames(page);
    ok('clicking a zone selects it', (await state(page)).selection === id.studioZone, await state(page));
    ok('the inspector shows the zone', await page.locator('.inspector[data-type="zone"]').isVisible());
    const zBefore = await node(page, id.studioZone);
    await drag(page, id.studioLevel, [1.5, 1], [1, 0], 0.012);
    const zAfter = await node(page, id.studioZone);
    ok('dragging a selected zone moves it', zAfter.points[0][0] > zBefore.points[0][0] && zAfter.points[0][1] === zBefore.points[0][1], { zBefore: zBefore.points[0], zAfter: zAfter.points[0] });
    const wp = await page.evaluate(i => likuloka.project(i, 4.5, 2.5, 0.6), id.studioLevel);
    await page.mouse.click(wp.x, wp.y);
    ok('a click on a wall selects the wall, not the zone behind it', (await state(page)).selection === id.partition, await state(page));
    await page.keyboard.press('Control+z');

    // ---- moving a building ---------------------------------------------------------------------
    await page.evaluate(i => likuloka.select(i), id.studioSlab);
    await frames(page);
    const origin0 = (await node(page, id.studio)).origin;
    const steps1 = (await state(page)).undo;
    await drag(page, id.studioLevel, [3, 1.75], [2, 1], 0.08);
    const origin1 = (await node(page, id.studio)).origin;
    ok('dragging the ring moves the whole building on the grid', origin1[0] > origin0[0] && origin1[1] > origin0[1] && (origin1[0] * 4) % 1 === 0 && (origin1[1] * 4) % 1 === 0, { origin0, origin1 });
    ok('moving a building is one undo step and changes nothing inside it', (await state(page)).undo === steps1 + 1
      && JSON.stringify((await node(page, id.partition)).a) === '[4.5,0]');
    await page.evaluate(() => likuloka.undo());
    ok('undo puts the building back', JSON.stringify((await node(page, id.studio)).origin) === JSON.stringify(origin0));
    const clientMove = await page.evaluate(([b]) => {
      likuloka.setRole({ kind: 'client', fixed: false });
      const ok = likuloka.commit(d => likuloka.ops.setOrigin(d, b, [30, 0]), 'Move');
      likuloka.setRole({ kind: 'designer' });
      return ok;
    }, [id.studio]);
    ok('a client cannot move a building', !clientMove);

    // ---- stack, explode and solo ---------------------------------------------------------
    await page.evaluate(i => likuloka.setView(i, { mode: 'explode' }), id.house);
    await frames(page);
    let up = await page.evaluate(i => likuloka.levelY(i), id.upper);
    ok('explode lifts the upper level away', Math.abs(up.y - (3 + 2.75)) < 1e-6 && up.visible, up);
    await page.locator('.building').first().locator('[data-mode="solo"]').click();
    await frames(page);
    const ground = await page.evaluate(i => likuloka.levelY(i), id.ground);
    up = await page.evaluate(i => likuloka.levelY(i), id.upper);
    ok('solo shows one level and hides the rest', ground.visible !== up.visible, { ground, up });
    await page.locator('.building').first().locator('.level').filter({ hasText: 'Level 1' }).locator('.mini').click();
    await frames(page);
    up = await page.evaluate(i => likuloka.levelY(i), id.upper);
    ok('a level can be picked to solo', up.visible && !(await page.evaluate(i => likuloka.levelY(i), id.ground)).visible);
    await page.locator('.building').first().locator('[data-mode="stack"]').click();
    await frames(page);
    up = await page.evaluate(i => likuloka.levelY(i), id.upper);
    ok('stack puts the level back at its elevation', up.y === 3 && up.visible, up);
    ok('level modes are view state, not undo steps', (await state(page)).undo === 0, await state(page));

    // ---- the wall tool -------------------------------------------------------------------
    await page.evaluate(i => likuloka.select(i), id.studioLevel);
    await page.keyboard.press('w');
    ok('W picks the wall tool', (await state(page)).tool === 'wall');
    const p1 = await page.evaluate(i => likuloka.project(i, 1, 1, 0), id.studioLevel);
    const p2 = await page.evaluate(i => likuloka.project(i, 3, 1, 0), id.studioLevel);
    const p3 = await page.evaluate(i => likuloka.project(i, 3, 2.5, 0), id.studioLevel);
    for (const p of [p1, p2, p3]) { await page.mouse.click(p.x, p.y); await frames(page); }
    const walls = await page.evaluate(i => likuloka.getDoc().nodes[i].children.filter(c => likuloka.getDoc().nodes[c].type === 'wall').length, id.studioLevel);
    ok('clicks chain new walls on the active level', walls === 7, walls);
    ok('each drawn wall is one undo step', (await state(page)).undo === 2);
    await page.keyboard.press('Escape');
    ok('Escape ends the chain', (await state(page)).tool === 'wall' && !(await state(page)).interaction.from);
    await page.keyboard.press('Escape');
    ok('a second Escape goes back to select', (await state(page)).tool === 'select');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');

    // ---- doors and windows -------------------------------------------------------------------
    const openings = await page.evaluate(() => {
      const d = likuloka.getDoc();
      const os = Object.values(d.nodes).filter(n => n.type === 'opening');
      return { doors: os.filter(o => o.kind === 'door').length, windows: os.filter(o => o.kind === 'window').length, parents: os.every(o => d.nodes[o.parent].type === 'wall' && d.nodes[o.parent].children.includes(o.id)) };
    });
    ok('the sample has doors and windows, each in a wall', openings.doors >= 10 && openings.windows >= 10 && openings.parents, openings);
    // The back wall holds a window and a door: two runs of full wall, below and above the
    // window, a run between them, above the door, and the run after it.
    const pieces = await page.evaluate(w => likuloka.world.entities.get(w).object.children.filter(c => c.userData.part).length, id.backWall);
    ok('a wall with openings is cut around them', pieces === 6, pieces);
    ok('parts above the cut are hidden, and shown when the cut is off', await page.evaluate(async w => {
      const parts = () => likuloka.world.entities.get(w).object.children.filter(c => c.userData.part);
      const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const hiddenCut = parts().filter(p => p.userData.y0 >= 1.2).every(p => !p.visible);
      document.querySelector('[data-action="cut"]').click();
      await raf();
      const shownFull = parts().every(p => p.visible);
      document.querySelector('[data-action="cut"]').click();
      await raf();
      return hiddenCut && shownFull;
    }, id.backWall));

    await page.keyboard.press('d');
    ok('D picks the door tool', (await state(page)).tool === 'door' && (await state(page)).interaction.kind === 'placing');
    const before2 = (await state(page)).undo;
    const wpt = await page.evaluate(i => likuloka.project(i, 0, 2.75, 0.6), id.studioLevel);
    await page.mouse.click(wpt.x, wpt.y);
    await frames(page);
    const placed = await page.evaluate(w => likuloka.getDoc().nodes[w].children.map(c => likuloka.getDoc().nodes[c]), id.leftWall);
    ok('a click on a wall in the door tool adds a door there', placed.length === 1 && placed[0].kind === 'door' && Math.abs(placed[0].offset - 2.75) <= 0.25, placed);
    ok('adding a door is one undo step and selects it', (await state(page)).undo === before2 + 1 && (await state(page)).selection === placed[0]?.id);
    await page.mouse.click(wpt.x, wpt.y);
    ok('a second door on the same spot is refused', (await state(page)).error && (await page.evaluate(w => likuloka.getDoc().nodes[w].children.length, id.leftWall)) === 1, (await state(page)).error);
    await page.keyboard.press('Escape');
    ok('Escape leaves the door tool', (await state(page)).tool === 'select');

    await page.evaluate(() => likuloka.resetStats());
    await drag(page, id.studioLevel, [0, 2.75], [0, -1], 1);
    const slid = await node(page, placed[0].id);
    stats = await page.evaluate(() => likuloka.stats());
    ok('dragging a door slides it along its wall', slid.offset < placed[0].offset && slid.offset >= placed[0].offset - 1.25, { before: placed[0].offset, after: slid.offset });
    ok('sliding a door rebuilds only the door and its wall', stats.last.ids.every(i => i === placed[0].id || i === id.leftWall) && stats.updates.zone === 0, stats.last);
    ok('the door drag is one undo step', (await state(page)).undo === before2 + 2);

    await page.evaluate(i => likuloka.select(i), placed[0].id);
    await page.locator('.inspector [aria-label="Type"] [data-value="window"]').click();
    const asWindow = await node(page, placed[0].id);
    ok('the inspector turns a door into a window with a sill', asWindow.kind === 'window' && asWindow.sill === 0.9 && asWindow.height === 1.2 && asWindow.name === 'Window', asWindow);
    const tall = await page.evaluate(i => likuloka.commit(d => likuloka.ops.updateOpening(d, i, { height: 5 }), 'Tall'), placed[0].id);
    ok('an opening taller than its wall is refused', !tall && /taller/.test((await state(page)).error), (await state(page)).error);
    const tooFar = await page.evaluate(i => likuloka.commit(d => likuloka.ops.updateOpening(d, i, { offset: 3.4 }), 'Far'), placed[0].id);
    ok('an opening past the end of its wall is refused', !tooFar && /fit/.test((await state(page)).error));
    await page.keyboard.press('Delete');
    await frames(page);
    ok('Delete removes the opening and its wall closes up', await page.evaluate(w =>
      likuloka.getDoc().nodes[w].children.length === 0 && likuloka.world.entities.get(w).object.children.filter(c => c.userData.part).length === 1, id.leftWall));
    for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
    ok('undo takes the door back out', (await page.evaluate(w => likuloka.getDoc().nodes[w].children.length, id.leftWall)) === 0 && (await state(page)).undo === before2);
    const deleteWall = await page.evaluate(w => {
      const kids = likuloka.getDoc().nodes[w].children;
      likuloka.commit(d => likuloka.ops.remove(d, w), 'Delete wall');
      const gone = kids.every(k => !likuloka.getDoc().nodes[k]);
      likuloka.undo();
      return gone && kids.every(k => likuloka.getDoc().nodes[k]);
    }, id.backWall);
    ok('deleting a wall takes its openings with it, and undo brings them back', deleteWall);

    // ---- door and window options and measurements ---------------------------------------------------
    const studioWindow = await page.evaluate(w => likuloka.getDoc().nodes[w].children.map(c => likuloka.getDoc().nodes[c]).find(o => o.kind === 'window'), id.backWall);
    await page.evaluate(i => likuloka.select(i), studioWindow.id);
    await frames(page);
    ok('the inspector gives a window’s size in millimetres', (await page.locator('.inspector [data-measure="size"]').textContent()) === '2,000 × 1,200 mm',
      await page.locator('.inspector [data-measure="size"]').textContent());
    const label = page.locator(`.labels .label[data-id="${studioWindow.id}"]`);
    ok('the selected window shows its size in the view', (await label.isVisible()) && (await label.textContent()) === '2000 × 1200', await label.textContent());
    const steps0 = (await state(page)).undo;
    await page.locator('.inspector [aria-label="Head"] [data-value="arched"]').click();
    await frames(page);
    let w2 = await node(page, studioWindow.id);
    ok('a window can have a rounded head, raised just enough for its arch', w2.shape === 'arched' && w2.height === 1.3 && (await state(page)).undo === steps0 + 1, w2);
    ok('the wall over a rounded window follows the arch', await page.evaluate(w => likuloka.world.entities.get(w).object.children.some(c => c.userData.part && c.geometry.type === 'ExtrudeGeometry'), id.backWall));
    await page.locator('.inspector select[aria-label="Frame"]').selectOption('upvc');
    w2 = await node(page, studioWindow.id);
    ok('a window frame can be timber, steel, aluminium or uPVC', w2.finish === 'upvc', w2.finish);
    const swing = () => page.evaluate(i => Math.max(...likuloka.world.entities.get(i).object.children.filter(c => c.userData.part).map(c => Math.abs(c.rotation.y))), studioWindow.id);
    ok('a closed window has its sash shut', (await swing()) === 0);
    await page.locator('.inspector [aria-label="Drawn"] [data-value="open"]').click();
    await frames(page);
    ok('an open window has its sash swung out', (await node(page, studioWindow.id)).state === 'open' && (await swing()) > 0.3);
    const tooLow = await page.evaluate(() => {
      const d = likuloka.getDoc();
      const o = Object.values(d.nodes).find(n => n.type === 'opening' && n.height < 0.8);
      return likuloka.commit(doc => likuloka.ops.updateOpening(doc, o.id, { shape: 'arched', height: o.height }), 'Round');
    });
    ok('a rounded opening too short for its arch is refused', !tooLow && /rounded/.test((await state(page)).error), (await state(page)).error);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    w2 = await node(page, studioWindow.id);
    ok('undo takes the options back one at a time', w2.shape === 'square' && w2.height === 1.2 && w2.finish === 'aluminium' && w2.state === 'closed', w2);

    await page.keyboard.press('m');
    await frames(page);
    const total = await page.evaluate(() => Object.values(likuloka.getDoc().nodes).filter(n => n.type === 'opening').length);
    ok('M measures every door and window', (await state(page)).measure && (await page.locator('.labels .label').count()) === total, await page.locator('.labels .label').count());
    await page.keyboard.press('m');
    await frames(page);
    ok('M again leaves only the selection measured', (await page.locator('.labels .label').count()) === 1);

    // ---- the schedule -------------------------------------------------------------------------
    await menu(page, 'schedule');
    const rowsShown = await page.locator('table[data-table="all"] tbody tr').count();
    const qty = await page.locator('table[data-table="types"] tbody tr td:first-child').allTextContents();
    ok('the schedule lists every door and window', rowsShown === total, { rowsShown, total });
    ok('the schedule groups openings into types to order', qty.reduce((a, b) => a + Number(b), 0) === total && qty.length < total, qty);
    const csv = await page.evaluate(() => likuloka.scheduleCsv());
    const lines = csv.trim().split(/\r?\n/);
    ok('the schedule downloads as CSV in millimetres, with products, frames and prices', lines.length === total + 1 && lines[0].startsWith('Ref,Type,Product,Description,Shape,Finish,Frame width (mm),Frame height (mm),Opening width (mm)')
      && lines.some(l => /^D\d\d,Door,D-TIM-ARCH-980,Timber arched entrance door,Rounded,Timber,980,2090,1000,2100,0,2100,150,1450,Two bedroom house,Ground floor,Closed$/.test(l)), lines.slice(0, 3));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="download-schedule"]').click()]);
    ok('the schedule’s CSV is offered as a file', /-schedule\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    await page.locator('table[data-table="all"] .ref', { hasText: 'W01' }).click();
    const w01 = await page.evaluate(() => likuloka.schedule().find(r => r.ref === 'W01').id);
    ok('a reference in the schedule selects that opening', (await state(page)).selection === w01 && !(await page.locator('dialog[aria-labelledby="schedule-title"]').evaluate(d => d.open)));

    // ---- inspector, delete and the cut -------------------------------------------------------
    await page.evaluate(i => likuloka.select(i), id.partition);
    await page.locator('.inspector .field', { hasText: 'Thickness' }).locator('input').fill('400');
    await page.locator('.inspector .field', { hasText: 'Thickness' }).locator('input').press('Enter');
    ok('the inspector edits the wall', (await node(page, id.partition)).thickness === 0.4);
    ok('the inspector gives a wall its length, thickness and height in millimetres, with no coordinates',
      (await page.locator('.inspector input[aria-label="Length"]').inputValue()) === '3500'
      && (await page.locator('.inspector input[aria-label="Thickness"]').inputValue()) === '400'
      && (await page.locator('.inspector .field', { hasText: /Start x|End y|Origin/ }).count()) === 0);
    await page.locator('.inspector input[aria-label="Length"]').fill('3000');
    await page.locator('.inspector input[aria-label="Length"]').press('Enter');
    const shortened = await node(page, id.partition);
    ok('typing a length moves the wall’s far end along it', shortened.a[1] === 0 && shortened.b[1] === 3 && shortened.b[0] === 4.5, shortened);
    await page.evaluate(() => likuloka.undo());
    await page.evaluate(i => likuloka.select(i), id.studioZone);
    ok('a room shows its size and area', (await page.locator('.inspector [data-measure="room"]').textContent()) === '4,500 × 3,500 mm'
      && (await page.locator('.inspector [data-measure="area"]').textContent()) === '15.75 m²');
    const studioDoor = await page.evaluate(w => likuloka.getDoc().nodes[w].children.map(c => likuloka.getDoc().nodes[c]).find(o => o.kind === 'door'), id.backWall);
    await page.evaluate(i => likuloka.select(i), studioDoor.id);
    const fromStart = await page.locator('.inspector input[aria-label="From wall start"]').inputValue();
    ok('a door is placed by its distance from the wall start, with the gap to the end shown',
      fromStart === String(Math.round((studioDoor.offset - studioDoor.width / 2) * 1000)) && (await page.locator('.inspector [data-measure="to-end"]').textContent()) === `${Math.round((6 - studioDoor.offset - studioDoor.width / 2) * 1000)} mm`, { fromStart, studioDoor });
    ok('a door has no sill field', (await page.locator('.inspector input[aria-label="Sill height"]').count()) === 0);
    await page.locator('.inspector input[aria-label="From wall start"]').fill('3500');
    await page.locator('.inspector input[aria-label="From wall start"]').press('Enter');
    ok('typing the distance moves the door', Math.abs((await node(page, studioDoor.id)).offset - (3.5 + studioDoor.width / 2)) < 0.07, await node(page, studioDoor.id));
    await page.evaluate(() => likuloka.undo());
    await page.evaluate(i => likuloka.select(i), id.partition);
    await page.keyboard.press('Delete');
    ok('Delete removes the selected node', !(await node(page, id.partition)));
    await page.keyboard.press('Control+z');
    ok('undo brings it back as it was', (await node(page, id.partition))?.thickness === 0.4);
    await page.keyboard.press('Control+z');
    const cut = (await state(page)).cut;
    await page.locator('[data-action="cut"]').click();
    ok('Cut walls toggles the section cut', (await state(page)).cut === !cut);
    await page.locator('[data-action="cut"]').click();

    // ---- import ----------------------------------------------------------------------------
    await menu(page, 'project');
    await page.locator('[data-action="import"]').click();
    await page.locator('dialog[aria-labelledby="import-title"] textarea').fill(JSON.stringify({ name: 'Small flat', width: 8, depth: 6.5, layout: { dir: 'row', children: [
      { size: 4.75, name: 'Living room', type: 'living' },
      { size: 3.25, dir: 'col', children: [{ size: 4, name: 'Bedroom', type: 'bedroom' }, { size: 2.5, name: 'Bathroom', type: 'bathroom' }] },
    ] } }));
    await page.locator('dialog[aria-labelledby="import-title"]').getByRole('button', { name: 'Import', exact: true }).click();
    await frames(page);
    const flat = await page.evaluate(() => { const d = likuloka.getDoc(); const b = d.nodes[d.roots[2]]; const l = d.nodes[b.children[0]]; return { name: b.name, origin: b.origin, kids: l.children.map(c => d.nodes[c].type) }; });
    ok('importing a nested Roomlines layout adds a building', flat.name === 'Small flat' && flat.kids.filter(t => t === 'zone').length === 3 && flat.kids.filter(t => t === 'wall').length === 6, flat);
    ok('the import is placed beside the others', flat.origin[0] > 15, flat.origin);
    ok('the dialog closes', !(await page.locator('dialog[aria-labelledby="import-title"]').evaluate(d => d.open)));
    await menu(page, 'project');
    await page.locator('[data-action="import"]').click();
    await page.locator('dialog[aria-labelledby="import-title"] textarea').fill('{ "rooms": [] }');
    await page.locator('dialog[aria-labelledby="import-title"]').getByRole('button', { name: 'Import', exact: true }).click();
    ok('a bad plan shows an error', (await page.locator('dialog[aria-labelledby="import-title"] .error').textContent()).length > 0);
    await page.locator('dialog[aria-labelledby="import-title"]').getByRole('button', { name: 'Cancel' }).click();


    // ---- catalogue and build-ups -------------------------------------------------------------
    const cat = await page.evaluate(() => { const c = likuloka.catalogue(); return { products: c.products.length, walls: c.wallTypes.length, problems: c.problems }; });
    ok('the catalogue file is read', cat.products === 15 && cat.walls === 4 && cat.problems.length === 0, cat);
    const sw = await page.evaluate(w => likuloka.getDoc().nodes[w].children.map(c => likuloka.getDoc().nodes[c]).find(o => o.kind === 'window'), id.backWall);
    await page.evaluate(i => likuloka.select(i), sw.id);
    await page.locator('.inspector select[aria-label="Product"]').selectOption('W-ALU-1980x1180');
    let pw = await node(page, sw.id);
    ok('choosing a product sets the opening for its frame plus the fitting gap', pw.product === 'W-ALU-1980x1180' && pw.width === 2 && pw.height === 1.2 && Math.abs(pw.sill - 0.89) < 1e-9, pw);
    ok('the inspector shows the frame size', (await page.locator('.inspector [data-measure="frame"]').textContent()) === '1,980 × 1,180 mm');
    const row = await page.evaluate(i => likuloka.schedule().find(r => r.id === i), sw.id);
    ok('the schedule has the product, its frame and its price', row.product === 'W-ALU-1980x1180' && row.frameWidth === 1980 && row.price === 560, row);
    await page.locator('.inspector .field', { hasText: 'Width' }).locator('input').fill('2100');
    await page.locator('.inspector .field', { hasText: 'Width' }).locator('input').press('Enter');
    pw = await node(page, sw.id);
    ok('changing a product’s size makes it a custom size', pw.product === null && Math.abs(pw.width - 2.1) < 1e-9, pw);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.evaluate(i => likuloka.select(i), id.partition);
    await page.locator('.inspector select[aria-label="Build-up"]').selectOption('WT-STUD-100');
    let pt = await node(page, id.partition);
    ok('a wall takes a build-up from the catalogue, and its thickness', pt.wallType === 'WT-STUD-100' && pt.layers.length === 3 && Math.abs(pt.thickness - 0.1) < 1e-9, pt);
    ok('the inspector lists the layers', (await page.locator('.inspector .layers li').count()) === 3);
    await page.locator('.inspector .field', { hasText: 'Thickness' }).locator('input').fill('200');
    await page.locator('.inspector .field', { hasText: 'Thickness' }).locator('input').press('Enter');
    pt = await node(page, id.partition);
    ok('typing a thickness makes the wall plain', pt.wallType === null && pt.layers.length === 0 && pt.thickness === 0.2, pt);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');

    await menu(page, 'project');
    await page.getByLabel('Fitting gap').fill('15');
    await page.getByLabel('Fitting gap').press('Enter');
    ok('the fitting gap changes every frame size', (await page.evaluate(() => likuloka.getDoc().settings.tolerance)) === 0.015
      && (await page.evaluate(i => likuloka.schedule().find(r => r.id === i).frameWidth, sw.id)) === 1970);
    await page.locator('dialog[aria-labelledby="project-title"]').getByRole('button', { name: 'Close' }).click();
    await page.evaluate(() => likuloka.undo());
    ok('undo puts the fitting gap back', (await page.evaluate(() => likuloka.getDoc().settings.tolerance)) === 0.01);

    // ---- checks -------------------------------------------------------------------------------
    const found = await page.evaluate(() => likuloka.checks().map(i => i.rule));
    ok('the checks find narrow doors, a room without a door and long lintels', ['door-width', 'no-door', 'lintel-span', 'daylight'].every(r => found.includes(r)), found);
    ok('the status bar counts the warnings', /\d+ warnings/.test(await page.locator('[data-action="checks-count"]').textContent()));
    await menu(page, 'checks');
    const firstIssue = await page.evaluate(() => likuloka.checks()[0]);
    await page.locator('.issues li button').first().click();
    ok('clicking an issue selects what it is about', (await state(page)).selection === firstIssue.node);
    ok('the inspector shows that node’s issues', (await page.locator('.inspector .issues li').count()) >= 1);
    const fixedDoor = await page.evaluate(() => {
      const issue = likuloka.checks().find(i => i.rule === 'door-width');
      likuloka.commit(d => likuloka.ops.updateOpening(d, issue.node, { width: 0.92 }), 'Widen');
      const still = likuloka.checks().some(i => i.key === issue.key);
      likuloka.undo();
      return !still;
    });
    ok('widening a door clears its warning', fixedDoor);

    // ---- client view ------------------------------------------------------------------------------
    await menu(page, 'project');
    await page.locator('[data-action="client-view"]').click();
    await page.locator('dialog[aria-labelledby="project-title"]').getByRole('button', { name: 'Close' }).click();
    ok('a designer can preview the client view', (await page.evaluate(() => likuloka.role())).kind === 'client' && (await page.locator('.bar .badge').isVisible()));
    ok('the client view has no drawing tools', (await page.locator('[data-tool="wall"]').count()) === 0);
    await page.keyboard.press('w');
    ok('and the tool keys do nothing', (await state(page)).tool === 'select');
    const refusedMove = await page.evaluate(i => likuloka.commit(d => likuloka.ops.offsetWall(d, i, 0.5), 'Move'), id.partition);
    ok('a client cannot move a wall', !refusedMove && /client view/.test((await state(page)).error));
    const z = await page.evaluate(i => likuloka.getDoc().nodes[i].use, id.studioZone);
    ok('a client can change a room’s use', await page.evaluate(i => likuloka.commit(d => likuloka.ops.updateZone(d, i, { use: 'office' }), 'Use'), id.studioZone));
    ok('a client can choose a product', await page.evaluate(i => { const p = likuloka.catalogue().products.find(x => x.code === 'W-ALU-1980x1180'); return likuloka.commit(d => likuloka.ops.updateOpening(d, i, { kind: p.kind, width: 2, height: 1.2, sill: 0.89, product: p.code }), 'Product'); }, sw.id));
    const custom = await page.evaluate(i => likuloka.commit(d => likuloka.ops.updateOpening(d, i, { width: 1.7 }), 'Size'), sw.id);
    ok('a client cannot type a custom size', !custom && /catalogue/.test((await state(page)).error), (await state(page)).error);
    await page.evaluate(i => likuloka.select(i), id.partition);
    ok('walls are shown to a client but locked', await page.locator('.inspector[data-locked="true"] fieldset[disabled]').count() > 0);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Delete');
    ok('a client cannot delete', !!(await node(page, id.partition)));
    await page.evaluate(() => { likuloka.undo(); likuloka.undo(); });
    ok('a client’s changes undo', (await page.evaluate(i => likuloka.getDoc().nodes[i].use, id.studioZone)) === z);
    await menu(page, 'project');
    await page.locator('[data-action="designer-view"]').click();
    await page.locator('dialog[aria-labelledby="project-title"]').getByRole('button', { name: 'Close' }).click();
    ok('and back to the designer view', (await page.evaluate(() => likuloka.role())).kind === 'designer');

    // ---- versions in the browser ---------------------------------------------------------------
    await menu(page, 'versions');
    const vdlg = page.locator('dialog[aria-labelledby="versions-title"]');
    await vdlg.getByLabel('Your name').fill('Dana Designer');
    await vdlg.getByLabel('Version note').fill('First design');
    await vdlg.locator('[data-action="save-version"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.versions li').length === 1);
    ok('a version is saved with a note and author', (await page.locator('.versions li').first().textContent()).includes('First design · Dana Designer'));
    await vdlg.getByRole('button', { name: 'Close' }).click();
    await page.evaluate(i => likuloka.commit(d => likuloka.ops.updateOpening(d, i, { finish: 'steel' }), 'Steel'), sw.id);
    await page.evaluate(i => likuloka.commit(d => likuloka.ops.updateWall(d, i, { thickness: 0.3 }), 'Thick'), id.partition);
    await menu(page, 'versions');
    await vdlg.locator('[data-action="compare"]').click();
    const changes = await page.locator('.versions [data-changes]').textContent();
    ok('compare lists the schedule and building changes since a version, and nothing else', /Frame Aluminium → Steel/.test(changes) && /Building: 1 wall changed$/.test(changes), changes);
    await vdlg.locator('[data-action="approve"]').click();
    ok('approval needs the box ticked', await vdlg.locator('[data-action="confirm-approve"]').isDisabled());
    await vdlg.locator('.approve input[type="checkbox"]').check();
    await vdlg.locator('[data-action="confirm-approve"]').click();
    await page.waitForFunction(() => !!document.querySelector('.versions [data-approval]'));
    ok('a version is approved by name', (await page.locator('.versions [data-approval]').textContent()).startsWith('Approved by Dana Designer'));
    ok('an approved version cannot be deleted', (await page.locator('.versions [data-action="delete-version"]').count()) === 0);
    await vdlg.locator('[data-action="restore"]').click();
    ok('restoring a version brings its design back as one undo step', (await node(page, sw.id)).finish === 'aluminium' && (await node(page, id.partition)).thickness === 0.15);
    await page.evaluate(() => likuloka.undo());
    ok('and it undoes', (await node(page, sw.id)).finish === 'steel');
    await page.evaluate(() => { likuloka.undo(); likuloka.undo(); });

    // ---- drawings and IFC ------------------------------------------------------------------------
    const sheets = await page.evaluate(() => likuloka.drawings().map(s => ({ id: s.id, svg: s.svg })));
    const withOpenings = await page.evaluate(() => Object.values(likuloka.getDoc().nodes).filter(n => n.type === 'wall' && n.children.length).length);
    const levelsCount = await page.evaluate(() => Object.values(likuloka.getDoc().nodes).filter(n => n.type === 'level').length);
    ok('drawings have a plan per level and the wall elevations, two to a sheet', sheets.length === levelsCount + Math.ceil(withOpenings / 2), { sheets: sheets.length, levelsCount, withOpenings });
    ok('plans carry door and window tags, dimensions and a title block', /data-tag="D01"/.test(sheets[0].svg) && /data-part="dimension"/.test(sheets[0].svg) && /Scale 1:\d+ at A3/.test(sheets[0].svg));
    ok('elevations give opening sizes and frames', sheets.some(sh => /frame 1480 × 1180/.test(sh.svg)));
    await menu(page, 'drawings');
    ok('the drawings dialog shows every sheet', (await page.locator('.sheets li').count()) === sheets.length);
    const [svgFile] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="download-svg"]').first().click()]);
    ok('a sheet downloads as SVG', /\.svg$/.test(svgFile.suggestedFilename()), svgFile.suggestedFilename());
    await page.locator('dialog[aria-labelledby="drawings-title"]').getByRole('button', { name: 'Close' }).click();

    // DXF for AutoCAD and other CAD programs.
    const DxfParser = require('dxf-parser');
    const dxfText = await page.evaluate(() => likuloka.dxf());
    const dxf = new DxfParser().parseSync(dxfText);
    const onLayer = l => dxf.entities.filter(e => e.layer === l).length;
    const dxfLayers = Object.keys(dxf.tables.layer.layers);
    ok('the DXF opens in a DXF parser, in millimetres', dxf.header.$ACADVER === 'AC1009' && dxf.header.$INSUNITS === 4, dxf.header);
    ok('the DXF has the plan on named layers', ['A-WALL', 'A-DOOR', 'A-GLAZ', 'A-AREA-IDEN', 'A-ANNO-DIMS', 'A-ANNO-TAGS'].every(l => dxfLayers.includes(l) && onLayer(l) > 0), dxfLayers);
    ok('the DXF has a swing for every door and a tag for every opening', dxf.entities.filter(e => e.type === 'ARC').length === await page.evaluate(() => Object.values(likuloka.getDoc().nodes).filter(n => n.type === 'opening' && n.kind === 'door').length)
      && dxf.entities.filter(e => e.type === 'TEXT' && /^[DW]\d\d$/.test(e.text)).length === await page.evaluate(() => Object.values(likuloka.getDoc().nodes).filter(n => n.type === 'opening').length));
    const studioWidth = dxf.entities.find(e => e.type === 'TEXT' && e.layer === 'A-AREA-IDEN' && e.text === '4500 x 3500');
    ok('rooms are labelled with their size in millimetres', !!studioWidth);
    const dxfWalls = dxf.entities.filter(e => e.layer === 'A-WALL' && e.type === 'POLYLINE');
    const xs = dxfWalls.flatMap(e => e.vertices.map(v => v.x));
    ok('the DXF is drawn at true size, with closed wall outlines', Math.round(Math.max(...xs) - Math.min(...xs)) > 11000 * 2 && dxfWalls.every(e => e.shape), { span: Math.max(...xs) - Math.min(...xs) });
    const oneLevel = await page.evaluate(i => likuloka.dxf([i]), id.studioLevel);
    ok('one level can be exported on its own', new DxfParser().parseSync(oneLevel).entities.filter(e => e.type === 'ARC').length === 1);
    await menu(page, 'drawings');
    const [dxfDownload] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="download-dxf"]').first().click()]);
    ok('each plan in the drawings downloads as DXF', /\.dxf$/.test(dxfDownload.suggestedFilename()), dxfDownload.suggestedFilename());
    await page.locator('dialog[aria-labelledby="drawings-title"]').getByRole('button', { name: 'Close' }).click();

    const ifc = await page.evaluate(() => likuloka.ifc());
    const WebIFC = require('web-ifc');
    const api = new WebIFC.IfcAPI();
    await api.Init();
    const model = api.OpenModel(new TextEncoder().encode(ifc));
    const count = t => api.GetLineIDsWithType(model, t).size();
    const docCounts = await page.evaluate(() => { const n = Object.values(likuloka.getDoc().nodes); const c = t => n.filter(x => x.type === t).length; return { walls: c('wall'), doors: n.filter(x => x.type === 'opening' && x.kind === 'door').length, windows: n.filter(x => x.type === 'opening' && x.kind === 'window').length, slabs: c('slab'), zones: c('zone'), levels: c('level') }; });
    ok('the IFC file opens in web-ifc with every element', count(WebIFC.IFCWALL) === docCounts.walls && count(WebIFC.IFCDOOR) === docCounts.doors && count(WebIFC.IFCWINDOW) === docCounts.windows
      && count(WebIFC.IFCOPENINGELEMENT) === docCounts.doors + docCounts.windows && count(WebIFC.IFCSLAB) === docCounts.slabs && count(WebIFC.IFCSPACE) === docCounts.zones && count(WebIFC.IFCBUILDINGSTOREY) === docCounts.levels, docCounts);
    let meshes = 0;
    api.StreamAllMeshes(model, () => { meshes++; });
    ok('its geometry builds', meshes >= docCounts.walls + docCounts.doors + docCounts.windows);
    api.CloseModel(model);
    const gids = [...ifc.matchAll(/IFC[A-Z]+\('([0-9A-Za-z_$]{22})',#/g)].map(m => m[1]);
    ok('its GlobalIds are unique, and the same on every export', new Set(gids).size === gids.length && (await page.evaluate(() => likuloka.ifc())).includes(gids[0]));

    // ---- persistence -------------------------------------------------------------------------
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForFunction(() => window.likuloka && document.documentElement.dataset.backend !== 'starting', null, { timeout: 60000 });
    ok('the scene is kept across a reload', await page.evaluate(() => likuloka.getDoc().roots.length === 3));

    // ---- projects ------------------------------------------------------------------------------
    const nameBox = page.locator('.bar .project-name');
    await nameBox.fill('Beach house');
    await nameBox.press('Enter');
    let st = await state(page);
    ok('the project can be named, as an undo step', st.project.name === 'Beach house' && st.undo >= 1, st.project);
    ok('a new project starts unsaved', st.project.unsaved && (await page.locator('[data-action="save"]').textContent()) === 'Save');
    await page.keyboard.press('Control+s');
    st = await state(page);
    ok('Ctrl+S saves the project', !st.project.unsaved && (await page.locator('[data-action="save"]').textContent()) === 'Saved', st.project);
    let list = await page.evaluate(() => likuloka.projects.list());
    ok('a saved project is listed by name', list.length === 1 && list[0].name === 'Beach house' && list[0].id === st.project.id, list);
    await page.evaluate(i => likuloka.commit(d => likuloka.ops.updateWall(d, i, { thickness: 0.25 }), 'Thicken'), id.partition);
    ok('an edit makes the project unsaved', (await state(page)).project.unsaved);
    await page.keyboard.press('Control+z');
    ok('undoing back to the saved state makes it saved again', !(await state(page)).project.unsaved);
    const savedId = st.project.id;

    await menu(page, 'project');
    await page.locator('[data-action="new-blank"]').click();
    await frames(page);
    st = await state(page);
    const blank = await page.evaluate(() => { const d = likuloka.getDoc(); return { roots: d.roots.length, levels: d.nodes[d.roots[0]].children.length }; });
    ok('a new blank project has one building and a ground floor', blank.roots === 1 && blank.levels === 1 && st.project.id !== savedId && st.project.name === 'Untitled project', { blank, project: st.project });
    await menu(page, 'project');
    await page.locator(`.projects li[data-project="${savedId}"] button`, { hasText: 'Open' }).click();
    await frames(page);
    st = await state(page);
    ok('a saved project opens again as it was saved', st.project.id === savedId && st.project.name === 'Beach house' && !st.project.unsaved && (await page.evaluate(() => likuloka.getDoc().roots.length)) === 3, st.project);

    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForFunction(() => window.likuloka && document.documentElement.dataset.backend !== 'starting', null, { timeout: 60000 });
    st = await state(page);
    ok('a saved project is still saved after a reload', st.project.id === savedId && st.project.name === 'Beach house' && !st.project.unsaved, st.project);

    const text = await page.evaluate(() => likuloka.projects.file());
    ok('a project downloads as a file with its name', JSON.parse(text).format === 'likuloka3d' && JSON.parse(text).doc.name === 'Beach house');
    await menu(page, 'project');
    const [pf] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="download-project"]').click()]);
    ok('the project file is named after the project', pf.suggestedFilename() === 'beach-house.likuloka.json', pf.suggestedFilename());
    await page.locator('dialog[aria-labelledby="project-title"]').getByRole('button', { name: 'Close' }).click();
    const reopened = await page.evaluate(t => { likuloka.projects.openFile(t); const s = likuloka.getState(); return { name: s.project.name, unsaved: s.project.unsaved, count: Object.keys(likuloka.getDoc().nodes).length }; }, text);
    ok('a project file opens as a new unsaved copy', reopened.name === 'Beach house' && reopened.unsaved && reopened.count === Object.keys(JSON.parse(text).doc.nodes).length, reopened);

    const old = await page.evaluate(() => {
      // A scene from before openings had options and before projects had names.
      const scene = { nodes: {
        b: { id: 'b', type: 'building', parent: null, name: 'Old', children: ['l'], origin: [0, 0] },
        l: { id: 'l', type: 'level', parent: 'b', name: 'Ground', children: ['w'], elevation: 0, height: 3 },
        w: { id: 'w', type: 'wall', parent: 'l', name: 'Wall', children: ['o'], a: [0, 0], b: [4, 0], thickness: 0.2, height: 3 },
        o: { id: 'o', type: 'opening', parent: 'w', name: 'Door', kind: 'door', offset: 2, width: 1, height: 2.1, sill: 0 },
      }, roots: ['b'] };
      const ok = likuloka.projects.openFile(JSON.stringify(scene));
      const o = likuloka.getDoc().nodes.o;
      return { ok, name: likuloka.getDoc().name, o };
    });
    ok('scenes from older versions still open', old.ok && old.name === 'Untitled project' && old.o.shape === 'square' && old.o.finish === 'timber' && old.o.state === 'closed', old);
    ok('a broken file is refused with a message', !(await page.evaluate(() => likuloka.projects.openFile('{"nodes":{}}'))) && !!(await state(page)).error);

    await page.evaluate(i => likuloka.projects.remove(i), savedId);
    ok('a project can be deleted from the browser', (await page.evaluate(() => likuloka.projects.list())).length === 0);

    // ---- Roomlines plans arrive whole: every built-in layout, and a shaped one
    const layouts = [
      { name: 'Studio', width: 6, depth: 5.5, layout: { dir: 'col', children: [{ size: 3.5, name: 'Studio room', type: 'studio' }, { size: 2, dir: 'row', children: [{ size: 2.75, name: 'Kitchen', type: 'kitchen' }, { size: 1.5, name: 'Entry', type: 'hallway' }, { size: 1.75, name: 'Bathroom', type: 'bathroom' }] }] } },
      { name: 'One bedroom', width: 8, depth: 6.5, layout: { dir: 'row', children: [{ size: 4.75, dir: 'col', children: [{ size: 4.5, name: 'Living room', type: 'living' }, { size: 2, name: 'Kitchen', type: 'kitchen' }] }, { size: 3.25, dir: 'col', children: [{ size: 3.5, name: 'Bedroom', type: 'bedroom' }, { size: 1.25, name: 'Hallway', type: 'hallway' }, { size: 1.75, name: 'Bathroom', type: 'bathroom' }] }] } },
      { name: 'Two bedroom', width: 10, depth: 7.75, layout: { dir: 'row', children: [{ size: 5.5, dir: 'col', children: [{ size: 4.5, name: 'Living room', type: 'living' }, { size: 3.25, name: 'Kitchen', type: 'kitchen' }] }, { size: 1.25, name: 'Hallway', type: 'hallway' }, { size: 3.25, dir: 'col', children: [{ size: 3.25, name: 'Main bedroom', type: 'bedroom' }, { size: 1.75, name: 'Bathroom', type: 'bathroom' }, { size: 2.75, name: 'Bedroom 2', type: 'bedroom' }] }] } },
      { name: 'Family house', width: 12, depth: 10, layout: { dir: 'row', children: [{ size: 6.5, dir: 'col', children: [{ size: 5.5, name: 'Living room', type: 'living' }, { size: 4.5, dir: 'row', children: [{ size: 3.75, name: 'Kitchen', type: 'kitchen' }, { size: 2.75, name: 'Dining room', type: 'dining' }] }] }, { size: 1.5, name: 'Hallway', type: 'hallway' }, { size: 4, dir: 'col', children: [{ size: 3.5, name: 'Main bedroom', type: 'bedroom' }, { size: 1.75, name: 'Bathroom', type: 'bathroom' }, { size: 2.5, name: 'Bedroom 2', type: 'bedroom' }, { size: 2.25, name: 'Office', type: 'office' }] }] } },
      { name: 'Shaped', plot: [[-3, -3], [14, -1], [13, 12], [-4, 10]], rooms: [
        { name: 'Living room', type: 'living', points: [[0, 0], [7, 0], [8.5, 2.5], [7, 5], [0, 5]], floor: 'walnut', paint: '#3d4a5c' },
        { name: 'Kitchen', type: 'kitchen', points: [[0, 5], [4, 5], [4, 8.5], [1, 8.5]] },
        { name: 'Bedroom', type: 'bedroom', points: [[4, 5], [7, 5], [9, 8.5], [4, 8.5]] },
        { name: 'Bathroom', type: 'bathroom', points: [[7, 5], [8.5, 2.5], [11, 4], [9.5, 6.5], [8, 6.5]] }] },
    ];
    const rooms = [4, 5, 6, 8, 4];
    for (const [i, plan] of layouts.entries()) {
      const r = await page.evaluate(plan => {
        likuloka.reset(); const before = likuloka.getDoc().roots.length;
        if (!likuloka.importRoomlines(plan, { openings: true })) return { error: likuloka.getState().error };
        const d = likuloka.getDoc(), b = d.nodes[d.roots[before]], l = d.nodes[b.children[0]], kids = l.children.map(c => d.nodes[c]);
        const walls = kids.filter(n => n.type === 'wall'), ops = walls.flatMap(w => w.children.map(c => d.nodes[c]));
        const slanted = walls.filter(w => w.a[0] !== w.b[0] && w.a[1] !== w.b[1]).length;
        return { zones: kids.filter(n => n.type === 'zone').length, slab: kids.filter(n => n.type === 'slab').map(s => s.points.length), walls: walls.length, slanted, doors: ops.filter(o => o.kind === 'door').length, windows: ops.filter(o => o.kind === 'window').length,
          noDoor: likuloka.checks().filter(c => c.node && d.nodes[c.node] && d.nodes[c.node].parent === l.id && c.rule === 'no-door').length };
      }, plan);
      await frames(page);
      ok(`Roomlines "${plan.name}" imports with its rooms, a slab, doors and windows`, !r.error && r.zones === rooms[i] && r.slab.length === 1 && r.slab[0] >= 4 && r.doors >= rooms[i] && r.windows >= rooms[i] - 2 && r.noDoor === 0 && (await page.evaluate(() => Object.keys(likuloka.getDoc().nodes).every(n => likuloka.world.entities.has(n)))), r);
      if (plan.rooms) ok('a shaped Roomlines plan keeps its slanted walls', r.slanted >= 5 && r.slab[0] >= 7, r);
    }
    await page.evaluate(() => likuloka.reset());
    await frames(page);

    ok('no page errors', errors.length === 0, errors.slice(0, 5));
  } catch (e) {
    ok('the run finished', false, String(e && e.stack || e));
  }
  await context.close();

  // ---- phone width -----------------------------------------------------------------------------
  {
    const { page: phone, context: c, errors } = await open(browser, url, { width: 400, height: 800 });
    const layout = await phone.evaluate(() => {
      const stage = document.querySelector('.stage').getBoundingClientRect();
      return { scroll: document.documentElement.scrollWidth, stage: { w: stage.width, h: stage.height } };
    });
    ok('on a phone the page does not scroll sideways', layout.scroll <= 400, layout);
    ok('on a phone the 3D view keeps a usable size', layout.stage.w >= 360 && layout.stage.h >= 380, layout);
    ok('no page errors on a phone', errors.length === 0, errors.slice(0, 5));
    await c.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
