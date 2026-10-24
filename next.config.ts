import type { NextConfig } from "next";

// NOT-494: packages/mcp-server/scripts/build-app.mjs sets
// BOTMANCERS_STANDALONE=1 to emit the self-contained server the botmancers
// npm package ships. The checkout's `npm run dev` / `npm start` are unchanged.
const standalone = process.env.BOTMANCERS_STANDALONE === "1";

const nextConfig: NextConfig = {
  // Unoptimized images in the package: the brand PNGs are served as-is, so
  // no platform-specific sharp binary has to ship.
  ...(standalone ? { output: "standalone" as const, outputFileTracingRoot: __dirname, images: { unoptimized: true } } : {}),
  // NOT-518: the Slack SDK (and its ws socket) is loaded from node_modules,
  // not bundled; standalone tracing copies it into the package.
  serverExternalPackages: ["@slack/socket-mode", "@slack/web-api"],
  // The release the core engine reports from /api/health; "dev" in a checkout.
  env: {
    BOTMANCERS_BUILD_VERSION: process.env.BOTMANCERS_BUILD_VERSION || "dev",
    BOTMANCERS_BUILD_COMMIT: process.env.BOTMANCERS_BUILD_COMMIT || "unknown",
  },
  async rewrites() {
    return [
      {
        source: "/favicon.ico",
        destination: "/brand/botmancers-logo-filled-64.png",
      },
    ];
  },
};

export default nextConfig;
