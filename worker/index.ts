const metadataRoot = "https://raw.githubusercontent.com/StackAnvil/maven/main/site";
const releaseRoot = "https://github.com/StackAnvil/patches/releases/download/";

export async function handleRequest(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/io/github/stackanvil/") || !url.pathname.endsWith(".jar")) return fetcher(request);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

  const metadata = await fetcher(`${metadataRoot}${url.pathname}.url`);
  if (metadata.status === 404) return fetcher(request);
  if (!metadata.ok) return new Response("Artifact metadata is unavailable", { status: 503 });
  const location = (await metadata.text()).trim();
  if (!location.startsWith(releaseRoot) || !/^stack-v\d+\.\d+\.\d+\/[^/?#]+\.jar$/.test(location.slice(releaseRoot.length))) {
    return new Response("Invalid artifact download URL", { status: 502 });
  }
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "public, max-age=3600" } });
}

export default { fetch: (request: Request) => handleRequest(request) };
