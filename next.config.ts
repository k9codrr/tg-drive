import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // A stray package-lock.json in the home folder confuses Next's root detection.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
