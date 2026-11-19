/** Static export: `next build` writes a plain site to out/, so any static host can serve it. */
const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
