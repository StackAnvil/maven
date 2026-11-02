import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(import.meta.dir, "..");
const site = join(root, "site");
const incoming = join(root, ".incoming");
const projects = ["viabedrock", "viafabricplus-bedrock", "cubeconverter", "viaproxy"] as const;
const sourceRepository = "StackAnvil/patches";
const group = "io.github.stackanvil";
const groupPath = "io/github/stackanvil";
const stateFile = join(root, "imported-releases.json");

interface Manifest {
  target: string;
  artifacts: { file: string; sha256: string }[];
}

interface ReleaseRun {
  databaseId: number;
  headBranch?: string;
  number?: number;
}

interface ReleaseJob {
  name: string;
  conclusion: string;
}

const stackDependencies = new Map([
  ["org.oryxel.cube:cubeconverter", "cubeconverter-stackanvil"],
  ["net.raphimc:ViaBedrock", "viabedrock-stackanvil"],
]);

async function run(program: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(program, args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

function checksum(bytes: Buffer, algorithm: "sha1" | "sha256"): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

async function writeChecksums(file: string, bytes?: Buffer): Promise<void> {
  const contents = bytes ?? await readFile(file);
  for (const algorithm of ["sha1", "sha256"] as const) {
    await writeFile(`${file}.${algorithm}`, `${checksum(contents, algorithm)}\n`);
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

export async function importJar(source: string, pomSource: string, artifact: { file: string; sha256: string },
  artifactId: string, version: string, repository = site): Promise<void> {
  if (!artifact.file.endsWith("-StackAnvil.jar")) throw new Error(`Unbranded JAR: ${artifact.file}`);
  const jar = await readFile(source);
  if (checksum(jar, "sha256") !== artifact.sha256) throw new Error(`SHA-256 mismatch: ${artifact.file}`);
  const versionDir = join(repository, groupPath, artifactId, version);
  if (existsSync(versionDir)) throw new Error(`Release ${version} already has Maven files for ${artifactId}`);
  await mkdir(versionDir, { recursive: true });
  const jarFile = join(versionDir, `${artifactId}-${version}.jar`);
  const pomFile = join(versionDir, `${artifactId}-${version}.pom`);
  const download = `https://github.com/${sourceRepository}/releases/download/stack-v${version}/${encodeURIComponent(artifact.file)}`;
  await writeFile(`${jarFile}.url`, `${download}\n`);
  await writeFile(pomFile, rewritePom(await readFile(pomSource, "utf8"), artifactId, version));
  await writeChecksums(jarFile, jar);
  await writeChecksums(pomFile);
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
  await updateMetadata(`${project}-stackanvil`);
}

export function hasPublishedRelease(jobs: ReleaseJob[]): boolean {
  return ["build", "publish"].every((name) => jobs.some((job) => job.name === name && job.conclusion === "success"));
}

export async function findPublishedRun(runs: ReleaseRun[], loadJobs: (runId: number) => Promise<ReleaseJob[]>): Promise<number | undefined> {
  for (const candidate of runs) {
    if (hasPublishedRelease(await loadJobs(candidate.databaseId))) return candidate.databaseId;
  }
}

async function downloadReleaseBuild(tag: string): Promise<boolean> {
  let runs = JSON.parse(await run("gh", ["run", "list", "--repo", sourceRepository, "--workflow", "release.yml",
    "--branch", tag, "--event", "push", "--status", "completed", "--limit", "10", "--json", "databaseId,headBranch"])) as ReleaseRun[];
  runs = runs.filter((entry) => entry.headBranch === tag);
  if (!runs.length) {
    const runNumber = /^stack-v0\.0\.(\d+)$/.exec(tag)?.[1];
    if (runNumber) {
      const dispatched = JSON.parse(await run("gh", ["run", "list", "--repo", sourceRepository,
        "--workflow", "release.yml", "--event", "workflow_dispatch", "--status", "completed",
        "--limit", "1000", "--json", "databaseId,number"])) as ReleaseRun[];
      runs = dispatched.filter((entry) => entry.number === Number(runNumber));
    }
  }
  const runId = await findPublishedRun(runs, async (id) => {
    const details = JSON.parse(await run("gh", ["run", "view", String(id), "--repo", sourceRepository,
      "--json", "jobs"])) as { jobs: ReleaseJob[] };
    return details.jobs;
  });
  if (!runId) return false;
  await run("gh", ["run", "download", String(runId), "--repo", sourceRepository,
    "--name", "release-bundle", "--dir", join(incoming, "build")]);
  return true;
}

async function downloadReleaseInputs(tag: string): Promise<boolean> {
  if (!await downloadReleaseBuild(tag)) return false;
  await mkdir(join(incoming, "jars"), { recursive: true });
  const patterns: string[] = [];
  for (const project of projects) {
    const manifest = JSON.parse(await readFile(join(incoming, "build", project, "manifest.json"), "utf8")) as Manifest;
    if (manifest.target !== project || manifest.artifacts.length !== 1) {
      throw new Error(`Expected one fully patched artifact for ${project}`);
    }
    patterns.push("--pattern", manifest.artifacts[0]!.file);
  }
  await run("gh", ["release", "download", tag, "--repo", sourceRepository,
    ...patterns, "--dir", join(incoming, "jars")]);
  const jars = (await readdir(join(incoming, "jars"))).filter((file) => file.endsWith(".jar"));
  if (jars.length !== projects.length) throw new Error(`Expected ${projects.length} release JARs for ${tag}, found ${jars.length}`);
  return true;
}

export async function validateReleaseInputs(directory = incoming): Promise<void> {
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
  }
  const actual = (await readdir(join(directory, "jars"))).filter((file) => file.endsWith(".jar"));
  const unexpected = actual.find((file) => !expected.has(file));
  if (unexpected) throw new Error(`Unexpected release JAR: ${unexpected}`);
}

async function main(): Promise<void> {
  const requestedTag = process.argv[2] || undefined;
  if (requestedTag && !/^stack-v\d+\.\d+\.\d+$/.test(requestedTag)) throw new Error(`Invalid release tag: ${requestedTag}`);
  const imported = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) as string[] : [];
  const releases = JSON.parse(await run("gh", ["release", "list", "--repo", sourceRepository, "--order", "asc", "--limit", "1000", "--json", "tagName,isDraft,isPrerelease"])) as { tagName: string; isDraft: boolean; isPrerelease: boolean }[];
  for (const release of releases) {
    const tag = release.tagName;
    if (requestedTag && tag !== requestedTag) continue;
    if (release.isDraft || release.isPrerelease || !/^stack-v\d+\.\d+\.\d+$/.test(tag) || imported.includes(tag)) continue;
    await rm(incoming, { recursive: true, force: true });
    await mkdir(incoming, { recursive: true });
    if (!await downloadReleaseInputs(tag)) {
      console.warn(`Skipping ${tag}: no completed build and release publication; retrying on the next import`);
      continue;
    }
    await validateReleaseInputs();
    for (const project of projects) await importProject(tag, project);
    imported.push(tag);
    await writeFile(stateFile, `${JSON.stringify(imported, null, 2)}\n`);
    console.log(`Imported ${tag}`);
  }
  if (requestedTag && !imported.includes(requestedTag)) throw new Error(`Release was not imported: ${requestedTag}`);
  await rm(incoming, { recursive: true, force: true });
}

if (import.meta.main) await main();
