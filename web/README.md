# Likuloka 3D (web)

A building editor that runs in the browser: buildings, levels, walls, doors, windows, zones and slabs, edited directly in 3D. It is a Next.js app that exports to static files, so it deploys as a website rather than a desktop install.

| Part | What is used |
|---|---|
| App | Next.js 16 (App Router) with `output: 'export'` |
| 3D | React Three Fiber 9 on three.js r187's `WebGPURenderer`, which falls back to WebGL 2 when WebGPU is missing |
| Shading | TSL node materials, compiled to WGSL on WebGPU and to GLSL on WebGL 2 |
| State | zustand 5, with undo and redo built in |

## Running it

```bash
npm install
npm run dev
```

Open http://localhost:3000. To build the site:

```bash
npm run build
```

`out/` is then a plain static site. Upload it to any static host: Vercel, Netlify, Cloudflare Pages, GitHub Pages or an S3 bucket. No server is needed.

## What you can do

- **Hierarchy.** Each building has levels; each level has a slab, zones (rooms) and walls; each wall has its doors and windows. The scene list on the left shows the tree, and clicking a row selects that node.
- **Stack, explode, solo.** Each building has its own switch. Stack draws levels at their elevations. Explode pulls them 2.75 m apart so every floor can be seen and edited. Solo shows one level; pick which with its Show button.
- **Drag walls.** Drag a wall to slide it sideways. Walls joined to its ends stretch to follow. Select a wall to get a ball on each end; drag a ball to move that end.
- **Reshape slabs and zones.** Select one to get a ball on each corner and a small ball on each edge. Drag a corner to move it. Drag a small ball to add a corner there. Drag a selected zone to move it.
- **Doors and windows.** Press D or choose "Door", or N or "Window", then click a wall: the opening is centred on the click and kept inside the wall. Drag a door or window to slide it along its wall. The inspector sets its width, height, sill and place along the wall, and can turn a door into a window. An opening that does not fit, overlaps another or is taller than its wall is refused with a message. When a wall end moves, the doors and windows in the walls that stretch keep their place in the room. Deleting a wall deletes its openings.
- **Door and window options.** In the inspector: a square or rounded (arched) head, a frame of timber, steel, aluminium or uPVC, and drawn closed or open (the leaf or sash swings out). Rounding a head that is too short for its arch raises it just enough. The finishes are generic colours, not any manufacturer's products.
- **Measurements.** The inspector gives a door's or window's size, head height, sill height, arch radius and wall depth in millimetres. In the view, the selected door, window or wall shows its size; Measure (M) shows the size of every door and window.
- **Schedule.** Lists every door and window with a reference (D01, W01…), its sizes in millimetres and where it is, and groups them into types with quantities to order. Click a reference to select that opening. "Download CSV" gives the same list as a spreadsheet file.
- **Projects.** Name the project in the toolbar. Save (Ctrl+S) keeps it in this browser; the button shows when there are unsaved changes, and undoing back to the saved state counts as saved. The Project dialog lists saved projects to open or delete, starts a new blank project or one from the sample, downloads the project as a `.likuloka.json` file and opens such files, and imports Roomlines plans. The working copy is also kept as a draft, so a reload never loses work.
- **Draw walls.** Press W or choose "Draw walls", then click on the floor. Each click after the first adds a wall from the last point, so walls chain. Escape ends the run; Escape again goes back to Select.
- **Cut walls.** On by default. Walls are drawn up to 1.2 m so you can see into the rooms. Turn it off to see full height.
- **Inspector.** On the right. It edits the selected node's numbers. Every change is one undo step.
- **Undo and redo.** Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y), or the toolbar. A whole drag is one step.
- **Import.** "Import plan" reads a Roomlines plan (see the repository README, "Plan format"), in either the `rooms` or the nested `layout` form. It is added as a new building: each room becomes a zone, the room edges become walls (an edge two rooms share becomes one wall), and the outline of all the rooms becomes the slab.

All lengths are metres on a 0.25 m grid. Plan `x` runs left to right and plan `y` top to bottom; in 3D, plan `y` is world `z`.

Projects are stored in the browser's local storage: `likuloka3d.projects` lists them, each is under `likuloka3d.project:<id>`, and the working copy is `likuloka3d.draft`. Scenes saved by earlier versions (including `likuloka3d.scene`) are brought up to date when they are opened.

## How it is built

```
src/scene/   the document, its operations and the store (no three.js)
src/ecs/     the world, its systems and the materials
src/render/  React Three Fiber components and pointer gestures
src/ui/      the toolbar, scene tree and inspector
app/         the Next.js page and styles
```

### The document and undo

The scene is one immutable document: a flat table of nodes (`building`, `level`, `wall`, `opening`, `zone`, `slab`) that point to their parent and list their children. Every operation in `src/scene/ops.ts` takes a document and returns a new one. Nodes it does not touch keep their object identity.

The store keeps past documents for undo, up to 200. Because untouched nodes are shared, each step costs only the nodes it changed. A drag is a gesture: `begin` records the starting document, each pointer move calls `preview` with an edit that always starts from that document (so the result cannot drift), and `end` records one step. Escape cancels the gesture.

Selection, the tool, level modes and the wall cut are view state, so they are not undone.

### Dirty tracking and the ECS

Because an edit replaces exactly the nodes it touches, the dirty set is just the ids whose node changed identity between two documents (`diff` in `ops.ts`). The store subscription in the viewport adds them to the world's dirty set. Before the systems run, dependencies are added: a dirty opening makes its wall dirty (the wall is cut around it), and a wall whose thickness changed makes its openings dirty (their frames span the wall).

`src/ecs/world.ts` holds the entities: one per node, made of the node's data and the three.js object React mounted for it. Each frame the systems run in order and touch only dirty entities:

| System | What it updates |
|---|---|
| walls | A wall is a group of boxes: full height between openings, and below and above each door or window. Every box is the same shared unit cube, scaled into place, so moving or cutting a wall uploads matrices and builds no geometry. |
| openings | A door is a frame and a leaf; a window is a frame, a sill and a pane of glass. They are boxes too. An open leaf or sash is a box swung about its hinge. A rounded head uses curved parts (`src/ecs/shapes.ts`) that are normalised to the same unit cube, so they are placed, cut and picked exactly like boxes, and cached by proportion. |
| labels | Measurements: DOM labels moved in the frame loop after the systems, so React does not re-render for them. |
| outlines | The slab's or zone's buffers, rebuilt only for the outline that changed. |
| layout | Each level's height for stack, explode or solo, eased into place. |
| selection | Swaps the material of the old and the new selection. |

React mounts and unmounts objects when a parent's `children` list changes. No component reads a wall's coordinates, so moving a wall re-renders no React component: the walls system moves the mesh. The scene tree works the same way, one row per node, so renaming a node re-renders one row.

Frames are drawn on demand: only when the document, the view or the camera changes, while levels are still easing, or while a selected zone pulses.

### On the GPU

The materials are TSL node materials:

- **Wall cut.** The section cut runs in the vertex shader. Every box of a wall, door or window clamps its vertices to the cut height, measured from the floor using the box's own bottom height, which the shader reads per object (`userData.y0`). Cutting everything costs one uniform write. Boxes that start above the cut, such as the wall over a door, are hidden instead. Picking uses the same cut box on the CPU, so a click hits what is drawn.
- **Contact shading.** Walls darken toward the floor from their local height.
- **Selection pulse.** The selected zone pulses from the shader's clock, so it needs no work on the CPU. With reduced motion it holds still.

Geometry itself is built on the CPU, but only for what changed, and walls never need new geometry.

## Scripting

`window.likuloka` drives the editor through the same functions as the buttons:

```js
likuloka.getDoc()                 // the scene document
likuloka.getState()               // { tool, selection, views, undo, redo, cut, error, ... }
likuloka.commit(d => likuloka.ops.offsetWall(d, wallId, 0.5), 'Slide wall')
likuloka.commit(d => likuloka.ops.addOpeningAt(d, wallId, 'door', [2, 0])[0], 'Add door')
likuloka.commit(d => likuloka.ops.updateOpening(d, openingId, { kind: 'window', width: 1.5 }), 'Make a window')
likuloka.undo(); likuloka.redo()
likuloka.select(id)
likuloka.setView(buildingId, { mode: 'explode' })   // 'stack' | 'explode' | 'solo', and `solo: levelId`
likuloka.importRoomlines(plan)
likuloka.projects.save(); likuloka.projects.list(); likuloka.projects.open(id)
likuloka.projects.file()          // the project as file text; projects.openFile(text) opens one
likuloka.schedule()               // every door and window, sizes in mm; scheduleCsv() as CSV
likuloka.setMeasure(true)
likuloka.focus(id)                // points the camera at a node
likuloka.stats()                  // what each system updated, and the ids changed in the last frame that changed any
likuloka.project(levelId, x, y)   // the screen position of a plan point
likuloka.backend()                // 'WebGPU' or 'WebGL 2'
```

## Tests

`tests/e2e.cjs` builds nothing itself: it serves `out/` and drives the editor in Chromium with Playwright. It checks the hierarchy, the Roomlines import, dirty tracking (one edit updates one entity), undo and redo, real mouse drags of walls, wall ends, slab corners, edge midpoints, zones and doors, placing doors and windows and their rules, their shape, frame and open options, measurements, the schedule and its CSV, saving, opening, downloading and deleting projects, opening older scenes, stack, explode and solo, the wall tool, the inspector, import, persistence and the phone layout.

```bash
npm test                                         # builds, then tests on WebGPU
LIKULOKA_RENDERER=webgl node tests/e2e.cjs       # the WebGL 2 fallback
```

Headless Chromium has no GPU here, so the tests use SwiftShader's Vulkan adapter for WebGPU. If that browser cannot start, they run on WebGL 2.
