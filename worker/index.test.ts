import { expect, test } from "bun:test";

import { Effect } from "effect";

import { Fetcher, handleRequest, makeFetcher } from "./index.ts";

const jarUrl =
  "https://stackanvil-maven.pistonmaster.net/io/github/stackanvil/viafabricplus-bedrock-stackanvil/0.4.4/viafabricplus-bedrock-stackanvil-0.4.4.jar";
async function handle(
  request: Request,
  fetch: (input: string | Request) => Promise<Response>,
): Promise<Response> {
  return Effect.runPromise(
    handleRequest(request).pipe(Effect.provideService(Fetcher, makeFetcher(fetch))),
  );
}

const download =
  "https://github.com/StackAnvil/patches/releases/download/stack-v0.4.4/viafabricplus-bedrock-1.2.1-StackAnvil.jar";

test("GET and HEAD redirect to the verified release asset", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await handle(new Request(jarUrl, { method }), (input) => {
      expect(input).toBe(
        "https://raw.githubusercontent.com/StackAnvil/maven/main/site/io/github/stackanvil/viafabricplus-bedrock-stackanvil/0.4.4/viafabricplus-bedrock-stackanvil-0.4.4.jar.url",
      );
      return Promise.resolve(new Response(`${download}\n`));
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(download);
    expect(await response.text()).toBe("");
  }
});

test("legacy JARs fall back to GitHub Pages", async () => {
  const request = new Request(jarUrl.replaceAll("0.4.4", "0.3.4"));
  const response = await handle(request, (input) =>
    Promise.resolve(
      input === request ? new Response("legacy JAR") : new Response(null, { status: 404 }),
    ),
  );
  expect(await response.text()).toBe("legacy JAR");
});

test("metadata errors and unexpected download URLs do not redirect", async () => {
  for (const location of [
    "https://example.com/artifact.jar",
    `${download}?other=true`,
    `${download}/extra`,
  ]) {
    expect(
      (await handle(new Request(jarUrl), () => Promise.resolve(new Response(location)))).status,
    ).toBe(502);
  }
  expect(
    (await handle(new Request(jarUrl), () => Promise.resolve(new Response(null, { status: 500 }))))
      .status,
  ).toBe(503);
  expect(
    (await handle(new Request(jarUrl), () => Promise.reject(new Error("network unavailable"))))
      .status,
  ).toBe(503);
  expect(
    (
      await handle(new Request(jarUrl, { method: "POST" }), () =>
        Promise.reject(new Error("unexpected fetch")),
      )
    ).status,
  ).toBe(405);
});

test("origin failures still fail the request", async () => {
  const request = new Request(jarUrl.replace(/\.jar$/u, ".pom"));
  expect(
    await handle(request, () => Promise.reject(new Error("origin unavailable"))).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.name : "unknown"),
    ),
  ).toBe("FetchError");
});

test("POMs and checksums pass through to the origin", async () => {
  for (const url of [jarUrl.replace(/\.jar$/u, ".pom"), `${jarUrl}.sha256`]) {
    const request = new Request(url);
    expect(
      await (
        await handle(request, (input) => {
          expect(input).toBe(request);
          return Promise.resolve(new Response("origin metadata"));
        })
      ).text(),
    ).toBe("origin metadata");
  }
});
