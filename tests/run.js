// Browser tests for the Roomlines planner. Run with: npm test
// The page's CDN scripts are served from node_modules, so the tests need no network.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const lib = f => fs.readFileSync(path.join(__dirname, 'node_modules', f), 'utf8');
const SCRIPTS = [
  ['xstate.umd.min.js', lib('xstate/dist/xstate.umd.min.js')],
  ['three.min.js', lib('three/build/three.min.js')],
  ['GLTFLoader.js', lib('three/examples/js/loaders/GLTFLoader.js')],
  ['GLTFExporter.js', lib('three/examples/js/exporters/GLTFExporter.js')],
  ['pdf.min.js', lib('pdfjs-dist/build/pdf.min.js')],
  ['pdf.worker.min.js', lib('pdfjs-dist/build/pdf.worker.min.js')],
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roomlines-'));
let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`);
}

// A stand-in for Claude. `window.__delay` makes a call slow, so tests can interrupt it.
function fakeClaude() {
  window.__calls = [];
  const wait = (ms, signal) => new Promise((ok, no) => { const t = setTimeout(ok, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); no({ code: 'cancelled' }); }); });
  const fn = async () => ({ text: '' });
  fn.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 2e7, mediaTypes: ['image/jpeg'] } });
  fn.json = async (prompt, o = {}) => {
    window.__calls.push({ image: !!o.images, type: o.images ? o.images.type : '', tier: o.modelTier || 'default' });
    await wait(window.__delay || 0, o.signal);
    if (o.onText) o.onText({ text: '{', delta: '{' });
    if (window.__fail) throw { code: window.__fail };
    if (o.images && /says this is land/.test(prompt)) return { kind: 'land', name: 'Lot 7', image_width_m: 39.7, plot: [[0.18, 0.16], [0.83, 0.16], [0.83, 0.69], [0.18, 0.69]], house: { x: 0.3, y: 0.3, width: 10, depth: 7.75, layout: { dir: 'row', children: [{ size: 5.5, dir: 'col', children: [{ size: 4.5, name: 'Living room', type: 'living' }, { size: 3.25, name: 'Kitchen', type: 'kitchen' }] }, { size: 1.25, name: 'Hallway', type: 'hallway' }, { size: 3.25, dir: 'col', children: [{ size: 3.25, name: 'Bedroom 1', type: 'bedroom' }, { size: 1.75, name: 'Bathroom', type: 'bathroom' }, { size: 2.75, name: 'Bedroom 2', type: 'bedroom' }] }] } } };
    const j = v => v + (Math.random() - 0.5) * 0.02; // a reading is never pixel-exact; this stays inside what the grid absorbs
    if (o.images) return { kind: 'floorplan', name: 'Uploaded flat', image_width_m: 10, rooms: [['Living', 'living', 0, 0, .55, .58], ['Kitchen', 'kitchen', 0, .58, .55, 1], ['Hall', 'hallway', .55, 0, .675, 1], ['Bed 1', 'bedroom', .675, 0, 1, .42], ['Bath', 'bathroom', .675, .42, 1, .645], ['Bed 2', 'bedroom', .675, .645, 1, 1]].map(([name, type, a, b, c, d]) => ({ name, type, box: [j(a), j(b), j(c), j(d)] })) };
    return { name: 'Described', width: 8, depth: 6, layout: { dir: 'row', children: [{ size: 5, name: 'Living', type: 'living' }, { size: 3, name: 'Bedroom', type: 'bedroom' }] } };
  };
  window.claude = { use: async n => (n === 'sample' ? fn : null) };
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

  // fixtures: a floor plan image that is exactly 10 x 7.75 m, a three-page PDF, a CAD file, a saved plan
  const fx = await browser.newPage();
  const png = await fx.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1000; c.height = 775;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1000, 775); g.strokeStyle = '#000'; g.lineWidth = 8;
    for (const [x, y, w, h] of [[0, 0, 550, 450], [0, 450, 550, 325], [550, 0, 125, 775], [675, 0, 325, 325], [675, 325, 325, 175], [675, 500, 325, 275]]) g.strokeRect(x + 4, y + 4, w - 8, h - 8);
    return c.toDataURL('image/png').split(',')[1];
  });
  const F = { png: path.join(tmp, 'plan.png'), pdf: path.join(tmp, 'land.pdf'), dwg: path.join(tmp, 'site.dwg'), json: path.join(tmp, 'saved.json') };
  fs.writeFileSync(F.png, Buffer.from(png, 'base64'));
  await fx.setContent('<svg width="600" height="800" viewBox="0 0 30 40"><polygon points="3,4 27,4 27,36 3,36" fill="none" stroke="black" stroke-width="0.3"/></svg><div style="page-break-before:always">Page two</div><div style="page-break-before:always">Page three</div>');
  await fx.pdf({ path: F.pdf, format: 'A4' }); await fx.close();
  fs.writeFileSync(F.dwg, 'x');
  fs.writeFileSync(F.json, JSON.stringify({ name: 'Saved', rooms: [{ name: 'Lounge', x: 0, y: 0, w: 5, h: 4 }, { name: 'Bedroom', x: 5, y: 0, w: 3, h: 4 }], plot: [[-3, -3], [12, -3], [12, 9], [-3, 9]] }));

  async function open({ claude = false, viewport = { width: 1400, height: 900 }, block = [] } = {}) {
    const ctx = await browser.newContext({ viewport }), page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => {
      const u = r.request().url();
      if (block.some(b => u.includes(b))) return r.abort();
      if (u.startsWith('file:')) return r.continue();
      const hit = SCRIPTS.find(([f]) => u.endsWith(f));
      return hit ? r.fulfill({ contentType: 'application/javascript', body: hit[1] }) : r.abort();
    });
    if (claude) await page.addInitScript(fakeClaude);
    await page.goto(PAGE); await page.waitForTimeout(600);
    return { page, errors, close: () => ctx.close() };
  }
  const machines = page => page.evaluate(() => window.roomlines.getState().machines);
  const attrs = page => page.evaluate(() => ({ ...document.querySelector('.wrap').dataset }));
  const rooms = page => page.evaluate(() => window.roomlines.getPlan().rooms.map(r => `${r.name} ${r.x},${r.y} ${r.w}x${r.h}`));
  const status = page => page.textContent('#fileStatus');
  const until = (page, machine, value) => page.waitForFunction(([m, v]) => window.roomlines.getState().machines[m] === v, [machine, value], { timeout: 8000 });

  // ---------- 1. editing the plan (no Claude, as on any website)
  {
    const { page, errors, close } = await open();
    await until(page, 'models', 'ready');
    const REST = JSON.stringify({ tool: 'idle', drawing: 'empty', describe: 'unavailable', read: 'unavailable', models: 'ready' });
    check('starts with every machine at rest', JSON.stringify(await machines(page)) === REST, await machines(page));
    check('machine states are mirrored on the page', JSON.stringify(await attrs(page)) === REST, await attrs(page));
    check('Claude cards are hidden without Claude', await page.locator('#askCard').isHidden() && await page.locator('#readBox').isHidden());

    const box = await page.locator('[data-room]').nth(5).boundingBox(), ppm = box.width / 3.25;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    check('clicking a room selects it and opens the editor', await page.inputValue('#edName') === 'Bedroom 2' && await page.locator('#editor').isVisible());

    const h = await page.locator('[data-handle="se"]').boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + ppm, h.y + h.height / 2 + ppm * 0.5, { steps: 6 });
    check('dragging a handle puts the tool in "resizing"', (await machines(page)).tool === 'resizing');
    await page.mouse.up();
    check('releasing commits the resize and returns to idle', (await rooms(page))[5] === 'Bedroom 2 6.75,5 4.25x3.25' && (await machines(page)).tool === 'idle', (await rooms(page))[5]);

    const b2 = await page.locator('[data-room]').nth(5).boundingBox();
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2); await page.mouse.down();
    await page.mouse.move(b2.x + b2.width / 2 + ppm * 0.5, b2.y + b2.height / 2, { steps: 5 });
    check('dragging a room puts the tool in "moving"', (await machines(page)).tool === 'moving');
    await page.mouse.up();
    check('releasing commits the move', (await rooms(page))[5] === 'Bedroom 2 7.25,5 4.25x3.25', (await rooms(page))[5]);

    const b3 = await page.locator('[data-room]').nth(5).boundingBox();
    await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2); await page.mouse.down();
    await page.mouse.move(b3.x + b3.width / 2 - ppm * 2, b3.y + b3.height / 2 - ppm, { steps: 5 });
    const mid = (await rooms(page))[5];
    await page.keyboard.press('Escape');
    check('Escape cancels a drag and puts the room back', mid !== 'Bedroom 2 7.25,5 4.25x3.25' && (await rooms(page))[5] === 'Bedroom 2 7.25,5 4.25x3.25' && (await machines(page)).tool === 'idle', [mid, (await rooms(page))[5]]);
    await page.mouse.up();

    await page.fill('#edName', 'Guest room'); await page.fill('#edW', '3'); await page.locator('#edW').blur(); await page.selectOption('#edType', 'office');
    check('editor fields change the room', (await rooms(page))[5] === 'Guest room 7.25,5 3x3.25' && await page.evaluate(() => window.roomlines.getPlan().rooms[5].type) === 'office', (await rooms(page))[5]);
    await page.click('#addRoom'); const added = (await rooms(page)).length; await page.click('#delRoom');
    check('add and delete a room', added === 7 && (await rooms(page)).length === 6);

    await page.click('#dataBox summary');
    await page.fill('#jsonBox', '{"name":"T","rooms":[{"name":"Lounge","x":0,"y":0,"w":5,"h":4},{"name":"Bath","x":5,"y":0,"w":2,"h":2},{"name":"Bedroom","x":5,"y":2,"w":3,"h":3}]}');
    await page.click('#jsonLoad');
    check('a pasted plan loads', (await rooms(page)).join('; ') === 'Lounge 0,0 5x4; Bath 5,0 2x2; Bedroom 5,2 3x3', await rooms(page));
    await page.fill('#jsonBox', '{oops'); await page.click('#jsonLoad');
    check('bad JSON is explained', /not valid JSON/.test(await page.textContent('#jsonStatus')));

    const sane = await page.evaluate(() => { const R = window.__roomlines; return R.PRESETS.map(p => { const plan = R.normalizePlan(p), an = R.analyze(plan), f = R.furnish(plan, an), ops = an.pieces.flatMap(x => x.openings.map(o => o.kind)); const b = { x: Math.max(...plan.rooms.map(r => r.x + r.w)), y: Math.max(...plan.rooms.map(r => r.y + r.h)) }; return { doors: ops.filter(o => o === 'door' || o === 'open').length >= plan.rooms.length - 1, entry: ops.filter(o => o === 'entry').length === 1, furniture: f.length >= plan.rooms.length && f.some(q => q.kind === 'set' && q.models.length && q.alt.length), inside: f.every(q => q.x0 >= -0.01 && q.y0 >= -0.01 && q.x1 <= b.x + 0.01 && q.y1 <= b.y + 0.01) }; }); });
    check('every built-in layout gets doors, one front door and furniture inside the walls', sane.every(s => s.doors && s.entry && s.furniture && s.inside), sane);

    await page.click('[data-preset="2"]'); await page.waitForTimeout(300);
    // the model sits in the middle of the part of the 3D view that no control floats over
    const c = await page.evaluate(() => { const v = document.querySelector('#view3d').getBoundingClientRect(), p = document.querySelector('#panel').getBoundingClientRect(), b = document.querySelector('#bars').getBoundingClientRect(); return { x: (v.left + Math.min(v.right, p.left)) / 2, y: (Math.max(v.top, b.bottom) + v.bottom) / 2 }; });
    await page.waitForTimeout(900);
    await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x + 60, c.y - 20, { steps: 5 }); await page.mouse.up();
    await page.mouse.wheel(0, -200); await page.waitForTimeout(200); await page.mouse.click(c.x, c.y);
    check('clicking a floor in 3D selects that room', !!(await page.evaluate(() => window.roomlines.getState().selection)));
    check('no page errors while editing', errors.length === 0, errors);
    await close();
  }

  // ---------- 2. uploads and the scale tool (no Claude)
  {
    const { page, errors, close } = await open();
    await page.setInputFiles('#fileIn', F.png); await until(page, 'drawing', 'ready');
    check('an image loads under the plan', /Drawing loaded under the plan at a guessed size/.test(await status(page)) && await page.evaluate(() => window.roomlines.getState().drawing.widthM) === 12, await status(page));
    check('the scale tool cannot start without a drawing, and can with one', await page.evaluate(() => window.roomlines.can('tool', 'SCALE.START')));

    await page.click('#ulScale');
    check('Set scale enters scaling.first', (await machines(page)).tool === 'scaling.first' && await page.textContent('#ulScale') === 'Cancel scale');
    const im = await page.locator('#ulImg').boundingBox();
    await page.mouse.click(im.x + 2, im.y + im.height / 2);
    check('first click moves to scaling.second', (await machines(page)).tool === 'scaling.second');
    await page.mouse.click(im.x + im.width - 2, im.y + im.height / 2);
    check('second click asks for the distance', (await machines(page)).tool === 'scaling.distance' && await page.locator('#scaleForm').isVisible());
    await page.fill('#scaleM', '0'); await page.click('#scaleApply');
    check('a zero distance is refused and the tool stays put', (await machines(page)).tool === 'scaling.distance' && /greater than zero/.test(await status(page)));
    await page.fill('#scaleM', '10'); await page.click('#scaleApply');
    const wide = await page.evaluate(() => window.roomlines.getState().drawing.widthM);
    check('applying the distance rescales the drawing', Math.abs(wide - 10.1) < 0.15 && (await machines(page)).tool === 'idle', wide);
    await page.click('#ulScale'); await page.keyboard.press('Escape');
    check('Escape leaves the scale tool', (await machines(page)).tool === 'idle' && await page.textContent('#ulScale') === 'Set scale');

    await page.click('#ulClear');
    check('Clear rooms leaves one room to trace with', (await rooms(page)).length === 1);
    await page.setInputFiles('#fileIn', F.dwg); await page.waitForTimeout(150);
    check('a CAD file is refused with advice', /cannot open CAD files/.test(await status(page)) && (await machines(page)).drawing === 'ready', await status(page));
    await page.setInputFiles('#fileIn', F.json); await page.waitForTimeout(250);
    check('a saved plan loads with its plot', (await rooms(page)).length === 2 && (await page.evaluate(() => window.roomlines.getPlan().plot)).length === 4);

    await page.setInputFiles('#fileIn', F.pdf); await until(page, 'drawing', 'ready');
    check('a PDF opens on page 1 with a pager', await page.textContent('#pgLabel') === 'Page 1 of 3' && await page.textContent('#fileName') === 'land.pdf, page 1');
    await page.evaluate(() => { document.querySelector('#pgNext').click(); document.querySelector('#pgNext').click(); });
    await until(page, 'drawing', 'ready');
    check('two fast page turns end on the last page, in order', await page.textContent('#fileName') === 'land.pdf, page 3' && await page.textContent('#pgLabel') === 'Page 3 of 3', await page.textContent('#fileName'));
    check('the pager stops at the last page', await page.locator('#pgNext').isDisabled() && !(await page.evaluate(() => window.roomlines.can('drawing', 'PAGE.NEXT'))));

    await page.setInputFiles('#fileIn', F.pdf); await page.setInputFiles('#fileIn', F.png); await until(page, 'drawing', 'ready'); await page.waitForTimeout(700);
    check('a second upload replaces a slower first one', await page.textContent('#fileName') === 'plan.png' && await page.locator('#pager').isHidden(), await page.textContent('#fileName'));

    await page.click('#ulScale'); await page.click('#ulRemove');
    check('removing the drawing empties the machine and ends the scale tool', JSON.stringify(await machines(page)).includes('"tool":"idle","drawing":"empty"') && await page.locator('#fileLoaded').isHidden(), await machines(page));
    check('no page errors during uploads', errors.length === 0, errors);
    await close();
  }

  // ---------- 3. Claude (a stand-in): describe, read a floor plan, design on land, stop, supersede
  {
    const { page, errors, close } = await open({ claude: true });
    check('with Claude, describe is idle and read is idle', (await machines(page)).describe === 'idle' && (await machines(page)).read === 'idle', await machines(page));
    await page.evaluate(() => window.roomlines.send('read', 'RUN'));
    check('Read without a drawing is refused with a reason', (await machines(page)).read === 'idle' && /Upload a drawing first/.test(await status(page)), await status(page));

    await page.setInputFiles('#fileIn', F.png); await until(page, 'drawing', 'ready');
    await page.click('#readBtn'); await until(page, 'read', 'idle');
    check('reading a floor plan traces its rooms onto a clean grid', (await rooms(page)).join('; ') === 'Living 0,0 5.5x4.5; Kitchen 0,4.5 5.5x3.25; Hall 5.5,0 1.25x7.75; Bed 1 6.75,0 3.25x3.25; Bath 6.75,3.25 3.25x1.75; Bed 2 6.75,5 3.25x2.75', await rooms(page));
    check('the image goes to Claude as a JPEG on the strongest tier', JSON.stringify(await page.evaluate(() => window.__calls)) === '[{"image":true,"type":"image/jpeg","tier":"complex"}]', await page.evaluate(() => window.__calls));

    await page.setInputFiles('#fileIn', F.pdf); await until(page, 'drawing', 'ready');
    await page.selectOption('#readMode', 'land'); await page.click('#readBtn'); await until(page, 'read', 'idle');
    check('reading land draws a plot and a home', /Drew the plot \(768 m²\) and a 6-room home/.test(await status(page)), await status(page));

    await page.evaluate(() => { window.__delay = 1500; });
    const before = (await rooms(page)).join(';');
    await page.click('#askBtn');
    check('a request shows as working, with Stop', (await machines(page)).describe === 'working.thinking' && await page.locator('#askStop').isVisible() && await page.locator('#askBtn').isDisabled(), await machines(page));
    await page.click('#askStop'); await page.waitForTimeout(1800);
    check('Stop returns to idle and the late answer is dropped', (await machines(page)).describe === 'idle' && (await rooms(page)).join(';') === before && await page.textContent('#askStatus') === 'Stopped.');

    await page.click('#readBtn'); await page.waitForTimeout(100);
    const during = (await machines(page)).read;
    await page.setInputFiles('#fileIn', F.png); await until(page, 'drawing', 'ready'); await page.waitForTimeout(1800);
    check('uploading a new drawing cancels a reading of the old one', during === 'working.thinking' && (await machines(page)).read === 'idle' && (await rooms(page)).join(';') === before, [during, await machines(page)]);

    await page.evaluate(() => { window.__delay = 0; });
    await page.click('#askBtn'); await until(page, 'describe', 'idle');
    check('describing a home draws it', (await rooms(page)).join('; ') === 'Living 0,0 5x6; Bedroom 5,0 3x6', await rooms(page));
    await page.evaluate(() => { window.__fail = 'not_granted'; });
    await page.click('#askBtn'); await until(page, 'describe', 'blocked');
    check('a refused permission turns the feature off', await page.locator('#askBtn').isHidden() && /not allowed on this page/.test(await page.textContent('#askStatus')));
    check('no page errors with Claude', errors.length === 0, errors);
    await close();
  }

  // ---------- 4. window.roomlines, the scripted way in
  {
    const { page, errors, close } = await open();
    const r = await page.evaluate(() => {
      const R = window.roomlines, seen = []; const off = R.subscribe(s => seen.push(s.machines.tool));
      const id = R.addRoom({ name: 'Studio', type: 'office', x: 10, y: 0, w: 3.1, h: 2.9 });
      const updated = R.updateRoom(id, { w: 4, name: 'Workshop' }), missing = R.updateRoom('nope', { w: 2 });
      const room = R.getPlan().rooms.find(q => q.id === id);
      const out = { room: `${room.name} ${room.type} ${room.x},${room.y} ${room.w}x${room.h}`, updated, missing, types: R.roomTypes().length,
        cannotScale: R.can('tool', 'SCALE.START'), sent: R.send('tool', 'SCALE.START'), view: R.setView({ mode: 'plan', furniture: false }), selected: R.select(id) === id,
        removed: R.removeRoom(id), count: R.getPlan().rooms.length, loaded: R.loadPlan({ rooms: [{ name: 'A', x: 0, y: 0, w: 4, h: 4 }] }).rooms.length, log: R.log.length > 0, notified: seen.length > 0 };
      off(); try { R.send('nope', 'X'); out.threw = false; } catch (e) { out.threw = /Unknown machine/.test(e.message); }
      return out;
    });
    check('rooms can be added, changed and removed by script, snapped to the grid', r.room === 'Workshop office 10,0 4x3' && r.updated && !r.missing && r.removed && r.count === 6, r);
    check('can() and send() respect the machines', r.cannotScale === false && r.sent === 'idle' && r.threw, r);
    check('view, selection, plan loading, the log and subscribe all work', r.view.mode === 'plan' && r.view.furniture === false && r.selected && r.loaded === 1 && r.log && r.notified && r.types === 10, r);
    check('no page errors from the API', errors.length === 0, errors);
    await close();
  }

  // ---------- 4b. finishes: floor, wall paint and wall tile per room
  {
    const { page, errors, close } = await open();
    const r = await page.evaluate(() => {
      const R = window.roomlines, V = window.__roomlines.view, rooms = R.getPlan().rooms, by = n => R.getPlan().rooms.find(q => q.name === n);
      const out = { defaults: `${by('Living room').finish.floor}/${by('Living room').finish.tile || '-'} ${by('Bathroom').finish.floor}/${by('Bathroom').finish.tile}`, stored: Object.keys(rooms[0]).includes('floor'), base: V.stats() };
      const living = by('Living room').id, kitchen = by('Kitchen').id;
      R.updateRoom(living, { floor: 'walnut', paint: '#3D4A5C', spec: 'Navy feature wall' });
      R.updateRoom(kitchen, { tile: 'subway', tileTo: 1.2 });
      R.updateRoom(kitchen, { floor: 'not-a-finish', paint: 'red', tile: 'oak', tileTo: 99 }); // every one of these is invalid
      out.living = by('Living room'); out.kitchen = by('Kitchen');
      return out;
    });
    check('rooms start with their type\'s finishes, and a bathroom is tiled', r.defaults === 'oak/- tile-20/tile-30x60' && !r.stored && r.base.tiled > 0, r.defaults);
    check('floor, paint, tile and a note can be set per room', r.living.floor === 'walnut' && r.living.paint === '#3d4a5c' && r.living.spec === 'Navy feature wall' && r.kitchen.finish.tile === 'subway' && r.kitchen.finish.tileTo === 1.2, [r.living, r.kitchen]);
    check('invalid finishes are ignored and leave the room as it was', r.kitchen.floor === undefined && r.kitchen.paint === undefined && r.kitchen.tile === 'subway' && r.kitchen.tileTo === 1.2 && r.kitchen.finish.floor === 'tile-60', r.kitchen);
    const reset = await page.evaluate(() => { const R = window.roomlines, k = R.getPlan().rooms.find(q => q.name === 'Kitchen').id; R.updateRoom(k, { tile: null, tileTo: null }); return R.getPlan().rooms.find(q => q.name === 'Kitchen'); });
    check('null puts a finish back to the default', reset.tile === undefined && reset.tileTo === undefined && reset.finish.tile === '', reset);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__roomlines.view.stats());
    check('painted and tiled walls are drawn in 3D', after.skins > r.base.skins, [r.base, after]);
    const saved = await page.evaluate(() => { const R = window.roomlines, json = JSON.stringify(JSON.parse(document.querySelector('#jsonBox').value)); const again = R.loadPlan(JSON.parse(json)); return { json, living: again.rooms.find(q => q.name === 'Living room'), old: R.loadPlan({ rooms: [{ name: 'Bath', x: 0, y: 0, w: 2, h: 2 }] }).rooms[0].finish }; });
    check('finishes survive saving and loading, and old plans still load', /"floor":"walnut"/.test(saved.json) && saved.living.paint === '#3d4a5c' && saved.living.spec === 'Navy feature wall' && saved.old.tile === 'tile-30x60', saved);
    await page.click('[data-preset="2"]'); await page.waitForTimeout(500);
    const box = await page.locator('[data-room]').nth(3).boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.selectOption('#edFloor', 'terrazzo'); await page.click('#edPaints .swatch[data-paint="#cfd8d3"]'); await page.selectOption('#edTile', 'tile-60x120'); await page.selectOption('#edTileTo', '0.9'); await page.fill('#edSpec', 'Sample tile 60x120');
    const ed = await page.evaluate(() => window.roomlines.getPlan().rooms[3]);
    check('the editor sets finishes on the selected room', ed.floor === 'terrazzo' && ed.paint === '#cfd8d3' && ed.tile === 'tile-60x120' && ed.tileTo === 0.9 && ed.spec === 'Sample tile 60x120' && await page.getAttribute('#edPaints .swatch[data-paint="#cfd8d3"]', 'aria-pressed') === 'true', ed);
    await page.selectOption('#edTile', 'none');
    check('choosing no tile turns the height off', await page.locator('#edTileTo').isDisabled() && await page.evaluate(() => window.roomlines.getPlan().rooms[3].finish.tile) === '' && errors.length === 0, errors);
    await close();
  }

  // ---------- 4c. furniture from model files, with boxes as the fallback
  {
    const { page, errors, close } = await open();
    await until(page, 'models', 'ready'); await page.waitForTimeout(300);
    const st = await page.evaluate(() => { const R = window.__roomlines, s = R.view.stats(), sets = R.furnish(R.state.plan, R.state.an).filter(q => q.kind === 'set'), names = [...new Set(sets.flatMap(q => q.models.map(m => m.name)))]; return { s, sets: sets.length, names, known: Object.keys(window.ROOMLINES_MODELS), bad: sets.flatMap(q => q.models).filter(m => !(m.w > 0.05 && m.d > 0.01 && m.h > 0.01)).length }; });
    check('furniture is drawn from model files once they are loaded', st.s.models > 20 && st.sets > 8, st.s);
    check('every model the layout asks for is in the pack, with a real size', st.names.every(n => st.known.includes(n)) && st.bad === 0, st.names.filter(n => !st.known.includes(n)));
    const all = await page.evaluate(() => { const R = window.__roomlines, used = new Set(); for (const p of R.PRESETS) { const plan = R.normalizePlan(p); for (const q of R.furnish(plan, R.analyze(plan))) if (q.kind === 'set') q.models.forEach(m => used.add(m.name)); } return { used: [...used], known: Object.keys(window.ROOMLINES_MODELS) }; });
    check('the built-in layouts only use models that exist', all.used.every(n => all.known.includes(n)) && all.used.length > 20, all.used.filter(n => !all.known.includes(n)));
    await page.evaluate(() => window.roomlines.setView({ furniture: false })); await page.waitForTimeout(200);
    const off = await page.evaluate(() => window.__roomlines.view.stats());
    check('turning furniture off removes the models', off.models === 0 && off.boxes === 0 && errors.length === 0, [off, errors]);
    await close();
  }
  {
    const { page, errors, close } = await open({ block: ['models.js'] });
    await until(page, 'models', 'none'); await page.waitForTimeout(300);
    const st = await page.evaluate(() => window.__roomlines.view.stats());
    check('without the model pack the furniture falls back to boxes', st.models === 0 && st.boxes > 40 && errors.length === 0, [st, errors]);
    await close();
  }
  {
    const { page, errors, close } = await open({ block: ['GLTFLoader'] });
    await until(page, 'models', 'none');
    check('without the model loader the page still works', (await page.evaluate(() => window.__roomlines.view.stats())).boxes > 40 && errors.length === 0, errors);
    await close();
  }

  // ---------- 4d. shaped rooms, the plot, undo, and exports
  {
    const { page, errors, close } = await open();
    await until(page, 'models', 'ready');
    const walls = () => page.evaluate(() => { const R = window.__roomlines, an = R.analyze(R.state.plan), ops = an.pieces.flatMap(q => q.openings.map(o => o.kind)); return { pieces: an.pieces.length, shared: an.pieces.filter(q => !q.ext).length, doors: ops.filter(k => k === 'door' || k === 'open').length, entry: ops.filter(k => k === 'entry').length, slanted: an.pieces.filter(q => Math.abs(q.u[0]) > 0.01 && Math.abs(q.u[1]) > 0.01).length }; });
    const before = await walls();
    // turn the whole home 20 degrees: every wall is slanted, and nothing else may change
    const turned = await page.evaluate(() => { const R = window.roomlines, c = [5, 3.875], a = 20 * Math.PI / 180; const rooms = R.getPlan().rooms.map(r => ({ name: r.name, type: r.type, points: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(q => [c[0] + (q[0] - c[0]) * Math.cos(a) - (q[1] - c[1]) * Math.sin(a), c[1] + (q[0] - c[0]) * Math.sin(a) + (q[1] - c[1]) * Math.cos(a)]) })); return R.loadPlan({ name: 'Turned', rooms }).rooms.map(r => ({ pts: (r.points || []).length, area: r.area })); });
    const after = await walls(); await page.waitForTimeout(300);
    const st = await page.evaluate(() => { const R = window.__roomlines, f = R.furnish(R.state.plan, R.state.an); return { s: R.view.stats(), sets: f.filter(q => q.kind === 'set').length }; });
    check('a home turned 20° keeps its rooms, shared walls, doors and front door', turned.every(r => r.pts === 4) && after.pieces === before.pieces && after.shared === before.shared && after.doors === before.doors && after.entry === 1 && after.slanted === after.pieces, [before, after]);
    check('turned rooms keep their areas and are still furnished', Math.abs(turned.reduce((t, r) => t + r.area, 0) - 77.5) < 0.05 && st.sets >= 14 && st.s.models > 30, [turned.map(r => r.area), st]);
    const inside = await page.evaluate(() => { const R = window.__roomlines, pip = (P, x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; return c; }; const rooms = R.state.plan.rooms.map(R.outline); return R.furnish(R.state.plan, R.state.an).filter(q => q.kind === 'set').every(q => rooms.some(P => pip(P, q.cx, q.cz))); });
    check('every piece in a turned home stands inside a room', inside);

    await page.evaluate(() => window.roomlines.loadPlan({ name: 'L', rooms: [{ name: 'Living room', type: 'living', points: [[0, 0], [6, 0], [6, 3], [3.5, 3], [3.5, 5], [0, 5]] }, { name: 'Bedroom', type: 'bedroom', points: [[3.5, 3], [6, 3], [7.5, 5], [3.5, 5]] }] }));
    const L = await page.evaluate(() => { const R = window.roomlines.getPlan().rooms; return R.map(r => `${r.name} ${r.x},${r.y} ${r.w}x${r.h} ${r.area} pts${(r.points || []).length}`); });
    const Lw = await walls();
    check('an L-shaped room and a room with a slanted wall share walls and get a door', L[0] === 'Living room 0,0 6x5 25 pts6' && L[1] === 'Bedroom 3.5,3 4x2 6.5 pts4' && Lw.shared === 2 && Lw.doors >= 1 && Lw.entry === 1, [L, Lw]);

    await page.click('[data-preset="2"]'); await page.waitForTimeout(400);
    const box = await page.locator('[data-room]').nth(5).boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.click('#edTurnR');
    const t1 = await page.evaluate(() => window.roomlines.getPlan().rooms[5]);
    check('the turn button turns the selected room and keeps its area', (t1.points || []).length === 4 && Math.abs(t1.area - 8.94) < 0.02 && await page.locator('#edSquare').isVisible(), t1);
    await page.click('#undoBtn');
    check('Undo puts the room back as a rectangle', await page.evaluate(() => { const r = window.roomlines.getPlan().rooms[5]; return !r.points && r.w === 3.25 && r.h === 2.75; }) && await page.locator('#redoBtn').isEnabled());
    await page.click('#redoBtn');
    check('Redo turns it again', await page.evaluate(() => !!window.roomlines.getPlan().rooms[5].points));
    await page.click('#undoBtn');
    const b2 = await page.locator('[data-room]').nth(5).boundingBox(); await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.click('#edFree');
    const v = await page.locator('[data-room-vertex="2"]').boundingBox(), ppm = b2.width / 3.25;
    await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2); await page.mouse.down(); await page.mouse.move(v.x + v.width / 2 + ppm * 1.0, v.y + v.height / 2 + ppm * 0.5, { steps: 6 });
    const during = (await machines(page)).tool; await page.mouse.up();
    const shaped = await page.evaluate(() => window.roomlines.getPlan().rooms[5]);
    check('dragging a corner reshapes the room, as its own tool state', during === 'shaping' && (await machines(page)).tool === 'idle' && JSON.stringify(shaped.points[2]) === '[11,8.25]' && shaped.w === 4.25, [during, shaped.points]);
    const m = await page.locator('[data-room-edge="0"]').boundingBox(); await page.mouse.click(m.x + m.width / 2, m.y + m.height / 2);
    check('the mark on a side adds a corner', await page.evaluate(() => window.roomlines.getPlan().rooms[5].points.length) === 5);
    const v2 = await page.locator('[data-room-vertex="1"]').boundingBox();
    await page.mouse.move(v2.x + v2.width / 2, v2.y + v2.height / 2); await page.mouse.down(); await page.mouse.move(v2.x + 80, v2.y - 60, { steps: 4 }); await page.keyboard.press('Escape'); await page.mouse.up();
    check('Escape cancels a corner drag', await page.evaluate(() => window.roomlines.getPlan().rooms[5].points.length) === 5 && (await machines(page)).tool === 'idle' && JSON.stringify(await page.evaluate(() => window.roomlines.getPlan().rooms[5].points[1])) === '[8.375,5]', await page.evaluate(() => window.roomlines.getPlan().rooms[5].points));

    await page.click('[data-preset="2"]'); await page.waitForTimeout(300);
    await page.click('#plotAdd');
    check('Add a plot puts one 3 m round the home and shows its corners', JSON.stringify(await page.evaluate(() => window.roomlines.getPlan().plot)) === '[[-3,-3],[13,-3],[13,10.75],[-3,10.75]]' && await page.locator('[data-plot-vertex]').count() === 4 && await page.locator('#plotTools').isVisible());
    const plotTrim = await page.evaluate(() => { const R = window.roomlines; R.setPlot([[-1, -1], [12, 1], [11, 9], [-2, 8]]); const a = R.alignToPlot(), turnedAll = R.getPlan().rooms.every(r => r.points), t = R.trimToPlot(1.5), rooms = R.getPlan().rooms; const P = [[-1, -1], [12, 1], [11, 9], [-2, 8]]; const insideAll = rooms.every(r => (r.points || []).every(q => { for (let i = 0; i < 4; i++) { const p = P[i], c = P[(i + 1) % 4], l = Math.hypot(c[0] - p[0], c[1] - p[1]); if (((q[0] - p[0]) * -(c[1] - p[1]) + (q[1] - p[1]) * (c[0] - p[0])) / l < 1.5 - 0.01) return false; } return true; })); return { a, turnedAll, t, n: rooms.length, insideAll, bad: R.trimToPlot(1.5) && (R.setPlot([[0, 0], [10, 0], [5, 2], [10, 8], [0, 8]]), R.trimToPlot(1).why) }; });
    check('the home can be aligned to a slanted plot and trimmed to follow its boundary', plotTrim.a && plotTrim.turnedAll && plotTrim.t.ok && plotTrim.t.cut > 0 && plotTrim.insideAll && plotTrim.n >= 4, plotTrim);
    check('trimming refuses a plot with an inward corner, with a reason', plotTrim.bad === 'not convex', plotTrim.bad);
    const wAfter = await walls();
    check('a trimmed home still has doors to every room and one front door', wAfter.entry === 1 && wAfter.doors >= plotTrim.n - 1, wAfter);

    const files = await page.evaluate(async () => { const R = window.roomlines, dxf = R.toDXF(), glb = await R.toGLB(); const head = new Uint8Array(glb.slice(0, 4)); return { dxfOk: dxf.startsWith('0\nSECTION') && dxf.trim().endsWith('EOF') && /\nWALLS\n/.test(dxf) && /\nDOORS\n/.test(dxf) && /\nPLOT\n/.test(dxf) && /\nNAMES\n/.test(dxf), lines: (dxf.match(/\nLINE\n/g) || []).length, glb: String.fromCharCode(...head), bytes: glb.byteLength }; });
    check('the plan exports as DXF with layers and as a GLB model', files.dxfOk && files.lines > 40 && files.glb === 'glTF' && files.bytes > 50000, files);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.evaluate(() => { document.querySelector('#dataBox').open = true; document.querySelector('#saveDxf').click(); })]);
    check('Save .dxf downloads a file outside Claude', !!dl && /\.dxf$/.test(dl.suggestedFilename()) && errors.length === 0, [dl && dl.suggestedFilename(), errors]);
    await close();
  }

  // ---------- 5. phone layout, and a missing library
  {
    const { page, errors, close } = await open({ claude: true, viewport: { width: 400, height: 800 } });
    await page.setInputFiles('#fileIn', F.png); await until(page, 'drawing', 'ready');
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth, window.roomlines.getState().view.mode]);
    check('at phone width nothing overflows and an upload switches to the plan', w[0] === w[1] && w[2] === 'plan' && errors.length === 0, w);
    await close();
  }
  {
    const { page, errors, close } = await open({ block: ['xstate'] });
    check('if the state library cannot load, the page says so instead of half-working', await page.locator('#fatal').isVisible() && errors.length === 0, errors);
    await close();
  }
  {
    const { page, errors, close } = await open({ block: ['jsdelivr'] });
    check('the second script host is used when the first is down', (await machines(page)).tool === 'idle' && errors.length === 0, errors);
    await close();
  }

  // ---------- 6. floating glass controls
  const clear = page => page.evaluate(() => {
    const hit = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    const glass = [...document.querySelectorAll('.bar, #panel')].filter(e => !e.hidden && e.offsetWidth).map(e => e.getBoundingClientRect());
    const content = [...document.querySelectorAll('[data-room], [data-handle]')].map(e => e.getBoundingClientRect()); const img = document.querySelector('#ulImg');
    if (img.getAttribute('display') !== 'none') content.push(img.getBoundingClientRect());
    return content.filter(c => c.width && glass.some(g => hit(c, g))).length;
  });
  {
    const { page, errors, close } = await open();
    check('the tools panel starts open on a wide screen', await page.evaluate(() => document.body.dataset.panel) === 'open' && await page.locator('#panel').isVisible());
    await page.setInputFiles('#fileIn', F.png); await until(page, 'drawing', 'ready'); await page.waitForTimeout(500);
    check('no glass covers a room, a handle or the uploaded drawing (plan + 3D)', await clear(page) === 0, await clear(page));
    await page.click('[data-mode="plan"]'); await page.waitForTimeout(900);
    check('the view switch changes the layout', await page.evaluate(() => document.querySelector('#panes').className) === 'panes mode-plan' && await page.locator('.pane-3d').isHidden());
    check('no glass covers the plan when it fills the window', await clear(page) === 0, await clear(page));
    await page.click('#panelBtn'); await page.waitForTimeout(700);
    check('Tools closes the panel with the hidden attribute', await page.locator('#panel').isHidden() && await page.evaluate(() => window.roomlines.getState().view.panel) === 'closed' && await page.getAttribute('#panelBtn', 'aria-expanded') === 'false');
    check('the panel can be reopened by script', await page.evaluate(() => window.roomlines.setView({ panel: 'open' }).panel) === 'open' && await page.locator('#panel').isVisible());
    await page.click('label:has(#optFurniture)'); await page.click('label:has(#optCut)'); await page.click('#resetView'); await page.click('#zoomBtn');
    const v = await page.evaluate(() => window.roomlines.getState().view);
    check('the Furniture, Cut walls, Reset view and zoom controls all respond', v.furniture === false && v.cut === false && v.zoomHome === true && await page.textContent('#zoomBtn') === 'Show the whole drawing', v);
    const glass = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('#panel')); return c.backdropFilter || c.webkitBackdropFilter; });
    const bar = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('#viewBar')); return c.backdropFilter || c.webkitBackdropFilter; });
    check('the bars are glass too', /blur\(|url\(/.test(bar), bar);
    const cut = await page.evaluate(() => [...document.querySelectorAll('.glass')].flatMap(g => { const bad = []; for (let e = g.parentElement; e && e !== document.documentElement; e = e.parentElement) { const c = getComputedStyle(e); if (c.viewTransitionName !== 'none' || c.filter !== 'none' || c.opacity !== '1' || c.mixBlendMode !== 'normal' || (c.maskImage && c.maskImage !== 'none')) bad.push(`${g.id || g.className} inside ${e.id || e.className}`); } return bad; }).filter(x => !/^(hint|btn zoom).* inside pane/.test(x) && !/hint3d inside|zoomBtn inside/.test(x)));
    check('no parent cuts a floating bar or the panel off from the drawing behind it', cut.length === 0, cut);
    check('the panel is glass: it blurs what is behind it', /blur\(/.test(glass), glass);
    check('no page errors with the floating controls', errors.length === 0, errors);
    await close();
  }
  {
    const { page, errors, close } = await open({ viewport: { width: 400, height: 800 } });
    const h = () => page.evaluate(() => Math.round(document.querySelector('#panel').getBoundingClientRect().height));
    check('on a phone the tools start as a closed sheet', await page.evaluate(() => document.body.dataset.panel) === 'closed' && await page.locator('#panelBody').isHidden() && await h() < 80, await h());
    await page.setInputFiles('#fileIn', F.png); await until(page, 'drawing', 'ready'); await page.waitForTimeout(700);
    check('on a phone no glass covers a room or the drawing', await clear(page) === 0, await clear(page));
    await page.click('#grab'); await page.waitForTimeout(700);
    const half = await h();
    check('tapping the handle opens the sheet to about half', await page.evaluate(() => document.body.dataset.panel) === 'open' && await page.locator('#panelBody').isVisible() && half > 300 && half < 440, half);
    await page.click('#grab'); await page.waitForTimeout(700);
    check('tapping again opens it fully, and once more closes it', await page.evaluate(() => document.body.dataset.panel) === 'full' && await h() > 560, await h());
    await page.click('#grab'); await page.waitForTimeout(700);
    check('the sheet closes again', await page.evaluate(() => document.body.dataset.panel) === 'closed' && await h() < 80 && errors.length === 0, [await h(), errors]);
    await close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' }), page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); const hit = SCRIPTS.find(([f]) => u.endsWith(f)); return hit ? r.fulfill({ contentType: 'application/javascript', body: hit[1] }) : r.abort(); });
    await page.goto(PAGE); await page.waitForTimeout(500);
    await page.click('[data-mode="3d"]');
    const still = await page.evaluate(() => ({ now: document.querySelector('#panes').className, anim: getComputedStyle(document.querySelector('.side')).animationName, thumb: getComputedStyle(document.querySelector('#segThumb')).transitionDuration }));
    check('with reduced motion, changes apply at once and nothing animates', still.now === 'panes mode-3d' && still.anim === 'none' && /^0s/.test(still.thumb) && errors.length === 0, still);
    await ctx.close();
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
