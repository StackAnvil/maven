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
const group = "io.github.stackanvil";
const groupPath = "io/github/stackanvil";
const stateFile = join(root, "imported-releases.json");

interface Manifest {
  target: string;
  artifacts: { file: string; sha256: string }[];
}

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

function rewritePom(source: string, artifactId: string, version: string): string {
  return source
    .replace(/  <!-- This module was also published[\s\S]*?  <!-- do_not_remove: published-with-gradle-metadata -->\n/, "")
    .replace(/<groupId>[^<]+<\/groupId>/, `<groupId>${group}</groupId>`)
    .replace(/<artifactId>[^<]+<\/artifactId>/, `<artifactId>${artifactId}</artifactId>`)
    .replace(/<version>[^<]+<\/version>/, `<version>${version}</version>`);
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

async function importProject(tag: string, project: (typeof projects)[number]): Promise<void> {
  const archive = join(incoming, `${project}.tar.gz`);
  const extracted = join(incoming, project);
  await mkdir(extracted, { recursive: true });
  await run("tar", ["-xzf", archive, "-C", extracted]);
  const manifest = JSON.parse(await readFile(join(extracted, "manifest.json"), "utf8")) as Manifest;
  if (manifest.target !== project || manifest.artifacts.length !== 1) {
    throw new Error(`Expected one fully patched artifact for ${project}`);
  }
  const artifact = manifest.artifacts[0]!;
  if (!artifact.file.endsWith("-StackAnvil.jar")) throw new Error(`Unbranded JAR: ${artifact.file}`);
  const jar = await readFile(join(extracted, artifact.file));
  if (checksum(jar, "sha256") !== artifact.sha256) throw new Error(`SHA-256 mismatch: ${artifact.file}`);
  const artifactId = `${project}-stackanvil`;
  const version = tag.slice("stack-v".length);
  const versionDir = join(site, groupPath, artifactId, version);
  if (existsSync(versionDir)) throw new Error(`Release ${tag} already has Maven files for ${project}`);
  await mkdir(versionDir, { recursive: true });
  const jarFile = join(versionDir, `${artifactId}-${version}.jar`);
  const pomFile = join(versionDir, `${artifactId}-${version}.pom`);
  await copyFile(join(extracted, artifact.file), jarFile);
  await writeFile(pomFile, rewritePom(await readFile(join(extracted, "pom.xml"), "utf8"), artifactId, version));
  await writeChecksums(jarFile);
  await writeChecksums(pomFile);
  await updateMetadata(artifactId);
}

const imported = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) as string[] : [];
const releases = JSON.parse(await run("gh", ["release", "list", "--repo", "StackAnvil/patches", "--order", "asc", "--limit", "1000", "--json", "tagName,isDraft,isPrerelease"])) as { tagName: string; isDraft: boolean; isPrerelease: boolean }[];
for (const release of releases) {
  const tag = release.tagName;
  if (release.isDraft || release.isPrerelease || !/^stack-v\d+\.\d+\.\d+$/.test(tag) || imported.includes(tag)) continue;
  await rm(incoming, { recursive: true, force: true });
  await mkdir(incoming, { recursive: true });
  await run("gh", ["release", "download", tag, "--repo", "StackAnvil/patches", "--pattern", "*.tar.gz", "--dir", incoming]);
  for (const project of projects) await importProject(tag, project);
  imported.push(tag);
  await writeFile(stateFile, `${JSON.stringify(imported, null, 2)}\n`);
  console.log(`Imported ${tag}`);
}
await rm(incoming, { recursive: true, force: true });
