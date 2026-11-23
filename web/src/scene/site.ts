/**
 * Where the site's own files are. The pages live at different depths (the welcome
 * page at /, the editor at /editor/), so files from public/ are fetched from the
 * site's root, under the base path it is deployed at (GitHub Pages serves it
 * under /<repository>/), never relative to the page.
 */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** The URL of a file from public/, such as `catalogue.json` or `models/bed.glb`. */
export const asset = (path: string) => `${BASE}/${path.replace(/^\/+/, '')}`;
