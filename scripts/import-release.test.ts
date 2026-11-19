import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Option } from "effect";

import {
  ChecksumMismatchError,
  CommandError,
  downloadReleaseBuild,
  findPublishedRun,
  GitHubCli,
  hasPublishedRelease,
  importJar,
  rewritePom,
  validateReleaseInputs,
} from "./import-release.ts";

/** Runs a program that must fail and returns its error. */
async function failureOf<A, E>(program: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromise(Effect.flip(program));
}

/** Answers `gh` commands with `respond` and records every call. */
function fakeGitHub(respond: (args: readonly string[]) => string | null) {
  const calls: string[] = [];
  const provide = Effect.provideService(GitHubCli, {
    run: (args) => {
      calls.push(args.join(" "));
      const output = respond(args);
      return output === null
        ? Effect.fail(CommandError.make({ args, cause: new Error("API unavailable") }))
        : Effect.succeed(output);
    },
  });
  return { calls, provide };
}

const cancelled = [
  { name: "build", conclusion: "cancelled" },
  { name: "publish", conclusion: "skipped" },
];
const published = [
  { name: "build", conclusion: "success" },
  { name: "publish", conclusion: "success" },
];

test("a cancelled release does not prevent selection of a published run", async () => {
  expect(
    await Effect.runPromise(findPublishedRun([{ databaseId: 1 }], () => Effect.succeed(cancelled))),
  ).toEqual(Option.none());
  expect(
    await Effect.runPromise(
      findPublishedRun([{ databaseId: 1 }, { databaseId: 2 }], (id) =>
        Effect.succeed(id === 1 ? cancelled : published),
      ),
    ),
  ).toEqual(Option.some(2));
  const error = await failureOf(
    findPublishedRun([{ databaseId: 1 }], () =>
      Effect.fail(CommandError.make({ args: [], cause: new Error("API unavailable") })),
    ),
  );
  expect(error.message).toBe("API unavailable");
});

test("the import downloads the bundle of the first published release run", async () => {
  const gh = fakeGitHub((args) => {
    if (args.slice(0, 2).join(" ") === "run list")
      return JSON.stringify([
        { databaseId: 7, headBranch: "stack-v1.0.0" },
        { databaseId: 8, headBranch: "stack-v1.0.0" },
        { databaseId: 9, headBranch: "other" },
      ]);
    if (args.slice(0, 2).join(" ") === "run view")
      return JSON.stringify({ jobs: args[2] === "7" ? cancelled : published });
    if (args.slice(0, 2).join(" ") === "run download") return "";
    return null;
  });
  expect(
    await Effect.runPromise(downloadReleaseBuild("stack-v1.0.0", "/incoming").pipe(gh.provide)),
  ).toBe(true);
  expect(gh.calls.at(-1)).toBe(
    "run download 8 --repo StackAnvil/patches --name release-bundle --dir /incoming/build",
  );
});

test("an early release falls back to its dispatched run number", async () => {
  const gh = fakeGitHub((args) => {
    if (args.includes("push")) return "[]";
    if (args.includes("workflow_dispatch"))
      return JSON.stringify([
        { databaseId: 40, number: 4 },
        { databaseId: 50, number: 5 },
      ]);
    if (args[1] === "view") return JSON.stringify({ jobs: args[2] === "50" ? published : [] });
    if (args[1] === "download") return "";
    return null;
  });
  expect(
    await Effect.runPromise(downloadReleaseBuild("stack-v0.0.5", "/incoming").pipe(gh.provide)),
  ).toBe(true);
  expect(gh.calls.at(-1)).toStartWith("run download 50 ");
});

test("a release without a published run is skipped without a download", async () => {
  const gh = fakeGitHub((args) => {
    if (args[1] === "list") return JSON.stringify([{ databaseId: 3, headBranch: "stack-v1.0.0" }]);
    if (args[1] === "view") return JSON.stringify({ jobs: cancelled });
    return null;
  });
  expect(await Effect.runPromise(downloadReleaseBuild("stack-v1.0.0").pipe(gh.provide))).toBe(
    false,
  );
  expect(gh.calls.some((call) => call.startsWith("run download"))).toBe(false);
});

test("an unexpected gh response stops the import", async () => {
  const gh = fakeGitHub(() => JSON.stringify([{ databaseId: "3" }]));
  const error = await failureOf(downloadReleaseBuild("stack-v1.0.0").pipe(gh.provide));
  expect(error.message).toBe("Unexpected JSON shape in gh run list");
});

test("Maven publishes checksums and a release URL without storing the JAR in Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackanvil-maven-artifact-"));
  try {
    const bytes = Buffer.from("release JAR");
    const file = "viafabricplus-bedrock-1.2.1-StackAnvil.jar";
    const jar = join(directory, file);
    const pom = join(directory, "pom.xml");
    await writeFile(jar, bytes);
    await writeFile(
      pom,
      "<project><groupId>source</groupId><artifactId>addon</artifactId><version>1</version></project>",
    );
    const artifact = { file, sha256: createHash("sha256").update(bytes).digest("hex") };
    const repository = join(directory, "repository");
    const artifactId = "viafabricplus-bedrock-stackanvil";
    await Effect.runPromise(importJar(jar, pom, artifact, artifactId, "0.4.4", repository));
    const versionDir = join(repository, "io/github/stackanvil", artifactId, "0.4.4");
    const name = `${artifactId}-0.4.4.jar`;
    expect(await readdir(versionDir)).not.toContain(name);
    expect(await readFile(join(versionDir, `${name}.url`), "utf8")).toBe(
      `https://github.com/StackAnvil/patches/releases/download/stack-v0.4.4/${file}\n`,
    );
    for (const algorithm of ["sha1", "sha256"]) {
      expect(await readFile(join(versionDir, `${name}.${algorithm}`), "utf8")).toBe(
        `${createHash(algorithm).update(bytes).digest("hex")}\n`,
      );
    }
    expect(await readFile(join(versionDir, `${artifactId}-0.4.4.pom`), "utf8")).toContain(
      "<version>0.4.4</version>",
    );
    expect(
      (await failureOf(importJar(jar, pom, artifact, artifactId, "0.4.4", repository))).message,
    ).toContain("already has Maven files");
    const mismatch = await failureOf(
      importJar(jar, pom, { ...artifact, sha256: "wrong" }, artifactId, "0.4.5", repository),
    );
    expect(mismatch).toBeInstanceOf(ChecksumMismatchError);
    expect(mismatch.message).toBe(`SHA-256 mismatch: ${file}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Maven accepts a release when a later add-on upload fails", () => {
  expect(
    hasPublishedRelease([
      { name: "build", conclusion: "success" },
      { name: "publish", conclusion: "success" },
      { name: "publish_addon / publish (modrinth)", conclusion: "failure" },
    ]),
  ).toBe(true);
  expect(
    hasPublishedRelease([
      { name: "build", conclusion: "success" },
      { name: "publish", conclusion: "failure" },
    ]),
  ).toBe(false);
});

test("generated CubeConverter dependency uses this release's Maven coordinate", () => {
  const source = `<project><groupId>source</groupId><artifactId>source</artifactId><version>1</version><dependencies><dependency><groupId>org.oryxel.cube</groupId><artifactId>cubeconverter</artifactId><version>1.3-StackAnvil</version></dependency></dependencies></project>`;
  const pom = rewritePom(source, "viafabricplus-bedrock-stackanvil", "0.2.0");
  expect(pom).toContain(
    "<artifactId>cubeconverter-stackanvil</artifactId><version>0.2.0</version>",
  );
  expect(pom).not.toContain("<artifactId>cubeconverter</artifactId>");
});

test("ViaProxy depends on the ViaBedrock artifact from the same release", () => {
  const source = `<project><groupId>net.raphimc</groupId><artifactId>ViaProxy</artifactId><version>3.4.14-StackAnvil</version><dependencies><dependency><groupId>net.raphimc</groupId><artifactId>ViaBedrock</artifactId><version>0.0.31-StackAnvil</version></dependency></dependencies></project>`;
  const pom = rewritePom(source, "viaproxy-stackanvil", "1.0.0");
  expect(pom).toContain("<artifactId>viabedrock-stackanvil</artifactId><version>1.0.0</version>");
});

test("the Bedrock add-on keeps its upstream ViaFabricPlus dependency", () => {
  const source = `<project><groupId>com.viaversion</groupId><artifactId>viafabricplus-bedrock</artifactId><version>1.1.1-StackAnvil</version><dependencies><dependency><groupId>com.viaversion</groupId><artifactId>viafabricplus</artifactId><version>5.1.1</version></dependency></dependencies></project>`;
  const pom = rewritePom(source, "viafabricplus-bedrock-stackanvil", "1.0.0");
  expect(pom).toContain(
    "<groupId>com.viaversion</groupId><artifactId>viafabricplus</artifactId><version>5.1.1</version>",
  );
});

test("release import checks every public JAR against its build manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackanvil-maven-import-"));
  try {
    const jars = join(directory, "jars");
    await mkdir(jars);
    const projects = ["viabedrock", "viafabricplus-bedrock", "cubeconverter", "viaproxy"];
    for (const project of projects) {
      const built = join(directory, "build", project);
      await mkdir(built, { recursive: true });
      const file = `${project}-StackAnvil.jar`;
      const bytes = Buffer.from(project);
      await writeFile(join(jars, file), bytes);
      await writeFile(join(built, "pom.xml"), "<project/>");
      const manifest = {
        target: project,
        artifacts: [{ file, sha256: createHash("sha256").update(bytes).digest("hex") }],
      };
      await writeFile(join(built, "manifest.json"), JSON.stringify(manifest));
    }

    await Effect.runPromise(validateReleaseInputs(directory));

    const upstreamJar = join(jars, "ViaFabricPlus-5.1.1.jar");
    await writeFile(upstreamJar, "upstream artifact");
    expect((await failureOf(validateReleaseInputs(directory))).message).toBe(
      "Unexpected release JAR: ViaFabricPlus-5.1.1.jar",
    );
    await rm(upstreamJar);

    const changed = join(jars, "viabedrock-StackAnvil.jar");
    await writeFile(changed, `${await readFile(changed, "utf8")} changed`);
    expect((await failureOf(validateReleaseInputs(directory))).message).toBe(
      "SHA-256 mismatch: viabedrock-StackAnvil.jar",
    );

    const manifest = join(directory, "build", "viabedrock", "manifest.json");
    await writeFile(manifest, "{");
    expect((await failureOf(validateReleaseInputs(directory))).message).toBe(
      `Unexpected JSON shape in ${manifest}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
