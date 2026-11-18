import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { Clock, Console, Context, Data, Effect, Layer, Schema } from "effect";

const execFileAsync = promisify(execFile);
const root = join(import.meta.dir, "..");
const site = join(root, "site");
const incoming = join(root, ".incoming");
const projects = ["viabedrock", "viafabricplus-bedrock", "cubeconverter", "viaproxy"] as const;
const sourceRepository = "StackAnvil/patches";
const group = "io.github.stackanvil";
const groupPath = "io/github/stackanvil";
const stateFile = join(root, "imported-releases.json");
const releaseTag = /^stack-v\d+\.\d+\.\d+$/;

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A `gh` command failed or could not start. */
export class CommandError extends Data.TaggedError("CommandError")<{
  readonly args: readonly string[];
  readonly cause: unknown;
}> {
  override get message() {
    return describe(this.cause);
  }
}

/** A file system operation failed. */
export class FileError extends Data.TaggedError("FileError")<{
  readonly operation: string;
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Could not ${this.operation} ${this.path}: ${describe(this.cause)}`;
  }
}

/** A file or `gh` response is not valid JSON or has an unexpected shape. */
export class JsonShapeError extends Data.TaggedError("JsonShapeError")<{
  readonly source: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Unexpected JSON shape in ${this.source}`;
  }
}

/** A downloaded JAR does not match the SHA-256 in its build manifest. */
export class ChecksumMismatchError extends Data.TaggedError("ChecksumMismatchError")<{
  readonly file: string;
}> {
  override get message() {
    return `SHA-256 mismatch: ${this.file}`;
  }
}

/** The release or its inputs cannot be imported as requested. */
export class ReleaseImportError extends Data.TaggedError("ReleaseImportError")<{
  readonly message: string;
}> {}

/** Runs the GitHub CLI and returns its trimmed standard output. */
export class GitHubCli extends Context.Service<
  GitHubCli,
  { readonly run: (args: readonly string[]) => Effect.Effect<string, CommandError> }
>()("maven/GitHubCli") {}

export const GitHubCliLive = Layer.succeed(GitHubCli, {
  run: (args) =>
    Effect.tryPromise({
      try: async (signal) =>
        execFileAsync("gh", args, { cwd: root, maxBuffer: 16 * 1024 * 1024, signal }),
      catch: (cause) => new CommandError({ args, cause }),
    }).pipe(Effect.map(({ stdout }) => stdout.trim())),
});

const ArtifactSchema = Schema.Struct({ file: Schema.String, sha256: Schema.String });
const ManifestSchema = Schema.Struct({
  target: Schema.String,
  artifacts: Schema.Array(ArtifactSchema),
});
const ReleaseRunSchema = Schema.Struct({
  databaseId: Schema.Int,
  headBranch: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Int),
});
const ReleaseJobSchema = Schema.Struct({ name: Schema.String, conclusion: Schema.String });
const ReleaseSchema = Schema.Struct({
  tagName: Schema.String,
  isDraft: Schema.Boolean,
  isPrerelease: Schema.Boolean,
});

type Artifact = typeof ArtifactSchema.Type;
type ReleaseRun = typeof ReleaseRunSchema.Type;
type ReleaseJob = typeof ReleaseJobSchema.Type;

/** Parses JSON from a file or the GitHub CLI and checks its shape. */
function parseJson<S extends Schema.Decoder<unknown>>(schema: S, text: string, source: string) {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((cause) => new JsonShapeError({ source, cause })),
  );
}

function fileOperation<A>(
  operation: string,
  path: string,
  run: () => Promise<A>,
): Effect.Effect<A, FileError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new FileError({ operation, path, cause }),
  });
}

const readBytes = (path: string) => fileOperation("read", path, async () => readFile(path));
const readText = (path: string) => fileOperation("read", path, async () => readFile(path, "utf8"));
const write = (path: string, contents: string | Buffer) =>
  fileOperation("write", path, async () => writeFile(path, contents));
const makeDirectory = (path: string) =>
  fileOperation("create", path, async () => mkdir(path, { recursive: true }));
const remove = (path: string) =>
  fileOperation("remove", path, async () => rm(path, { recursive: true, force: true }));
const listDirectory = (path: string) => fileOperation("list", path, async () => readdir(path));
const exists = (path: string) =>
  fileOperation("check", path, async () =>
    stat(path).then(
      () => true,
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      },
    ),
  );

const readManifest = (path: string) =>
  readText(path).pipe(Effect.flatMap((text) => parseJson(ManifestSchema, text, path)));

/** Reads a project's build manifest and returns its single fully patched artifact. */
const readProjectArtifact = Effect.fn("readProjectArtifact")(function* (
  directory: string,
  project: (typeof projects)[number],
) {
  const manifest = yield* readManifest(join(directory, "build", project, "manifest.json"));
  const [artifact] = manifest.artifacts;
  if (manifest.target !== project || manifest.artifacts.length !== 1 || !artifact) {
    return yield* new ReleaseImportError({
      message: `Expected one fully patched artifact for ${project}`,
    });
  }
  return artifact;
});

const stackDependencies = new Map([
  ["org.oryxel.cube:cubeconverter", "cubeconverter-stackanvil"],
  ["net.raphimc:ViaBedrock", "viabedrock-stackanvil"],
]);

function checksum(bytes: Buffer, algorithm: "sha1" | "sha256"): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

const writeChecksums = Effect.fn("writeChecksums")(function* (file: string, bytes?: Buffer) {
  const contents = bytes ?? (yield* readBytes(file));
  for (const algorithm of ["sha1", "sha256"] as const) {
    yield* write(`${file}.${algorithm}`, `${checksum(contents, algorithm)}\n`);
  }
});

export function rewritePom(source: string, artifactId: string, version: string): string {
  return source
    .replace(
      /  <!-- This module was also published[\s\S]*?  <!-- do_not_remove: published-with-gradle-metadata -->\n/,
      "",
    )
    .replace(/<groupId>[^<]+<\/groupId>/, `<groupId>${group}</groupId>`)
    .replace(/<artifactId>[^<]+<\/artifactId>/, `<artifactId>${artifactId}</artifactId>`)
    .replace(/<version>[^<]+<\/version>/, `<version>${version}</version>`)
    .replaceAll(/<dependency>([\s\S]*?)<\/dependency>/g, (dependency) => {
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

const updateMetadata = Effect.fn("updateMetadata")(function* (artifactId: string) {
  const dir = join(site, groupPath, artifactId);
  const entries = yield* fileOperation("list", dir, async () =>
    readdir(dir, { withFileTypes: true }),
  );
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const latest = versions.at(-1);
  if (latest === undefined) {
    return yield* new ReleaseImportError({ message: `No Maven versions for ${artifactId}` });
  }
  const timestamp = new Date(yield* Clock.currentTimeMillis)
    .toISOString()
    .replaceAll(/[-:TZ.]/g, "")
    .slice(0, 14);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <groupId>${group}</groupId>\n  <artifactId>${artifactId}</artifactId>\n  <versioning>\n    <latest>${latest}</latest>\n    <release>${latest}</release>\n    <versions>\n${versions.map((version) => `      <version>${version}</version>`).join("\n")}\n    </versions>\n    <lastUpdated>${timestamp}</lastUpdated>\n  </versioning>\n</metadata>\n`;
  const metadata = join(dir, "maven-metadata.xml");
  yield* write(metadata, xml);
  yield* writeChecksums(metadata);
});

/** Writes the POM, checksums, and release download URL for one verified JAR. */
export const importJar = Effect.fn("importJar")(function* (
  source: string,
  pomSource: string,
  artifact: Artifact,
  artifactId: string,
  version: string,
  repository = site,
) {
  if (!artifact.file.endsWith("-StackAnvil.jar")) {
    return yield* new ReleaseImportError({ message: `Unbranded JAR: ${artifact.file}` });
  }
  const jar = yield* readBytes(source);
  if (checksum(jar, "sha256") !== artifact.sha256) {
    return yield* new ChecksumMismatchError({ file: artifact.file });
  }
  const versionDir = join(repository, groupPath, artifactId, version);
  if (yield* exists(versionDir)) {
    return yield* new ReleaseImportError({
      message: `Release ${version} already has Maven files for ${artifactId}`,
    });
  }
  yield* makeDirectory(versionDir);
  const jarFile = join(versionDir, `${artifactId}-${version}.jar`);
  const pomFile = join(versionDir, `${artifactId}-${version}.pom`);
  const download = `https://github.com/${sourceRepository}/releases/download/stack-v${version}/${encodeURIComponent(artifact.file)}`;
  yield* write(`${jarFile}.url`, `${download}\n`);
  yield* write(pomFile, rewritePom(yield* readText(pomSource), artifactId, version));
  yield* writeChecksums(jarFile, jar);
  yield* writeChecksums(pomFile);
});

const importProject = Effect.fn("importProject")(function* (
  tag: string,
  project: (typeof projects)[number],
) {
  const artifact = yield* readProjectArtifact(incoming, project);
  const version = tag.slice("stack-v".length);
  yield* importJar(
    join(incoming, "jars", artifact.file),
    join(incoming, "build", project, "pom.xml"),
    artifact,
    `${project}-stackanvil`,
    version,
  );
  yield* updateMetadata(`${project}-stackanvil`);
});

export function hasPublishedRelease(jobs: readonly ReleaseJob[]): boolean {
  return ["build", "publish"].every((name) =>
    jobs.some((job) => job.name === name && job.conclusion === "success"),
  );
}

/** Returns the first run whose build and publication jobs both succeeded. */
export const findPublishedRun = Effect.fn("findPublishedRun")(function* <E, R>(
  runs: readonly ReleaseRun[],
  loadJobs: (runId: number) => Effect.Effect<readonly ReleaseJob[], E, R>,
) {
  for (const candidate of runs) {
    if (hasPublishedRelease(yield* loadJobs(candidate.databaseId))) return candidate.databaseId;
  }
  return undefined;
});

const listReleaseRuns = Effect.fn("listReleaseRuns")(function* (filter: readonly string[]) {
  const gh = yield* GitHubCli;
  const output = yield* gh.run([
    "run",
    "list",
    "--repo",
    sourceRepository,
    "--workflow",
    "release.yml",
    ...filter,
  ]);
  return yield* parseJson(Schema.Array(ReleaseRunSchema), output, "gh run list");
});

/** Downloads the release build bundle. Returns false when no run published the release. */
export const downloadReleaseBuild = Effect.fn("downloadReleaseBuild")(function* (
  tag: string,
  directory = incoming,
) {
  const gh = yield* GitHubCli;
  let runs = (yield* listReleaseRuns([
    "--branch",
    tag,
    "--event",
    "push",
    "--status",
    "completed",
    "--limit",
    "10",
    "--json",
    "databaseId,headBranch",
  ])).filter((entry) => entry.headBranch === tag);
  if (!runs.length) {
    const runNumber = /^stack-v0\.0\.(\d+)$/.exec(tag)?.[1];
    if (runNumber) {
      const dispatched = yield* listReleaseRuns([
        "--event",
        "workflow_dispatch",
        "--status",
        "completed",
        "--limit",
        "1000",
        "--json",
        "databaseId,number",
      ]);
      runs = dispatched.filter((entry) => entry.number === Number(runNumber));
    }
  }
  const runId = yield* findPublishedRun(runs, (id) =>
    gh.run(["run", "view", String(id), "--repo", sourceRepository, "--json", "jobs"]).pipe(
      Effect.flatMap((output) =>
        parseJson(Schema.Struct({ jobs: Schema.Array(ReleaseJobSchema) }), output, "gh run view"),
      ),
      Effect.map(({ jobs }) => jobs),
    ),
  );
  if (runId === undefined) return false;
  yield* gh.run([
    "run",
    "download",
    String(runId),
    "--repo",
    sourceRepository,
    "--name",
    "release-bundle",
    "--dir",
    join(directory, "build"),
  ]);
  return true;
});

const listJars = (directory: string) =>
  listDirectory(directory).pipe(
    Effect.map((files) => files.filter((file) => file.endsWith(".jar"))),
  );

const downloadReleaseInputs = Effect.fn("downloadReleaseInputs")(function* (tag: string) {
  if (!(yield* downloadReleaseBuild(tag))) return false;
  const gh = yield* GitHubCli;
  const jars = join(incoming, "jars");
  yield* makeDirectory(jars);
  const patterns: string[] = [];
  for (const project of projects) {
    const artifact = yield* readProjectArtifact(incoming, project);
    patterns.push("--pattern", artifact.file);
  }
  yield* gh.run([
    "release",
    "download",
    tag,
    "--repo",
    sourceRepository,
    ...patterns,
    "--dir",
    jars,
  ]);
  const downloaded = yield* listJars(jars);
  if (downloaded.length !== projects.length) {
    return yield* new ReleaseImportError({
      message: `Expected ${projects.length} release JARs for ${tag}, found ${downloaded.length}`,
    });
  }
  return true;
});

/** Checks every downloaded JAR against its build manifest and rejects extra JARs. */
export const validateReleaseInputs = Effect.fn("validateReleaseInputs")(function* (
  directory = incoming,
) {
  const expected = new Set<string>();
  for (const project of projects) {
    const artifact = yield* readProjectArtifact(directory, project);
    if (expected.has(artifact.file)) {
      return yield* new ReleaseImportError({ message: `Duplicate release JAR: ${artifact.file}` });
    }
    expected.add(artifact.file);
    const bytes = yield* readBytes(join(directory, "jars", artifact.file));
    if (checksum(bytes, "sha256") !== artifact.sha256) {
      return yield* new ChecksumMismatchError({ file: artifact.file });
    }
    yield* readBytes(join(directory, "build", project, "pom.xml"));
  }
  const unexpected = (yield* listJars(join(directory, "jars"))).find((file) => !expected.has(file));
  if (unexpected) {
    return yield* new ReleaseImportError({ message: `Unexpected release JAR: ${unexpected}` });
  }
});

const RequestedTagSchema = Schema.UndefinedOr(Schema.String.check(Schema.isPattern(releaseTag)));

/** Imports every new release, or only `requestedTag` when it is set. */
export const importReleases = Effect.fn("importReleases")(function* (requestedTag?: string) {
  const tagFilter = yield* Schema.decodeEffect(RequestedTagSchema)(requestedTag).pipe(
    Effect.mapError(
      () => new ReleaseImportError({ message: `Invalid release tag: ${requestedTag}` }),
    ),
  );
  const imported = (yield* exists(stateFile))
    ? [...(yield* parseJson(Schema.Array(Schema.String), yield* readText(stateFile), stateFile))]
    : [];
  const gh = yield* GitHubCli;
  const releases = yield* parseJson(
    Schema.Array(ReleaseSchema),
    yield* gh.run([
      "release",
      "list",
      "--repo",
      sourceRepository,
      "--order",
      "asc",
      "--limit",
      "1000",
      "--json",
      "tagName,isDraft,isPrerelease",
    ]),
    "gh release list",
  );
  for (const release of releases) {
    const tag = release.tagName;
    if (tagFilter && tag !== tagFilter) continue;
    if (release.isDraft || release.isPrerelease || !releaseTag.test(tag) || imported.includes(tag))
      continue;
    yield* remove(incoming);
    yield* makeDirectory(incoming);
    if (!(yield* downloadReleaseInputs(tag))) {
      yield* Console.error(
        `Skipping ${tag}: no completed build and release publication; retrying on the next import`,
      );
      continue;
    }
    yield* validateReleaseInputs();
    for (const project of projects) yield* importProject(tag, project);
    imported.push(tag);
    yield* write(stateFile, `${JSON.stringify(imported, null, 2)}\n`);
    yield* Console.log(`Imported ${tag}`);
  }
  if (tagFilter && !imported.includes(tagFilter)) {
    return yield* new ReleaseImportError({ message: `Release was not imported: ${tagFilter}` });
  }
  yield* remove(incoming);
});

if (import.meta.main) {
  // The workflow passes an empty string when no tag input is set.
  const tagArgument = process.argv[2];
  await Effect.runPromise(
    importReleases(tagArgument === "" ? undefined : tagArgument).pipe(
      Effect.provide(GitHubCliLive),
    ),
  );
}
