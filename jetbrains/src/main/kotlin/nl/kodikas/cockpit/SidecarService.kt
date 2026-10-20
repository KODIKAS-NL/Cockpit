package nl.kodikas.cockpit

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.invokeLater
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import java.io.File
import java.util.Locale
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Runs the Node sidecar for one project and answers its editor requests. */
@Service(Service.Level.PROJECT)
class SidecarService(private val project: Project) : Disposable {
    private val log = logger<SidecarService>()
    private var process: Process? = null
    private var rpc: Rpc? = null

    /** `http://127.0.0.1:<port>/?t=<token>`, once the sidecar is up. */
    val baseUrl = CompletableFuture<String>()

    @Synchronized
    fun start() {
        if (process != null) return
        val plugin = PluginManagerCore.getPlugin(PluginId.getId("nl.kodikas.cockpit"))
            ?: return fail("Cockpit plugin descriptor not found")
        val sidecarDir = plugin.pluginPath.resolve("sidecar").toFile()
        val script = File(sidecarDir, "dist/sidecar.js")
        if (!script.exists()) return fail("Missing ${script.path}")
        val node = findNode() ?: return fail("Node.js was not found. Install Node 20+ or set COCKPIT_NODE.")

        val p = ProcessBuilder(node, script.path, "--extension-path", sidecarDir.path)
            .redirectError(ProcessBuilder.Redirect.INHERIT)
            .start()
        process = p
        val pool = { r: Runnable -> ApplicationManager.getApplication().executeOnPooledThread(r); Unit }
        val peer = Rpc(p.inputStream.bufferedReader(), p.outputStream, pool)
        rpc = peer
        Handlers(project, peer).register()
        ApplicationManager.getApplication().executeOnPooledThread { peer.run() }

        val init = JsonObject().apply {
            project.basePath?.let { addProperty("workspaceRoot", it) }
            addProperty("language", Locale.getDefault().toLanguageTag())
            addProperty("localUi", true)
            addProperty("theme", ThemeCss.build())
        }
        peer.request("init", init).whenComplete { result, error ->
            if (error != null) return@whenComplete fail(error.message ?: error.toString())
            val o = result.asJsonObject
            baseUrl.complete("http://127.0.0.1:${o.get("port").asInt}/?t=${o.get("token").asString}")
        }
    }

    fun command(id: String) {
        rpc?.notify("command", mapOf("id" to id))
    }

    fun pushTheme() {
        rpc?.notify("theme", mapOf("css" to ThemeCss.build()))
    }

    private fun fail(message: String) {
        log.warn(message)
        baseUrl.completeExceptionally(IllegalStateException(message))
    }

    private fun findNode(): String? {
        System.getenv("COCKPIT_NODE")?.let { if (File(it).canExecute()) return it }
        val candidates = (System.getenv("PATH") ?: "").split(File.pathSeparator).map { File(it, "node") } +
            listOf(File("/opt/homebrew/bin/node"), File("/usr/local/bin/node"), File("/usr/bin/node"))
        return candidates.firstOrNull { it.canExecute() }?.path
    }

    override fun dispose() {
        runCatching { rpc?.notify("shutdown") }
        process?.let { if (!it.waitFor(2, TimeUnit.SECONDS)) it.destroyForcibly() }
        process = null
    }

    companion object {
        fun get(project: Project): SidecarService = project.service()
    }
}

/** The sidecar's editor requests (the EditorHost of src/sidecar/RpcHost.ts), on the IDE side. */
private class Handlers(private val project: Project, private val rpc: Rpc) {
    private fun group() = NotificationGroupManager.getInstance().getNotificationGroup("Cockpit")

    fun register() {
        rpc.on("notify") { p -> notify(p.asJsonObject) }
        rpc.on("hideNotifications") { null }
        rpc.on("confirm") { p ->
            val o = p.asJsonObject
            var ok = false
            ApplicationManager.getApplication().invokeAndWait {
                ok = Messages.showYesNoDialog(project, o["detail"].asString, o["message"].asString, o["action"].asString, "Cancel", null) == Messages.YES
            }
            ok
        }
        rpc.on("inputBox") { p ->
            val o = p.asJsonObject
            var value: String? = null
            ApplicationManager.getApplication().invokeAndWait {
                val title = o["title"]?.takeIf { it.isJsonPrimitive }?.asString ?: "Cockpit"
                val prompt = o["prompt"]?.takeIf { it.isJsonPrimitive }?.asString ?: ""
                val initial = o["value"]?.takeIf { it.isJsonPrimitive }?.asString
                value = if (o["password"]?.asBoolean == true) Messages.showPasswordDialog(project, prompt, title, null)
                else Messages.showInputDialog(project, prompt, title, null, initial, null)
            }
            value
        }
        rpc.on("statusMessage") { null }
        rpc.on("openFile") { p -> openFile(p.asJsonObject); null }
        rpc.on("previewFile") { p -> openFile(p.asJsonObject); null }
        rpc.on("openQuietly") { p -> openFile(p.asJsonObject, focus = false); null }
        rpc.on("findFiles") { p -> findFiles(p.asJsonObject) }
        rpc.on("saveIfDirty") { null }
        rpc.on("openExternal") { p -> com.intellij.ide.BrowserUtil.browse(p.asJsonObject["url"].asString); null }
        rpc.on("progress.begin") { null }
        rpc.on("progress.report") { null }
        rpc.on("progress.end") { null }
        rpc.on("focusToolWindow") {
            invokeLater {
                com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("Cockpit")?.activate(null)
            }
            null
        }
        rpc.on("status") { null }
        // Not in the first milestone: answered, so the core does not wait for them.
        rpc.on("showDiff") { null }
        rpc.on("runInTerminal") { null }
        rpc.on("openPath") { null }
        rpc.on("secrets.get") { null }
        rpc.on("secrets.store") { null }
        rpc.on("secrets.delete") { null }
        rpc.on("saveDialog") { null }
    }

    private fun notify(o: JsonObject): String? {
        val type = when (o["level"].asString) {
            "error" -> NotificationType.ERROR
            "warning" -> NotificationType.WARNING
            else -> NotificationType.INFORMATION
        }
        val actions = o["actions"].asJsonArray.map { it.asString }
        val chosen = CompletableFuture<String?>()
        val n = group().createNotification("Cockpit", o["message"].asString, type)
        for (a in actions) n.addAction(NotificationAction.createSimple(a) { chosen.complete(a); n.expire() })
        n.whenExpired { chosen.complete(null) }
        n.notify(project)
        return if (actions.isEmpty()) null else runCatching { chosen.get(10, TimeUnit.MINUTES) }.getOrNull()
    }

    private fun openFile(o: JsonObject, focus: Boolean = true) {
        val file = LocalFileSystem.getInstance().refreshAndFindFileByPath(o["path"].asString) ?: error("File not found")
        val line = o["line"]?.takeIf { it.isJsonPrimitive }?.asInt?.minus(1) ?: 0
        invokeLater { OpenFileDescriptor(project, file, line, 0).navigate(focus) }
    }

    private fun findFiles(o: JsonObject): List<String> {
        val name = o["glob"].asString.substringAfterLast('/')
        val max = o["max"]?.asInt ?: 1
        return com.intellij.openapi.application.runReadAction {
            FilenameIndex.getVirtualFilesByName(name, GlobalSearchScope.projectScope(project)).take(max).map { it.path }
        }
    }
}
