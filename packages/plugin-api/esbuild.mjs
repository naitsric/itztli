/**
 * For plugins that are bundled: makes `import … from "@codemirror/view"` (and
 * the other shared modules) use the app's copy. A second copy of CodeMirror
 * in a plugin would not work with the editor.
 *
 *   import { build } from "esbuild";
 *   import { sharedModules } from "@itztli/plugin-api/esbuild";
 *
 *   await build({
 *     entryPoints: ["src/main.ts"],
 *     outfile: "main.js",
 *     bundle: true,
 *     format: "esm",
 *     plugins: [sharedModules()],
 *   });
 */
export function sharedModules() {
  const shared = /^(@codemirror\/(autocomplete|commands|language|lint|search|state|view)|@lezer\/(common|highlight|markdown))$/;
  return {
    name: "itztli-shared-modules",
    setup(build) {
      build.onResolve({ filter: shared }, ({ path }) => ({ path, namespace: "itztli-shared" }));
      build.onLoad({ filter: /.*/, namespace: "itztli-shared" }, ({ path }) => ({
        contents: `module.exports = globalThis.itztli.modules[${JSON.stringify(path)}];`,
        loader: "js",
      }));
    },
  };
}
