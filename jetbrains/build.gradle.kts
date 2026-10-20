import org.jetbrains.intellij.platform.gradle.tasks.aware.SplitModeAware

plugins {
    id("org.jetbrains.intellij.platform")
    id("org.jetbrains.kotlin.jvm")
    id("rpc") apply false
    id("org.jetbrains.kotlin.plugin.serialization") apply false
}

group = "nl.kodikas"
version = providers.exec {
    commandLine("node", "-p", "require('../package.json').version")
}.standardOutput.asText.get().trim()

subprojects {
    apply(plugin = "org.jetbrains.intellij.platform.module")
    apply(plugin = "rpc")
    apply(plugin = "org.jetbrains.kotlin.jvm")
    apply(plugin = "org.jetbrains.kotlin.plugin.serialization")
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

        pluginModule(implementation(project(":shared")))
        pluginModule(implementation(project(":frontend")))
        pluginModule(implementation(project(":backend")))
    }
}


intellijPlatform {
    // Outside the repo: Rider turns a stray Program.csproj in the sandbox caches into the open solution.
    sandboxContainer = layout.dir(providers.provider { file("${System.getProperty("user.home")}/.cache/cockpit-rider-sandbox") })
    splitMode = true
    pluginInstallationTarget = SplitModeAware.PluginInstallationTarget.BOTH
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
    into("sidecar") { from(root.file("package.json")); from(root.file("package.nls.json")); from(root.file("package.nls.pt-br.json")) }
}

// Every sandbox (runIde, tests, buildPlugin) gets the sidecar next to the plugin's classes.
tasks.withType<org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask>().configureEach {
    dependsOn(sidecarFiles)
    from(sidecarFiles.map { it.destinationDir.resolve("sidecar") }) { into(pluginName.map { "$it/sidecar" }) }
}
