import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
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
};

export default nextConfig;
