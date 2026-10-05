// @akili-spec changes/cicd-executor-poc requirements NFR-01, NFR-08; design §4.2, DD-19
//
// Guard scripts (executor/scripts/guards/*.mjs) run as plain Node ESM, with
// no prior `npm run build` and no new runtime dependency (T-21 scope: "no
// new runtime deps"). To let them REUSE real TypeScript domain/test-support
// modules instead of duplicating their logic in JS, this helper transpiles
// TypeScript source to ESM JavaScript in memory via the TypeScript compiler
// API — `typescript` is already a devDependency (ajv-factory.ts,
// schema-validation.ts and the rest of the Executor already depend on it to
// build), so this is reuse, not a new dependency — and imports the result
// from a throwaway temp file/directory.
//
// Two entry points:
//   - loadTsModule(absoluteTsPath): a SINGLE file with no relative VALUE
//     imports (type-only imports, e.g. `import type { X } from "./y.js"`,
//     are erased by the compiler and are fine; a real `import { x } from
//     "./y.js"` is NOT, since "./y.js" would not exist next to the temp
//     file). Used for self-contained files like
//     test/support/dockerfile-boundary-scanner.ts and
//     src/application/definition-service/schema-validation.ts.
//   - loadTsDirectoryModule(absoluteDirPath, entryBaseName): transpiles
//     EVERY sibling .ts file in one flat directory into a temp mirror
//     directory (same file names, ".js" extension — matching the ".js"
//     import specifiers TypeScript/NodeNext already requires source files
//     to use, so no specifier rewriting is needed), adds a
//     `{"type":"module"}` package.json, and imports `entryBaseName.js` from
//     it. Used for src/application/definition-service (index.ts + its
//     sibling schema-validation.ts/semantic-rules.ts/registry-rules.ts/
//     reference-resolution.ts), none of which import outside that
//     directory except type-only (erased).
import ts from "typescript";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// A transpiled module may `import` a BARE specifier (e.g. "ajv/dist/2020.js",
// "yaml") that Node resolves by walking up from the importing file looking
// for a "node_modules" directory. An OS temp dir has no such ancestor, so
// the temp output must live under `anchorDir`'s OWN node_modules — which
// also means it is automatically covered by the existing `node_modules/`
// .gitignore rule, with no new entry needed. `anchorDir` defaults to the
// OS temp dir for callers (if any) that only ever transpile fully
// self-contained files with zero runtime imports.
function tempRoot(anchorDir, prefix) {
  if (!anchorDir) return mkdtempSync(path.join(tmpdir(), prefix));
  const cacheDir = path.join(anchorDir, "node_modules", ".cicd-guard-cache");
  mkdirSync(cacheDir, { recursive: true });
  return mkdtempSync(path.join(cacheDir, prefix));
}

// transpileModule is a single-file, no-resolution transform (it never looks
// at a tsconfig or a package.json "type" field), so NodeNext's CJS-vs-ESM
// detection does not apply here — ESNext/Bundler always emits plain ESM
// `import`/`export` syntax, which is what the temp files (and their sibling
// `{"type":"module"}` package.json, for loadTsDirectoryModule) expect.
const COMPILER_OPTIONS = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

function transpile(source, fileName) {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: COMPILER_OPTIONS,
    fileName,
    reportDiagnostics: true,
  });
  const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const messages = errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    throw new Error(`loadTsModule: failed to transpile ${fileName}:\n${messages.join("\n")}`);
  }
  return outputText;
}

/**
 * Loads a single, dependency-free (no relative VALUE imports) TypeScript
 * file as an ES module. `anchorDir` (an ancestor whose node_modules must be
 * reachable, e.g. the executor/ package root) is required whenever the file
 * imports a bare specifier like "node:module" is fine without it, but a
 * package like "ajv" is not.
 */
export async function loadTsModule(absoluteTsPath, anchorDir) {
  const source = readFileSync(absoluteTsPath, "utf8");
  const outputText = transpile(source, absoluteTsPath);
  const dir = tempRoot(anchorDir, "cicd-guard-");
  const outFile = path.join(dir, `${path.basename(absoluteTsPath, ".ts")}.mjs`);
  writeFileSync(outFile, outputText, "utf8");
  return import(pathToFileURL(outFile).href);
}

/** Loads a flat directory of mutually-referencing TypeScript siblings, returning the entry module. */
export async function loadTsDirectoryModule(absoluteDirPath, entryBaseName, anchorDir) {
  const dir = tempRoot(anchorDir, "cicd-guard-dir-");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  for (const fileName of readdirSync(absoluteDirPath)) {
    if (!fileName.endsWith(".ts")) continue;
    const absFile = path.join(absoluteDirPath, fileName);
    const outputText = transpile(readFileSync(absFile, "utf8"), absFile);
    writeFileSync(path.join(dir, fileName.replace(/\.ts$/, ".js")), outputText, "utf8");
  }
  return import(pathToFileURL(path.join(dir, `${entryBaseName}.js`)).href);
}
