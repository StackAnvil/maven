# StackAnvil Maven repository

This repository stores the fully patched artifacts from [StackAnvil releases](https://github.com/StackAnvil/patches/releases). GitHub Pages serves the Maven layout at `https://stackanvil.github.io/maven/`.

Add the repository to Gradle:

```kotlin
repositories {
    maven("https://stackanvil.github.io/maven/")
}

dependencies {
    implementation("io.github.stackanvil:viabedrock-stackanvil:<release-version>")
}
```

The other artifact IDs are `viafabricplus-bedrock-stackanvil`, `cubeconverter-stackanvil`, `viafabricplus-stackanvil`, and `viafabricplus-api-stackanvil`. The Maven version is the StackAnvil release version without the `stack-v` tag prefix. Published versions remain immutable. For a current version, check [StackAnvil releases](https://github.com/StackAnvil/patches/releases).

The import workflow reads public release archives, verifies each JAR against its SHA-256 manifest, rewrites generated POM dependencies to this release's StackAnvil coordinates, and deploys the Maven files. It publishes the ViaFabricPlus API JAR because the main mod's POM depends on it. It does not publish upstream-only or north-star PR builds.

StackAnvil is independent of the upstream projects. Keep upstream copyright and license notices when using these artifacts.
