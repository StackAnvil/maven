import { expect, test } from "bun:test";
import { handleRequest } from "./index.ts";

const jarUrl = "https://stackanvil-maven.pistonmaster.net/io/github/stackanvil/viafabricplus-bedrock-stackanvil/0.4.4/viafabricplus-bedrock-stackanvil-0.4.4.jar";
const download = "https://github.com/StackAnvil/patches/releases/download/stack-v0.4.4/viafabricplus-bedrock-1.2.1-StackAnvil.jar";

test("GET and HEAD redirect to the verified release asset", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await handleRequest(new Request(jarUrl, { method }), async (input) => {
      expect(String(input)).toBe("https://raw.githubusercontent.com/StackAnvil/maven/main/site/io/github/stackanvil/viafabricplus-bedrock-stackanvil/0.4.4/viafabricplus-bedrock-stackanvil-0.4.4.jar.url");
      return new Response(`${download}\n`);
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(download);
    expect(await response.text()).toBe("");
  }
});

test("legacy JARs fall back to GitHub Pages", async () => {
  const request = new Request(jarUrl.replaceAll("0.4.4", "0.3.4"));
  const response = await handleRequest(request, async (input) => {
    if (input === request) return new Response("legacy JAR");
    return new Response(null, { status: 404 });
  });
  expect(await response.text()).toBe("legacy JAR");
});

test("metadata errors and unexpected download URLs do not redirect", async () => {
  for (const location of ["https://example.com/artifact.jar", `${download}?other=true`, `${download}/extra`]) {
    expect((await handleRequest(new Request(jarUrl), async () => new Response(location))).status).toBe(502);
  }
  expect((await handleRequest(new Request(jarUrl), async () => new Response(null, { status: 500 }))).status).toBe(503);
  expect((await handleRequest(new Request(jarUrl, { method: "POST" }), async () => { throw new Error("unexpected fetch"); })).status).toBe(405);
});

test("POMs and checksums pass through to the origin", async () => {
  for (const url of [jarUrl.replace(/\.jar$/, ".pom"), `${jarUrl}.sha256`]) {
    const request = new Request(url);
    expect(await (await handleRequest(request, async (input) => {
      expect(input).toBe(request);
      return new Response("origin metadata");
    })).text()).toBe("origin metadata");
  }
});
