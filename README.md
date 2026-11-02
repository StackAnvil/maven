# StackAnvil Maven repository

This repository stores the fully patched artifacts from [StackAnvil releases](https://github.com/StackAnvil/patches/releases). GitHub Pages serves the Maven layout at `https://stackanvil-maven.pistonmaster.net/`.

Add the repository to Gradle:

```kotlin
repositories {
    maven("https://stackanvil-maven.pistonmaster.net/")
}

dependencies {
    implementation("io.github.stackanvil:viabedrock-stackanvil:<release-version>")
}
```

The other current artifact IDs are `viafabricplus-bedrock-stackanvil`, `cubeconverter-stackanvil`, and `viaproxy-stackanvil`. The Maven version is the StackAnvil release version without the `stack-v` tag prefix. Published versions remain immutable. For a current version, check [StackAnvil releases](https://github.com/StackAnvil/patches/releases).

The import workflow downloads the four patched JARs and the matching release build artifact. It checks each JAR against its SHA-256 manifest and rewrites dependencies between StackAnvil projects. It leaves the ViaFabricPlus dependency on its [upstream Maven coordinate](https://repo.viaversion.com/com/viaversion/viafabricplus/). The importer does not publish upstream-only or north-star PR builds.

New releases store POMs, checksums, and JAR download URLs in Git. The download Worker redirects Maven JAR requests to the verified GitHub release assets. This avoids GitHub's 100 MiB file limit. Existing JARs remain available through GitHub Pages. Maven coordinates and repository URLs stay the same.

Scheduled imports skip releases without a completed build and publication. The next import checks these releases again. Download errors and checksum mismatches still stop the import.

To import one release, dispatch the publishing workflow with its `tag` input, or run `bun scripts/import-release.ts stack-v0.4.4`. Pushes deploy the committed Maven files. Scheduled and manual runs import new releases before deployment.

To deploy the download Worker, run `bun install --frozen-lockfile`, then `bun run deploy`. Its route requires a proxied DNS record for `stackanvil-maven.pistonmaster.net`. The Worker reads each JAR's `.url` file from this repository and accepts only StackAnvil release downloads. It passes legacy JAR requests to GitHub Pages.

Earlier `viafabricplus-stackanvil` and `viafabricplus-api-stackanvil` versions remain available for existing consumers. New releases use a pinned upstream ViaFabricPlus build and do not publish those two coordinates.

GitHub retains the build artifact for 90 days. The scheduled importer must process a release before that period ends.

StackAnvil is independent of the upstream projects. Keep upstream copyright and license notices when using these artifacts.
