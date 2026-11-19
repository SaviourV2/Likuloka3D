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
    };
  });
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
    ok('sliding a wall moves it and stretches the two walls joined to it, nothing else', stats.last.ids.length === 3 && stats.last.ids.includes(id.leftWall) && stats.updates.zone === 0, stats.last);
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

    // ---- inspector, delete and the cut -------------------------------------------------------
    await page.evaluate(i => likuloka.select(i), id.partition);
    await page.locator('.inspector .field', { hasText: 'Thickness' }).locator('input').fill('0.4');
    await page.locator('.inspector .field', { hasText: 'Thickness' }).locator('input').press('Enter');
    ok('the inspector edits the wall', (await node(page, id.partition)).thickness === 0.4);
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
    await page.getByRole('button', { name: 'Import plan' }).click();
    await page.locator('dialog textarea').fill(JSON.stringify({ name: 'Small flat', width: 8, depth: 6.5, layout: { dir: 'row', children: [
      { size: 4.75, name: 'Living room', type: 'living' },
      { size: 3.25, dir: 'col', children: [{ size: 4, name: 'Bedroom', type: 'bedroom' }, { size: 2.5, name: 'Bathroom', type: 'bathroom' }] },
    ] } }));
    await page.locator('dialog').getByRole('button', { name: 'Import' }).click();
    await frames(page);
    const flat = await page.evaluate(() => { const d = likuloka.getDoc(); const b = d.nodes[d.roots[2]]; const l = d.nodes[b.children[0]]; return { name: b.name, origin: b.origin, kids: l.children.map(c => d.nodes[c].type) }; });
    ok('importing a nested Roomlines layout adds a building', flat.name === 'Small flat' && flat.kids.filter(t => t === 'zone').length === 3 && flat.kids.filter(t => t === 'wall').length === 6, flat);
    ok('the import is placed beside the others', flat.origin[0] > 15, flat.origin);
    ok('the dialog closes', !(await page.locator('dialog').evaluate(d => d.open)));
    await page.getByRole('button', { name: 'Import plan' }).click();
    await page.locator('dialog textarea').fill('{ "rooms": [] }');
    await page.locator('dialog').getByRole('button', { name: 'Import' }).click();
    ok('a bad plan shows an error', (await page.locator('dialog .error').textContent()).length > 0);
    await page.locator('dialog').getByRole('button', { name: 'Cancel' }).click();

    // ---- persistence -------------------------------------------------------------------------
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForFunction(() => window.likuloka && document.documentElement.dataset.backend !== 'starting', null, { timeout: 60000 });
    ok('the scene is kept across a reload', await page.evaluate(() => likuloka.getDoc().roots.length === 3));

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
