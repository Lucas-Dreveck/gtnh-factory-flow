import type { NextConfig } from "next";

const datasetBackendUrl = process.env.GTNH_DATASET_BACKEND_URL?.replace(/\/+$/, "");

// Normally the repo. Set it to a parent directory when public/datasets/gtnh is a symlink
// pointing outside the repo, which Turbopack refuses to trace.
const tracingRoot = process.env.GTNH_TRACING_ROOT ?? process.cwd();

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  experimental: {
    // The proxy buffers request bodies; plan uploads run to 32 MB and must never be cut short.
    proxyClientMaxBodySize: "64mb",
  },
  outputFileTracingRoot: tracingRoot,
  turbopack: {
    root: tracingRoot,
  },
  async headers() {
    return [
      {
        source: "/datasets/gtnh/:version/textures/icons/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // Rendered item and fluid art carries a content hash in the basename
        // (the pipeline renames on any byte change), so these are immutable
        // too - and they are most of what a returning browser re-downloads.
        source: "/datasets/gtnh/:version/textures/rendered/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
  async rewrites() {
    if (!datasetBackendUrl) {
      return [];
    }

    return {
      beforeFiles: [
        {
          source: "/api/datasets/:path*",
          destination: `${datasetBackendUrl}/api/datasets/:path*`,
        },
        {
          source: "/datasets/gtnh/:path*",
          destination: `${datasetBackendUrl}/datasets/gtnh/:path*`,
        },
      ],
      afterFiles: [],
    };
  },
};

export default nextConfig;
