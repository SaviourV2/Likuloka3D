/** Static export: `next build` writes a plain site to out/, so any static host can serve it. */
const nextConfig = {
  output: 'export',
  // GitHub Pages serves the site under /<repository>/; the deploy workflow passes that path here.
  basePath: process.env.PAGES_BASE_PATH || '',
  reactStrictMode: true,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
