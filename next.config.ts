import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // A stray package-lock.json in the home folder confuses Next's root detection.
  outputFileTracingRoot: __dirname,
  // This PC has little free memory: build with webpack's memory savers. Type checking runs separately (tsc).
  experimental: { webpackMemoryOptimizations: true, cpus: 1 },
  typescript: { ignoreBuildErrors: process.env.TGD_SKIP_TYPECHECK === "1" },
};

export default nextConfig;
