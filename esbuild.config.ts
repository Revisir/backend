import * as esbuild from "esbuild";

const shared: esbuild.BuildOptions = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  minify: true,
  packages: "external",
};

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: ["src/instrumentation.ts"],
    outfile: "dist/instrumentation.js",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["src/lambda/fileProcessor.ts"],
    outfile: "dist/fileProcessor.js",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["src/lambda/urlProcessor.ts"],
    outfile: "dist/urlProcessor.js",
  }),
]);
