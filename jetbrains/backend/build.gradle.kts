dependencies {
    intellijPlatform {
        bundledModule("intellij.platform.kernel.backend")
        bundledModule("intellij.platform.rpc.backend")
        bundledModule("intellij.platform.backend")
        bundledPlugin("org.jetbrains.plugins.terminal")
        compileOnly("org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.9.0")
    }
    implementation(project(":shared"))
}
