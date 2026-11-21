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
- **Stack, explode, side, solo.** Each building has its own switch. Stack draws levels at their elevations; while something on a lower level is selected, the levels above it fade to a faint shell and let the pointer through, so the floor below can be seen and edited without leaving the stack. Explode lifts them 4.5 m apart, enough to reach under each floor. Side lays the levels next to each other on the ground. Solo shows one level alone.
- **Move buildings.** Select a building, one of its levels or a floor slab, and a light-blue ring appears on the ground in the middle of the building. Drag the ring to move the whole building, on the grid. It is one undo step, and nothing inside the building changes. Clients cannot move buildings.
- **Drag walls.** Drag a wall to slide it sideways. Walls joined to its ends stretch to follow. Select a wall to get a ball on each end; drag a ball to move that end.
- **Floor finishes.** A room shows the colour of its use until it is given a floor: oak or walnut planks, four tile sizes, terrazzo or polished concrete. The shader draws the joints at true size from world coordinates, so tiles line up across rooms. These are generic finishes, not products. A client may choose them.
- **Furniture.** Every room is furnished from its use and shape: beds, a kitchen run, sofa, table, bathroom fittings and so on, placed along the walls and clear of doors and windows. Nothing is stored; the pieces are worked out from the rooms (`src/scene/furnish.ts`, the recipes Roomlines uses), so they follow when a wall moves. The Furniture button in the bar hides them. They are drawn from the CC0 model files in `public/models`, or from boxes when those are missing.
- **Plot.** The Plot tool (P) holds the boundary of the land. Add one around the buildings, then drag its corners (in steps of 50 mm) or a small ball to add a corner; the panel lists each side's length and the area. Inside the boundary a fainter line shows the distance the project keeps clear (1500 mm unless changed). Checks warn when a building crosses the boundary or comes closer than that; they never block. Centre the buildings on the plot moves them together, on the grid. The plot is part of the document (`plot`), so it is saved and undone; a client cannot change it. It is not in the DXF or IFC export yet.
- **Pool, island kitchen, sunken bed.** A level's + Pool button adds a swimming pool, 8 × 4 m beside the building: a zone with the use `pool`, drawn as water with a stone coping and steps, to drag into place and reshape by its corners. It needs no door, and the plot check covers its corners. A kitchen can be furnished with an island and a bedroom or studio with a sunken bed (a mattress set down into a timber deck): the choice is on the room (`option`) and a client may make it. Where the room is too small for it, the standard furniture is drawn and a note in Checks says why.
- **Trace a drawing.** The Trace tool (T) takes a picture or a DXF file. A picture (PNG, JPG or WebP) is laid on the ground, see-through, above the rooms' colours: mark a length you know on it with two clicks and type its real length to give it its true size, drag it into place, and set how strongly it shows or hide it. It is view state: it stays in the browser tab and is not saved, undone or sent to the cloud. A DXF file is read exactly (`src/scene/dxfin.ts`): the panel shows its overall size and unit (stated in the file, or guessed from its size and changeable), and you choose the layer that holds the plot and the layer that holds the rooms. The largest closed polyline on the plot layer becomes the plot; each closed polyline on the rooms layer becomes a room named by the text inside it, with walls, doors and windows from the Roomlines import, on the 0.25 m grid; a room named pool or kolam becomes a pool. Its other lines can be shown on the ground to draw over. It reads ASCII DXF with LINE, LWPOLYLINE, POLYLINE and TEXT; curves are read as straight segments and blocks are not expanded. PDF is not read: save the page as a picture, or export DXF from the CAD program.
- **Reshape slabs and zones.** Select one to get a ball on each corner and a small ball on each edge. Drag a corner to move it. Drag a small ball to add a corner there. Drag a selected zone to move it.
- **Doors and windows.** Press D or choose "Door", or N or "Window", then click a wall: the opening is centred on the click and kept inside the wall. Drag a door or window to slide it along its wall. The inspector sets its width, height, sill and place along the wall, and can turn a door into a window. An opening that does not fit, overlaps another or is taller than its wall is refused with a message. When a wall end moves, the doors and windows in the walls that stretch keep their place in the room. Deleting a wall deletes its openings.
- **Door and window options.** In the inspector: a square or rounded (arched) head, a frame of timber, steel, aluminium or uPVC, and drawn closed or open (the leaf or sash swings out). Rounding a head that is too short for its arch raises it just enough. The finishes are generic colours, not any manufacturer's products.
- **Measurements.** The inspector gives a door's or window's size, head height, sill height, arch radius and wall depth in millimetres. In the view, the selected door, window or wall shows its size; Measure (M) shows the size of every door and window.
- **Catalogue products.** The inspector's Product list holds your doors and windows from `catalogue.json`. Choosing one sets the type, head, frame, frame size and, from those, the structural opening. Changing the size by hand makes it a custom size.
- **Structural opening and frame.** An opening's width and height are the hole in the wall. The frame is smaller by the project's fitting gap (Project, Projects and files, Settings; 10 mm a side by default, and at a door's head). Door and window sizes are kept to 5 mm; wall positions stay on the 0.25 m grid.
- **Wall build-ups.** The inspector's Build-up list gives a wall a catalogue wall type: its layers (structure, insulation, cavity, finish) and the thickness they add up to. Typing a thickness makes it a plain wall again. Plans draw the layers, and the IFC export carries them.
- **Schedule.** Lists every door and window with a reference (D01, W01…), its product, structural opening and frame size in millimetres and where it is, and groups them into types with quantities, unit prices and a total to order. Click a reference to select that opening. "Download CSV" gives the list as a spreadsheet, with the catalogue's columns.
- **Checks.** Buildability checks run as you work: narrow doors, low door heads, bedrooms without an escape window, rooms without a door, rooms short of daylight, too little wall above an opening for a lintel, spans that need an engineered lintel, and openings that run into a joining wall. The status bar counts them; Project, Checks lists them, and clicking one selects and frames it; the inspector shows the selected node's. They never block an edit. Their limits are the catalogue's `rules`: set them to the regulations where you build.
- **Client view.** A client chooses from what the designer drew: a door or window's product, frame, head and open or closed, and a room's name and use. Walls, levels, slabs and where openings sit stay as drawn, and a size can only change by choosing a catalogue product. This is checked on every edit by comparing the documents before and after (`src/scene/access.ts`), so it holds for buttons, keys, drags and scripts. A designer can try it with Project, Projects and files, Preview as client; someone who opens a client share link gets it and cannot leave it.
- **Versions and sign-off.** Project, Versions and sign-off saves the design as a numbered version with a note and an author. Compare shows what changed since a version: door and window changes field by field, and the rest counted by kind. A client approves a version by typing their name and ticking the box; the approval records who and when, and an approved version cannot be deleted. A designer can restore a version, as one undoable step. The approval is a record of agreement, not a verified electronic signature.
- **Drawings.** Project, Drawings gives A3 sheets to scale: a plan of each level (walls cut with their layers, door swings, glazing, rooms with areas, wall lengths, overall dimensions, door and window tags matching the schedule, title block and scale bar), and elevations of every wall with doors or windows (chain dimensions, opening and frame sizes, sill and head heights). "Print or save as PDF" prints them, one sheet a page; each sheet also downloads as SVG.
- **DXF for AutoCAD.** Project, Export DXF for AutoCAD writes every level's plan, side by side, as a DXF file; each plan in the Drawings dialog also has its own DXF button. It is drawn at true size, one unit to the millimetre with the units set to millimetres, on layers in the common `A-` style: `A-WALL` (wall outlines), `A-WALL-PATT` (build-up layers), `A-DOOR` (leaves and swings), `A-GLAZ` (windows), `A-FLOR-OTLN` (slab outlines), `A-AREA-IDEN` (room names, sizes and areas), `A-ANNO-DIMS` (dimensions), `A-ANNO-TAGS` (door and window tags matching the schedule) and `A-ANNO-TTLB` (titles). It is DXF R12, the version every CAD program reads: AutoCAD, BricsCAD, DraftSight, LibreCAD, QCAD, and SketchUp Pro's DWG/DXF import. To get a DWG, open the DXF in AutoCAD and Save As DWG; DWG itself is a closed format that a web page cannot write reliably. Dimensions are lines and text rather than CAD dimension objects, so they look the same in every program but do not update if the drawing is edited in CAD.
- **SketchUp.** SketchUp Pro imports the DXF plans (File, Import, AutoCAD files) as 2D linework to model on, and the IFC file as a 3D model of walls, doors, windows, slabs and rooms.
- **IFC.** Project, Export IFC for BIM and SketchUp writes an IFC4 file for engineers and BIM tools: buildings and storeys, walls with their build-up as material layers, openings voiding the walls, doors and windows with their frame sizes and properties (reference, product, finish, price), slabs and rooms. Element ids are derived from the project, so exporting again updates the same elements. Rounded heads are exported as rectangular openings, with the shape in the properties.
- **Projects.** Name the project in the toolbar. Save (Ctrl+S) saves it where it lives: in this browser, or in the cloud. The button shows when there are unsaved changes, and undoing back to the saved state counts as saved. Project, Projects and files lists the projects saved in this browser to open or delete, starts a new blank project or one from the sample, downloads the project as a `.likuloka.json` file and opens such files, sets the fitting gap, and imports Roomlines plans. The working copy is also kept as a draft, so a reload never loses work.
- **Cloud and sharing.** With cloud set up (see "Cloud projects"), Project, Cloud and sharing signs in with Google or email, moves a project to the cloud, lists your cloud projects, makes share links for clients and designers, and lists the people on a project; the owner can remove them. When someone else saves the open project, the status bar says so and offers Reload, and a save from an out-of-date copy is refused rather than overwriting theirs.
- **Draw walls.** Press W or choose "Draw walls", then click on the floor. Each click after the first adds a wall from the last point, so walls chain. Escape ends the run; Escape again goes back to Select.
- **Cut walls.** On by default. Walls are drawn up to 1.2 m so you can see into the rooms. Turn it off to see full height.
- **Inspector.** On the right. Every length in it is in millimetres, the way builders work, and nothing is set by coordinates: a wall has a length, thickness and height (typing a length moves its far end along it; lengths snap to the 250 mm grid); a door or window has a width, height, sill height (windows) and its distance from the wall's start, with the gap to the other end shown; a room shows its size (such as 5,500 × 4,500 mm) and area; a level has its floor height and storey height. Positions are set by dragging in the view. Every change is one undo step.
- **Undo and redo.** Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y), or the toolbar. A whole drag is one step.
- **Import.** Project, Projects and files, Import a Roomlines plan reads a Roomlines plan (see the repository README, "Plan format"), in the `rooms` or the nested `layout` form. It is added as a new building: each room becomes a zone, room edges become walls with shared edges merged, and the outline of the rooms becomes the slab. A room with `points` keeps its shape, with each corner moved onto the 0.25 m grid, so slanted walls come across. Doors, a front door and windows are added by Roomlines' own rules, so every room is reachable. Roomlines' finishes, plot and furniture are not carried over yet.

All lengths are metres. Wall positions are on a 0.25 m grid; door and window sizes are kept to 5 mm and wall layers to 0.1 mm. Plan `x` runs left to right and plan `y` top to bottom; in 3D, plan `y` is world `z`.

Projects are stored in the browser's local storage: `likuloka3d.projects` lists them, each is under `likuloka3d.project:<id>`, and the working copy is `likuloka3d.draft`. Scenes saved by earlier versions (including `likuloka3d.scene`) are brought up to date when they are opened.

## The catalogue

`public/catalogue.json` is read when the editor opens, so it can be changed on the server without rebuilding (the same file is built in as a fallback). Everything in it is in millimetres. The products and prices in it are examples: replace them with yours.

| Key | What it holds |
|---|---|
| `currency` | The currency code for prices, such as `USD`, `GBP` or `IDR`. |
| `products` | Doors and windows: `code`, `name`, `kind` (`door` or `window`), `shape` (`square` or `arched`), `finish` (`timber`, `steel`, `aluminium` or `upvc`), frame `width` and `height`, a window's default `sill`, and `price`. |
| `wallTypes` | Build-ups: `code`, `name` and `layers`, each with `name`, `kind` (`structure`, `insulation`, `cavity` or `finish`) and `thickness`. |
| `rules` | The checks' limits: `minDoorWidth`, `minDoorHeadHeight`, `escapeWindowArea` (m²), `escapeWindowMaxSill`, `daylightRatio` (window area over floor area), `minWallAboveOpening`, `lintelSpanNeedsEngineer`, `junctionClearance`. The defaults are common minimums, not any one country's code. |
| `scheduleColumns` | The CSV's columns, in order, from: `ref`, `kind`, `product`, `productName`, `shape`, `finish`, `frameWidth`, `frameHeight`, `width`, `height`, `sill`, `head`, `wall`, `price`, `building`, `level`, `state`. |

An entry that is not valid is skipped, and the Checks dialog says which.

## Cloud projects

Cloud projects use Firebase: Authentication for accounts and Firestore for projects, versions and share links. The site stays static: the browser talks to Firebase directly, and `firebase/firestore.rules` decides who may read and write what. Without `cloud.json`, cloud features say they are not set up and everything else works.

To set it up:

1. Create a project in the [Firebase console](https://console.firebase.google.com/).
2. In Authentication, Sign-in method, turn on **Email/Password** and **Google**. Under Settings, Authorized domains, add the domain the editor is served from.
3. Create a **Firestore** database in production mode.
4. Deploy the rules from this folder:

   ```bash
   npx firebase login
   ```

   ```bash
   npx firebase use --add
   ```

   ```bash
   npm run deploy:rules
   ```

5. In Project settings, Your apps, add a **Web app**. Copy `public/cloud.example.json` to `public/cloud.json` (beside `index.html` once built) and fill in its `apiKey`, `authDomain`, `projectId` and `appId`. These values are public by design. `cloud.json` is not committed; add it when deploying.
6. Deploy the site anywhere static, or to Firebase Hosting with `npm run deploy:hosting`.

What the rules enforce, tested against the emulator by `tests/rules.test.cjs`:

- Only members read a project; nobody can list projects that are not theirs.
- The owner and designers change the scene and name; only the owner removes members or deletes the project; nobody changes ownership.
- A client never writes the scene directly; their saves go through the `saveScene` function, which checks what changed.
- Joining needs an invite token and gets exactly that invite's role; an invite cannot make an owner.
- Every save moves `sceneVersion` on by one and is signed by its saver, so two people cannot overwrite each other unnoticed.
- Versions never change once saved; each is approved at most once, by the member approving, with the server's time; approved versions cannot be deleted.

**The server-side check.** Clients cannot write a project's scene directly: the rules refuse it. They save through the `saveScene` Cloud Function (`functions/src/index.ts`). It runs the same check as the editor, `clientRefusal` from `src/scene/access.ts` (bundled into the function, so there is one set of rules), against the scene as saved now. It writes the new scene only if every change is one a client may make, and only if it follows the latest save. A changed or scripted editor gets the same refusal as the real one. A client's version must be the project as saved, so a scene cannot be slipped past the check as a version. Designers keep saving directly.

To deploy it (Cloud Functions need Firebase's pay-as-you-go Blaze plan; a small team's use is normally within the free allowance):

```bash
npm run functions:build
```

```bash
npm run deploy:functions
```

Without the function deployed, designers save as before, and a client's save explains that the function is needed. If your project uses a region other than `us-central1`, set `functionsRegion` in `cloud.json`.

Data: `projects/{id}` holds `name`, `ownerUid`, `members` (uid to role), `memberUids`, `memberNames`, `scene` (the scene as JSON), `sceneVersion`, `updatedAt` and `updatedBy`; `projects/{id}/versions/{id}` holds `number`, `createdAt`, `author`, `authorUid`, `note`, `scene` and `approval`; `invites/{token}` holds `projectId`, `role`, `createdBy`, `createdAt` and `projectName`.

## Website

Every push to `main` that touches `web/` builds the static site and publishes it on GitHub Pages (`.github/workflows/pages.yml`), at `https://saviourv2.github.io/Likuloka3D/`. Pages serves it under the repository's name, so the workflow passes that path to the build as `PAGES_BASE_PATH`; everything the page fetches (`catalogue.json`, `cloud.json`, `models/`) is asked for relative to the page. Cloud features stay off there, because no `cloud.json` is published.

## Design

The night edition: black, with the cobalt of likuloka.com carried into light blue (`--accent` `#6fd0ff`, `--accent-2` `#2f6bff`), Archivo for text and JetBrains Mono for figures. The page background is black with slowly drifting cobalt and light-blue glows and a faint blueprint grid; the panels are translucent over it. What floats above the 3D view is glass: the bar, its menu, the labels and the dialogs blur and tint the view behind them, with a lit top edge. With reduced transparency all of it is solid. In the 3D view, a gradient night sky is drawn by the GPU, with fog into the distance, the grid everything snaps to (a line every 0.25 m, brighter every 1 m and 5 m), a light-blue rim light and vivid room colours on dark floors. The selection glows with a slow light-blue pulse computed in the shader.

Motion:

- Orbit, pan and zoom glide to a stop, and the wheel zooms toward the pointer.
- While something is dragged, the view's frame glows and the cursor grabs.
- In the scene list, inspector, dialogs and lists, rows rise into place as they scroll into view (scroll-driven animations, where the browser has them); a new selection slides its inspector in; the menu's items cascade open.
- With "reduce motion" on, there is no inertia, no pulse and no animation; changes apply at once.

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
likuloka.catalogue()              // products, wall types, rules
likuloka.checks()                 // buildability issues
likuloka.setRole({ kind: 'client', fixed: false })   // or { kind: 'designer' }
likuloka.versions.list()          // versions of the open project
likuloka.drawings()               // [{ id, title, svg }]
likuloka.ifc()                    // the IFC4 file as text
likuloka.dxf()                    // every plan as a DXF file; dxf([levelId]) for one level
likuloka.save()                   // to the cloud or this browser, wherever the project lives
likuloka.cloud.state(); likuloka.cloud.signIn(email, password); likuloka.cloud.invite('client')
likuloka.focus(id)                // points the camera at a node
likuloka.stats()                  // what each system updated, and the ids changed in the last frame that changed any
likuloka.project(levelId, x, y)   // the screen position of a plan point
likuloka.backend()                // 'WebGPU' or 'WebGL 2'
```

## Tests

| Suite | What it checks |
|---|---|
| `npm test` | Builds, then `tests/e2e.cjs` serves `out/` and drives the editor in Chromium on WebGPU: the hierarchy, the Roomlines import, dirty tracking (one edit updates one entity), undo and redo, real mouse drags of walls, wall ends, slab corners, edge midpoints, zones and doors, doors and windows and their options and rules, measurements, the catalogue, build-ups, the fitting gap, checks, the client view, versions with comparison, approval and restore, the schedule and its CSV, drawings, the DXF (parsed with dxf-parser: units, layers, door swings, tags, true size), the IFC file (parsed and meshed with web-ifc), projects and files, older scenes, stack, explode and solo, the wall tool, persistence and the phone layout. |
| `npm run test:webgl` | The same, on the WebGL 2 fallback. |
| `npm run test:rules` | `tests/rules.test.cjs`: every Firestore rule, against the Firestore emulator. |
| `npm run test:cloud` | `tests/cloud.e2e.cjs`: a designer and a client in two browsers against the Auth, Firestore and Functions emulators: accounts, moving a project to the cloud, share links, joining, the client's limits in the editor and on the server (a modified editor's moved wall and custom size are refused by `saveScene`), saving, the notice and refusal when someone else saved, versions and approval in the cloud, removing a member, and reloads. |
| `npm run test:all` | All four. |

Headless Chromium has no GPU here, so the tests use SwiftShader's Vulkan adapter for WebGPU. If that browser cannot start, they run on WebGL 2. The Firebase emulators need Java.
