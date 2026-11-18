import { Context, Data, Effect, Result } from "effect";

const metadataRoot = "https://raw.githubusercontent.com/StackAnvil/maven/main/site";
const releaseRoot = "https://github.com/StackAnvil/patches/releases/download/";

/** A fetch to the metadata host or the origin failed before it returned a response. */
export class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string;
  readonly cause: unknown;
}> {}

/** Sends HTTP requests. Tests replace it with a fake origin. */
export class Fetcher extends Context.Service<
  Fetcher,
  { readonly fetch: (input: string | Request) => Effect.Effect<Response, FetchError> }
>()("maven/Fetcher") {}

export function makeFetcher(
  fetch: (input: string | Request) => Promise<Response>,
): Fetcher["Service"] {
  return {
    fetch: (input) =>
      Effect.tryPromise({
        try: async () => fetch(input),
        catch: (cause) =>
          new FetchError({ url: typeof input === "string" ? input : input.url, cause }),
      }),
  };
}

/** The metadata host answered with an error status. */
export class MetadataStatusError extends Data.TaggedError("MetadataStatusError")<{
  readonly url: string;
  readonly status: number;
}> {}

/** Reads a JAR's `.url` file. Returns undefined when the JAR has no such file. */
const readDownloadLocation = Effect.fn("readDownloadLocation")(function* (url: string) {
  const fetcher = yield* Fetcher;
  const metadata = yield* fetcher.fetch(url);
  if (metadata.status === 404) return undefined;
  if (!metadata.ok) return yield* new MetadataStatusError({ url, status: metadata.status });
  const text = yield* Effect.tryPromise({
    try: async () => metadata.text(),
    catch: (cause) => new FetchError({ url, cause }),
  });
  return text.trim();
});

/** Redirects release JAR requests to the verified GitHub release asset. */
export const handleRequest = Effect.fn("handleRequest")(function* (request: Request) {
  const fetcher = yield* Fetcher;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/io/github/stackanvil/") || !url.pathname.endsWith(".jar"))
    return yield* fetcher.fetch(request);
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405 });

  const location = yield* Effect.result(readDownloadLocation(`${metadataRoot}${url.pathname}.url`));
  if (Result.isFailure(location))
    return new Response("Artifact metadata is unavailable", { status: 503 });
  if (location.success === undefined) return yield* fetcher.fetch(request);
  if (
    !location.success.startsWith(releaseRoot) ||
    !/^stack-v\d+\.\d+\.\d+\/[^/?#]+\.jar$/.test(location.success.slice(releaseRoot.length))
  ) {
    return new Response("Invalid artifact download URL", { status: 502 });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: location.success, "Cache-Control": "public, max-age=3600" },
  });
});

const liveFetcher = makeFetcher(async (input) => fetch(input));

export default {
  fetch: async (request: Request) =>
    Effect.runPromise(handleRequest(request).pipe(Effect.provideService(Fetcher, liveFetcher))),
};
