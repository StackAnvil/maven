import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { findPublishedRun, hasPublishedRelease, importJar, rewritePom, validateReleaseInputs } from "./import-release.ts";

test("a cancelled release does not prevent selection of a published run", async () => {
  const cancelled = [{ name: "build", conclusion: "cancelled" }, { name: "publish", conclusion: "skipped" }];
  const published = [{ name: "build", conclusion: "success" }, { name: "publish", conclusion: "success" }];
  expect(await findPublishedRun([{ databaseId: 1 }], async () => cancelled)).toBeUndefined();
  expect(await findPublishedRun([{ databaseId: 1 }, { databaseId: 2 }], async (id) => id === 1 ? cancelled : published)).toBe(2);
  await expect(findPublishedRun([{ databaseId: 1 }], async () => { throw new Error("API unavailable"); })).rejects.toThrow("API unavailable");
});

test("Maven publishes checksums and a release URL without storing the JAR in Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackanvil-maven-artifact-"));
  try {
    const bytes = Buffer.from("release JAR");
    const file = "viafabricplus-bedrock-1.2.1-StackAnvil.jar";
    const jar = join(directory, file);
    const pom = join(directory, "pom.xml");
    await writeFile(jar, bytes);
    await writeFile(pom, "<project><groupId>source</groupId><artifactId>addon</artifactId><version>1</version></project>");
    const artifact = { file, sha256: createHash("sha256").update(bytes).digest("hex") };
    const repository = join(directory, "repository");
    const artifactId = "viafabricplus-bedrock-stackanvil";
    await importJar(jar, pom, artifact, artifactId, "0.4.4", repository);
    const versionDir = join(repository, "io/github/stackanvil", artifactId, "0.4.4");
    const name = `${artifactId}-0.4.4.jar`;
    expect(await readdir(versionDir)).not.toContain(name);
    expect(await readFile(join(versionDir, `${name}.url`), "utf8")).toBe(`https://github.com/StackAnvil/patches/releases/download/stack-v0.4.4/${file}\n`);
    for (const algorithm of ["sha1", "sha256"]) {
      expect(await readFile(join(versionDir, `${name}.${algorithm}`), "utf8")).toBe(`${createHash(algorithm).update(bytes).digest("hex")}\n`);
    }
    expect(await readFile(join(versionDir, `${artifactId}-0.4.4.pom`), "utf8")).toContain("<version>0.4.4</version>");
    await expect(importJar(jar, pom, artifact, artifactId, "0.4.4", repository)).rejects.toThrow("already has Maven files");
    await expect(importJar(jar, pom, { ...artifact, sha256: "wrong" }, artifactId, "0.4.5", repository)).rejects.toThrow("SHA-256 mismatch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Maven accepts a release when a later add-on upload fails", () => {
  expect(hasPublishedRelease([
    { name: "build", conclusion: "success" },
    { name: "publish", conclusion: "success" },
    { name: "publish_addon / publish (modrinth)", conclusion: "failure" },
  ])).toBe(true);
  expect(hasPublishedRelease([
    { name: "build", conclusion: "success" },
    { name: "publish", conclusion: "failure" },
  ])).toBe(false);
});

test("generated CubeConverter dependency uses this release's Maven coordinate", () => {
  const source = `<project><groupId>source</groupId><artifactId>source</artifactId><version>1</version><dependencies><dependency><groupId>org.oryxel.cube</groupId><artifactId>cubeconverter</artifactId><version>1.3-StackAnvil</version></dependency></dependencies></project>`;
  const pom = rewritePom(source, "viafabricplus-bedrock-stackanvil", "0.2.0");
  expect(pom).toContain("<artifactId>cubeconverter-stackanvil</artifactId><version>0.2.0</version>");
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
  expect(pom).toContain("<groupId>com.viaversion</groupId><artifactId>viafabricplus</artifactId><version>5.1.1</version>");
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

    await validateReleaseInputs(directory);

    const upstreamJar = join(jars, "ViaFabricPlus-5.1.1.jar");
    await writeFile(upstreamJar, "upstream artifact");
    await expect(validateReleaseInputs(directory)).rejects.toThrow(/Unexpected release JAR/);
    await rm(upstreamJar);

    const changed = join(jars, "viabedrock-StackAnvil.jar");
    await writeFile(changed, `${await readFile(changed, "utf8")} changed`);
    await expect(validateReleaseInputs(directory)).rejects.toThrow(/SHA-256 mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
