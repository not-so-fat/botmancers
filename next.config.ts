import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
