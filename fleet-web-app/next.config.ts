import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The parent repo has its own package-lock.json; pin the workspace root to
  // this app so Next.js doesn't infer the monorepo root by mistake.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
