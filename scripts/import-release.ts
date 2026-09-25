import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(import.meta.dir, "..");
const site = join(root, "site");
const incoming = join(root, ".incoming");
const projects = ["viabedrock", "viafabricplus-bedrock", "cubeconverter", "viafabricplus"] as const;
const sourceRepository = "StackAnvil/patches";
const group = "io.github.stackanvil";
const groupPath = "io/github/stackanvil";
const stateFile = join(root, "imported-releases.json");

interface Manifest {
  target: string;
  artifacts: { file: string; sha256: string }[];
  auxiliaryArtifacts?: { file: string; sha256: string }[];
}

const stackDependencies = new Map([
  ["org.oryxel.cube:cubeconverter", "cubeconverter-stackanvil"],
  ["net.raphimc:ViaBedrock", "viabedrock-stackanvil"],
  ["com.viaversion:viafabricplus", "viafabricplus-stackanvil"],
  ["com.viaversion:viafabricplus-api", "viafabricplus-api-stackanvil"],
]);

async function run(program: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(program, args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

function checksum(bytes: Buffer, algorithm: "sha1" | "sha256"): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

async function writeChecksums(file: string): Promise<void> {
  const bytes = await readFile(file);
  for (const algorithm of ["sha1", "sha256"] as const) {
    await writeFile(`${file}.${algorithm}`, `${checksum(bytes, algorithm)}\n`);
  }
}

export function rewritePom(source: string, artifactId: string, version: string): string {
  return source
    .replace(/  <!-- This module was also published[\s\S]*?  <!-- do_not_remove: published-with-gradle-metadata -->\n/, "")
    .replace(/<groupId>[^<]+<\/groupId>/, `<groupId>${group}</groupId>`)
    .replace(/<artifactId>[^<]+<\/artifactId>/, `<artifactId>${artifactId}</artifactId>`)
    .replace(/<version>[^<]+<\/version>/, `<version>${version}</version>`)
    .replace(/<dependency>([\s\S]*?)<\/dependency>/g, (dependency) => {
      const oldGroup = /<groupId>([^<]+)<\/groupId>/.exec(dependency)?.[1];
      const oldArtifact = /<artifactId>([^<]+)<\/artifactId>/.exec(dependency)?.[1];
      const replacement = stackDependencies.get(`${oldGroup}:${oldArtifact}`);
      if (!replacement) return dependency;
      return dependency
        .replace(/<groupId>[^<]+<\/groupId>/, `<groupId>${group}</groupId>`)
        .replace(/<artifactId>[^<]+<\/artifactId>/, `<artifactId>${replacement}</artifactId>`)
        .replace(/<version>[^<]+<\/version>/, `<version>${version}</version>`);
    });
}

async function updateMetadata(artifactId: string): Promise<void> {
  const dir = join(site, groupPath, artifactId);
  const versions = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = versions.at(-1)!;
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <groupId>${group}</groupId>\n  <artifactId>${artifactId}</artifactId>\n  <versioning>\n    <latest>${latest}</latest>\n    <release>${latest}</release>\n    <versions>\n${versions.map((version) => `      <version>${version}</version>`).join("\n")}\n    </versions>\n    <lastUpdated>${timestamp}</lastUpdated>\n  </versioning>\n</metadata>\n`;
  const metadata = join(dir, "maven-metadata.xml");
  await writeFile(metadata, xml);
  await writeChecksums(metadata);
}

async function importJar(source: string, pomSource: string, artifact: { file: string; sha256: string },
  artifactId: string, version: string): Promise<void> {
  if (!artifact.file.endsWith("-StackAnvil.jar")) throw new Error(`Unbranded JAR: ${artifact.file}`);
  const jar = await readFile(source);
  if (checksum(jar, "sha256") !== artifact.sha256) throw new Error(`SHA-256 mismatch: ${artifact.file}`);
  const versionDir = join(site, groupPath, artifactId, version);
  if (existsSync(versionDir)) throw new Error(`Release ${version} already has Maven files for ${artifactId}`);
  await mkdir(versionDir, { recursive: true });
  const jarFile = join(versionDir, `${artifactId}-${version}.jar`);
  const pomFile = join(versionDir, `${artifactId}-${version}.pom`);
  await copyFile(source, jarFile);
  await writeFile(pomFile, rewritePom(await readFile(pomSource, "utf8"), artifactId, version));
  await writeChecksums(jarFile);
  await writeChecksums(pomFile);
  await updateMetadata(artifactId);
}

async function importProject(tag: string, project: (typeof projects)[number]): Promise<void> {
  const built = join(incoming, "build", project);
  const manifest = JSON.parse(await readFile(join(built, "manifest.json"), "utf8")) as Manifest;
  if (manifest.target !== project || manifest.artifacts.length !== 1) {
    throw new Error(`Expected one fully patched artifact for ${project}`);
  }
  const version = tag.slice("stack-v".length);
  const artifact = manifest.artifacts[0]!;
  await importJar(join(incoming, "jars", artifact.file), join(built, "pom.xml"), artifact,
    `${project}-stackanvil`, version);
  if (project === "viafabricplus") {
    const api = manifest.auxiliaryArtifacts?.find(({ file }) => file.startsWith("api/"));
    if (!api) throw new Error(`Release ${tag} is missing the ViaFabricPlus API artifact`);
    await importJar(join(built, api.file), join(built, "api", "pom.xml"), api,
      "viafabricplus-api-stackanvil", version);
  }
}

async function downloadReleaseBuild(tag: string): Promise<void> {
  const runs = JSON.parse(await run("gh", ["run", "list", "--repo", sourceRepository, "--workflow", "release.yml",
    "--branch", tag, "--event", "push", "--status", "success", "--limit", "10", "--json", "databaseId,headBranch"])) as
    { databaseId: number; headBranch: string }[];
  let runId = runs.find((entry) => entry.headBranch === tag)?.databaseId;
  if (!runId) {
    const runNumber = /^stack-v0\.0\.(\d+)$/.exec(tag)?.[1];
    if (runNumber) {
      const dispatched = JSON.parse(await run("gh", ["run", "list", "--repo", sourceRepository,
        "--workflow", "release.yml", "--event", "workflow_dispatch", "--status", "success",
        "--limit", "1000", "--json", "databaseId,number"])) as { databaseId: number; number: number }[];
      runId = dispatched.find((entry) => entry.number === Number(runNumber))?.databaseId;
    }
  }
  if (!runId) throw new Error(`No successful release build found for ${tag}`);
  await run("gh", ["run", "download", String(runId), "--repo", sourceRepository,
    "--name", "release-bundle", "--dir", join(incoming, "build")]);
}

async function downloadReleaseInputs(tag: string): Promise<void> {
  await downloadReleaseBuild(tag);
  await mkdir(join(incoming, "jars"), { recursive: true });
  await run("gh", ["release", "download", tag, "--repo", sourceRepository,
    "--pattern", "*-StackAnvil.jar", "--dir", join(incoming, "jars")]);
  const jars = (await readdir(join(incoming, "jars"))).filter((file) => file.endsWith(".jar"));
  if (jars.length !== projects.length) throw new Error(`Expected ${projects.length} release JARs for ${tag}, found ${jars.length}`);
}

export async function validateReleaseInputs(tag: string, directory = incoming): Promise<void> {
  const expected = new Set<string>();
  for (const project of projects) {
    const built = join(directory, "build", project);
    const manifest = JSON.parse(await readFile(join(built, "manifest.json"), "utf8")) as Manifest;
    if (manifest.target !== project || manifest.artifacts.length !== 1) {
      throw new Error(`Expected one fully patched artifact for ${project}`);
    }
    const artifact = manifest.artifacts[0]!;
    if (expected.has(artifact.file)) throw new Error(`Duplicate release JAR: ${artifact.file}`);
    expected.add(artifact.file);
    const bytes = await readFile(join(directory, "jars", artifact.file));
    if (checksum(bytes, "sha256") !== artifact.sha256) throw new Error(`SHA-256 mismatch: ${artifact.file}`);
    await readFile(join(built, "pom.xml"));
    if (project === "viafabricplus") {
      const api = manifest.auxiliaryArtifacts?.find(({ file }) => file.startsWith("api/"));
      if (!api) throw new Error(`Release ${tag} is missing the ViaFabricPlus API artifact`);
      const apiBytes = await readFile(join(built, api.file));
      if (checksum(apiBytes, "sha256") !== api.sha256) throw new Error(`SHA-256 mismatch: ${api.file}`);
      await readFile(join(built, "api", "pom.xml"));
    }
  }
  const actual = (await readdir(join(directory, "jars"))).filter((file) => file.endsWith(".jar"));
  if (actual.some((file) => !expected.has(file))) throw new Error(`Unexpected release JAR for ${tag}`);
}

async function main(): Promise<void> {
  const imported = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) as string[] : [];
  const releases = JSON.parse(await run("gh", ["release", "list", "--repo", sourceRepository, "--order", "asc", "--limit", "1000", "--json", "tagName,isDraft,isPrerelease"])) as { tagName: string; isDraft: boolean; isPrerelease: boolean }[];
  for (const release of releases) {
    const tag = release.tagName;
    if (release.isDraft || release.isPrerelease || !/^stack-v\d+\.\d+\.\d+$/.test(tag) || imported.includes(tag)) continue;
    await rm(incoming, { recursive: true, force: true });
    await mkdir(incoming, { recursive: true });
    await downloadReleaseInputs(tag);
    await validateReleaseInputs(tag);
    for (const project of projects) await importProject(tag, project);
    imported.push(tag);
    await writeFile(stateFile, `${JSON.stringify(imported, null, 2)}\n`);
    console.log(`Imported ${tag}`);
  }
  await rm(incoming, { recursive: true, force: true });
}

if (import.meta.main) await main();
