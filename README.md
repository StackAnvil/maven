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

The import workflow downloads the four patched JARs and the matching release build artifact. It verifies the JARs against their SHA-256 manifests and rewrites dependencies between StackAnvil projects. It leaves the ViaFabricPlus dependency on its [upstream Maven coordinate](https://repo.viaversion.com/com/viaversion/viafabricplus/). The importer does not publish upstream-only or north-star PR builds.

Earlier `viafabricplus-stackanvil` and `viafabricplus-api-stackanvil` versions remain available for existing consumers. New releases use a pinned upstream ViaFabricPlus build and do not publish those two coordinates.

GitHub retains the build artifact for 90 days. The scheduled importer must process a release before that period ends.

StackAnvil is independent of the upstream projects. Keep upstream copyright and license notices when using these artifacts.
