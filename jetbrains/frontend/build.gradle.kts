dependencies {
    intellijPlatform {
        bundledModule("intellij.platform.frontend")
        bundledPlugin("com.intellij.modules.jcef")
        compileOnly("org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.9.0")
        compileOnly("org.jetbrains.kotlinx:kotlinx-serialization-json-jvm:1.9.0")
    }
    implementation(project(":shared"))
}
