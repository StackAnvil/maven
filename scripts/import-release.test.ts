import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { rewritePom, validateReleaseInputs } from "./import-release.ts";

test("generated CubeConverter dependency uses this release's Maven coordinate", () => {
  const source = `<project><groupId>source</groupId><artifactId>source</artifactId><version>1</version><dependencies><dependency><groupId>org.oryxel.cube</groupId><artifactId>cubeconverter</artifactId><version>1.3-StackAnvil</version></dependency></dependencies></project>`;
  const pom = rewritePom(source, "viafabricplus-bedrock-stackanvil", "0.2.0");
  expect(pom).toContain("<artifactId>cubeconverter-stackanvil</artifactId><version>0.2.0</version>");
  expect(pom).not.toContain("<artifactId>cubeconverter</artifactId>");
});

test("release import checks every public JAR against its build manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackanvil-maven-import-"));
  try {
    const jars = join(directory, "jars");
    await mkdir(jars);
    const projects = ["viabedrock", "viafabricplus-bedrock", "cubeconverter", "viafabricplus"];
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
        auxiliaryArtifacts: [] as { file: string; sha256: string }[],
      };
      if (project === "viafabricplus") {
        await mkdir(join(built, "api"));
        const api = Buffer.from("api");
        const apiFile = "api/viafabricplus-api-StackAnvil.jar";
        await writeFile(join(built, apiFile), api);
        await writeFile(join(built, "api", "pom.xml"), "<project/>");
        manifest.auxiliaryArtifacts.push({ file: apiFile, sha256: createHash("sha256").update(api).digest("hex") });
      }
      await writeFile(join(built, "manifest.json"), JSON.stringify(manifest));
    }

    await validateReleaseInputs("stack-v1.0.0", directory);

    const changed = join(jars, "viabedrock-StackAnvil.jar");
    await writeFile(changed, `${await readFile(changed, "utf8")} changed`);
    await expect(validateReleaseInputs("stack-v1.0.0", directory)).rejects.toThrow(/SHA-256 mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
