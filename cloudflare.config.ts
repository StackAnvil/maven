import { defineConfig, triggers } from "cf/config";

export default defineConfig({
  accountId: "4dd0e72d7bf89402be905fb40cdb230a",
  worker: {
    name: "stackanvil-maven-downloads",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-11-02",
    workersDev: false,
    triggers: [triggers.fetch({ pattern: "stackanvil-maven.pistonmaster.net/io/github/stackanvil/*", zone: "pistonmaster.net" })],
  },
});
