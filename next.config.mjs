/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow the app to import from lib/ using Node.js ESM resolution.
  // The .js extensions in import paths are required by NodeNext resolution.
  experimental: {
    // serverComponentsExternalPackages ensures @anthropic-ai/sdk is bundled
    // correctly on the server side (it uses conditional exports).
    serverComponentsExternalPackages: ['@anthropic-ai/sdk'],
  },
};

export default nextConfig;
