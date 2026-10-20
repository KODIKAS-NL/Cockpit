import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "nl.kodikas"
version = providers.exec {
    commandLine("node", "-p", "require('../package.json').version")
}.standardOutput.asText.get().trim()

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        // A downloaded Rider has no JCEF bundle; an installed one does. Use it when present.
        val installed = providers.gradleProperty("riderPath").orNull
            ?: listOf("${System.getProperty("user.home")}/Applications/Rider.app", "/Applications/Rider.app")
                .firstOrNull { file(it).exists() }
        if (installed != null) local(installed) else rider("2026.2") { useInstaller = false }
        bundledPlugin("com.intellij.modules.jcef")
        bundledPlugin("org.jetbrains.plugins.terminal")
        pluginVerifier()
        zipSigner()
    }
}

kotlin { jvmToolchain(21) }

intellijPlatform {
    pluginConfiguration {
        name = "Cockpit for Claude Code"
        ideaVersion { sinceBuild = "262" }
    }
}

// The Node sidecar and everything it serves ships inside the plugin, next to the Kotlin classes.
val sidecarFiles = tasks.register<Sync>("sidecarFiles") {
    val root = layout.projectDirectory.dir("..")
    into(layout.buildDirectory.dir("sidecar"))
    into("sidecar/dist") { from(root.dir("dist")) { include("sidecar.js", "webview/**", "scratchpad/**") } }
    into("sidecar/l10n") { from(root.dir("l10n")) }
    into("sidecar/media") { from(root.dir("media")) { include("icon.png") } }
    into("sidecar/dict") { from(root.dir("dict")) }
    into("sidecar") { from(root.file("package.json")) }
}

// Every sandbox (runIde, tests, buildPlugin) gets the sidecar next to the plugin's classes.
tasks.withType<org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask>().configureEach {
    dependsOn(sidecarFiles)
    from(sidecarFiles.map { it.destinationDir.resolve("sidecar") }) { into(pluginName.map { "$it/sidecar" }) }
}
