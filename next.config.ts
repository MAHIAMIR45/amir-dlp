import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // ffmpeg-static ships a native binary — must stay outside the webpack
  // bundle so its __dirname-resolved path stays valid in the lambda.
  serverExternalPackages: ["ffmpeg-static"],
  // The yt-dlp engine files must reach the Vercel lambda bundle: the
  // standalone binary, the bundled ffmpeg, and the cookie pool.
  outputFileTracingIncludes: {
    "/api/**": [
      "./python/cookies/**",
      "./python/*.py",
      "./python/proxies.txt",
      "./bin/**",
      "./node_modules/ffmpeg-static/**",
    ],
  },
  // Deploy-package slimming: the platform build packs .next/standalone into
  // a tar.gz uploaded to the FC runtime. A 156MB package exceeded the
  // deploy limit ("problem deploying the code"). These paths are never
  // needed at runtime: sandbox folders (skills/upload/download/examples),
  // typescript (build-time only) and sharp/@img (next/image is not used).
  // bin/warp STAYS in the bundle — the wireproxy WARP tunnel is the app's
  // primary clean exit on every long-lived host now.
  outputFileTracingExcludes: {
    "/**": [
      "./skills/**",
      "./upload/**",
      "./download/**",
      "./examples/**",
      "./node_modules/typescript/**",
      "node_modules/typescript/**",
      "**/node_modules/typescript/**",
      "./node_modules/@img/**",
      "node_modules/@img/**",
      "**/node_modules/@img/**",
      "./node_modules/sharp/**",
      "node_modules/sharp/**",
      "**/node_modules/sharp/**",
    ],
    // The API routes are where the heavy node_modules tracing happens —
    // the "/**" key alone did not strip them from the FC artifact.
    "/api/**": [
      "./skills/**",
      "./upload/**",
      "./download/**",
      "./examples/**",
      "./node_modules/typescript/**",
      "./node_modules/@img/**",
      "./node_modules/sharp/**",
    ],
  },
};

export default nextConfig;
