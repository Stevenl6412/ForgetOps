import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sourceExtensions = /\.(?:cts|mts|tsx?|jsx?)$/;

const sourceRules = [
  {
    directory: "packages/domain/src",
    allowedWorkspaceImports: new Set<string>(),
    allowedExternalPackages: new Set(["canonicalize"]),
  },
  {
    directory: "packages/application/src",
    allowedWorkspaceImports: new Set(["@forgetops/domain"]),
    allowedExternalPackages: new Set<string>(),
  },
  {
    directory: "packages/contracts/src",
    allowedWorkspaceImports: new Set([
      "@forgetops/application",
      "@forgetops/domain",
    ]),
    allowedExternalPackages: undefined,
  },
] as const;

describe("clean architecture dependencies", () => {
  it("keeps domain and application dependencies pointing inward", async () => {
    const violations: string[] = [];

    for (const rule of sourceRules) {
      for (const file of await sourceFiles(
        resolve(repositoryRoot, rule.directory),
      )) {
        const source = await readFile(file, "utf8");
        for (const specifier of importSpecifiers(source)) {
          if (specifier.startsWith(".") || specifier.startsWith("node:"))
            continue;
          if (
            specifier.startsWith("@forgetops/") &&
            !rule.allowedWorkspaceImports.has(workspacePackage(specifier))
          ) {
            violations.push(
              `${relative(repositoryRoot, file)} imports forbidden workspace package ${specifier}`,
            );
          } else if (
            !specifier.startsWith("@forgetops/") &&
            rule.allowedExternalPackages !== undefined &&
            !rule.allowedExternalPackages.has(specifier)
          ) {
            violations.push(
              `${relative(repositoryRoot, file)} imports external package ${specifier}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps the workspace dependency graph cycle-free", async () => {
    const manifests = await workspaceManifests();
    const packageNames = new Set(manifests.map((manifest) => manifest.name));
    const graph = new Map(
      manifests.map((manifest) => [
        manifest.name,
        Object.keys(manifest.dependencies ?? {}).filter((dependency) =>
          packageNames.has(dependency),
        ),
      ]),
    );

    expect(findCycles(graph)).toEqual([]);
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectory(error)) return [];
    throw error;
  }

  const files = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(sourceExtensions.test(entry.name) ? [path] : []);
    }),
  );
  return files.flat();
}

function importSpecifiers(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^"'`;]*?\sfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]),
  );
}

function workspacePackage(specifier: string): string {
  return specifier.split("/", 2).join("/");
}

function isMissingDirectory(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

interface WorkspaceManifest {
  name: string;
  dependencies?: Record<string, string>;
}

async function workspaceManifests(): Promise<WorkspaceManifest[]> {
  const manifestFiles = (
    await Promise.all(
      ["apps", "packages", "sdk"].map(async (workspaceDirectory) => {
        const directory = resolve(repositoryRoot, workspaceDirectory);
        const entries = await readdir(directory, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => resolve(directory, entry.name, "package.json"));
      }),
    )
  ).flat();

  return Promise.all(
    manifestFiles.map(async (file) => {
      const manifest = JSON.parse(
        await readFile(file, "utf8"),
      ) as WorkspaceManifest;
      if (!manifest.name) {
        throw new Error(
          `Missing package name in ${relative(repositoryRoot, file)}`,
        );
      }
      return manifest;
    }),
  );
}

function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];

  function visit(packageName: string, path: readonly string[]): void {
    if (visiting.has(packageName)) {
      cycles.push([...path, packageName].join(" -> "));
      return;
    }
    if (visited.has(packageName)) return;

    visiting.add(packageName);
    for (const dependency of graph.get(packageName) ?? []) {
      visit(dependency, [...path, packageName]);
    }
    visiting.delete(packageName);
    visited.add(packageName);
  }

  for (const packageName of graph.keys()) visit(packageName, []);
  return cycles;
}
