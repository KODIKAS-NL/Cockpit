package nl.kodikas.cockpit

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
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
import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.generateServiceName
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.concurrency.JobScheduler
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.wm.WindowManager
import org.jetbrains.plugins.terminal.TerminalToolWindowManager
import java.util.concurrent.ConcurrentHashMap
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
            .start()
        process = p
        // The page follows the IDE: a new look-and-feel or editor colour scheme re-sends the theme.
        val bus = ApplicationManager.getApplication().messageBus.connect(this)
        bus.subscribe(LafManagerListener.TOPIC, LafManagerListener { invokeLater { pushTheme() } })
        bus.subscribe(EditorColorsManager.TOPIC, EditorColorsListener { invokeLater { pushTheme() } })
        ApplicationManager.getApplication().executeOnPooledThread {
            p.errorStream.bufferedReader().forEachLine { log.info("[sidecar] $it") }
        }
        val pool = { r: Runnable -> ApplicationManager.getApplication().executeOnPooledThread(r); Unit }
        val peer = Rpc(p.inputStream.bufferedReader(), p.outputStream, pool)
        rpc = peer
        Handlers(project, peer).register()
        ApplicationManager.getApplication().executeOnPooledThread { peer.run() }

        val init = JsonObject().apply {
            ProjectPaths.root(project)?.let { addProperty("workspaceRoot", it) }
            addProperty("language", Locale.getDefault().toLanguageTag())
            addProperty("localUi", true)
            addProperty("theme", ThemeCss.build())
        }
        peer.request("init", init).whenComplete { result, error ->
            if (error != null) return@whenComplete fail(error.message ?: error.toString())
            val o = result.asJsonObject
            log.info("sidecar up on port ${o.get("port").asInt}")
            baseUrl.complete("http://127.0.0.1:${o.get("port").asInt}/?t=${o.get("token").asString}")
        }
    }

    fun command(id: String) {
        rpc?.notify("command", mapOf("id" to id))
    }

    /** A fire-and-forget event to the sidecar (a no-op until it is up). */
    fun send(method: String, params: Any? = null) {
        rpc?.notify(method, params)
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
        rpc.on("statusMessage") { p -> statusMessage(p.asJsonObject); null }
        rpc.on("openFile") { p -> openFile(p.asJsonObject); null }
        rpc.on("previewFile") { p -> openFile(p.asJsonObject); null }
        rpc.on("openQuietly") { p -> openFile(p.asJsonObject, focus = false); null }
        rpc.on("findFiles") { p -> findFiles(p.asJsonObject) }
        rpc.on("saveIfDirty") { null }
        rpc.on("openExternal") { p -> com.intellij.ide.BrowserUtil.browse(p.asJsonObject["url"].asString); null }
        rpc.on("progress.begin") { p -> progressBegin(p.asJsonObject); null }
        rpc.on("progress.report") { p -> progressReport(p.asJsonObject); null }
        rpc.on("progress.end") { p -> progress.remove(p.asJsonObject["id"].asInt)?.done?.complete(Unit); null }
        rpc.on("focusToolWindow") {
            invokeLater {
                com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("Cockpit")?.activate(null)
            }
            null
        }
        rpc.on("status") { null }
        rpc.on("openSettingsPage") {
            invokeLater { com.intellij.openapi.options.ShowSettingsUtil.getInstance().showSettingsDialog(project, CockpitSettings::class.java) }
            null
        }
        rpc.on("openPad") { p -> PadTabs.open(project, p.asJsonObject["key"].asString, p.asJsonObject["title"].asString); null }
        rpc.on("showDiff") { p -> showDiff(p.asJsonObject); null }
        rpc.on("runInTerminal") { p -> runInTerminal(p.asJsonObject); null }
        rpc.on("openPath") { p ->
            com.intellij.ide.actions.RevealFileAction.openFile(File(p.asJsonObject["path"].asString))
            null
        }
        rpc.on("secrets.get") { p -> PasswordSafe.instance.getPassword(secretAttrs(p.asJsonObject)) }
        rpc.on("secrets.store") { p ->
            val o = p.asJsonObject
            PasswordSafe.instance.setPassword(secretAttrs(o), o["value"].asString)
            null
        }
        rpc.on("secrets.delete") { p -> PasswordSafe.instance.setPassword(secretAttrs(p.asJsonObject), null); null }
        rpc.on("saveDialog") { p -> saveDialog(p.asJsonObject) }
    }

    private fun secretAttrs(o: JsonObject) =
        CredentialAttributes(generateServiceName("Cockpit", o["key"].asString))

    private fun statusMessage(o: JsonObject) {
        val text = o["text"].asString
        val ms = o["ms"]?.asLong ?: 5000
        invokeLater {
            val bar = WindowManager.getInstance().getStatusBar(project) ?: return@invokeLater
            bar.info = text
            JobScheduler.getScheduler().schedule({ invokeLater { if (bar.info == text) bar.info = "" } }, ms, TimeUnit.MILLISECONDS)
        }
    }

    private class Progress(val indicator: CompletableFuture<ProgressIndicator>, val done: CompletableFuture<Unit>)

    private val progress = ConcurrentHashMap<Int, Progress>()

    private fun progressBegin(o: JsonObject) {
        val id = o["id"].asInt
        val title = o["title"].asString
        val entry = Progress(CompletableFuture(), CompletableFuture())
        progress[id] = entry
        val cancellable = o["cancellable"]?.asBoolean == true
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, cancellable) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = false
                indicator.fraction = 0.0
                entry.indicator.complete(indicator)
                while (!entry.done.isDone) {
                    if (indicator.isCanceled) { rpc.notify("progress.cancel", mapOf("id" to id)); break }
                    runCatching { entry.done.get(200, TimeUnit.MILLISECONDS) }
                }
            }
        })
    }

    private fun progressReport(o: JsonObject) {
        val entry = progress[o["id"].asInt] ?: return
        val ind = entry.indicator.getNow(null) ?: return
        o["message"]?.takeIf { it.isJsonPrimitive }?.let { ind.text = it.asString }
        o["increment"]?.takeIf { it.isJsonPrimitive }?.let { ind.fraction = (ind.fraction + it.asDouble / 100.0).coerceIn(0.0, 1.0) }
    }

    private fun diffContent(side: JsonObject, name: String): com.intellij.diff.contents.DiffContent {
        val factory = DiffContentFactory.getInstance()
        val fileType = FileTypeManager.getInstance().getFileTypeByFileName(name)
        side["path"]?.takeIf { it.isJsonPrimitive }?.let { path ->
            val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(path.asString)
            return if (vf != null) factory.create(project, vf) else factory.create(project, "", fileType)
        }
        return factory.create(project, side["text"]?.takeIf { it.isJsonPrimitive }?.asString ?: "", fileType)
    }

    private fun showDiff(o: JsonObject) {
        val name = o["name"].asString
        val title = o["title"].asString
        invokeLater {
            val left = diffContent(o["left"].asJsonObject, name)
            val right = diffContent(o["right"].asJsonObject, name)
            DiffManager.getInstance().showDiff(project, SimpleDiffRequest(title, left, right, name, name))
        }
    }

    private fun runInTerminal(o: JsonObject) {
        val name = o["name"].asString
        val command = o["command"].asString
        invokeLater {
            val widget = TerminalToolWindowManager.getInstance(project).createShellWidget(project.basePath, name, true, true)
            widget.sendCommandToExecute(command)
        }
    }

    private fun saveDialog(o: JsonObject): String? {
        val target = File(o["defaultPath"].asString)
        var result: String? = null
        ApplicationManager.getApplication().invokeAndWait {
            val ext = o["filters"]?.takeIf { it.isJsonObject }?.asJsonObject?.entrySet()?.firstOrNull()
                ?.value?.asJsonArray?.map { it.asString }?.toTypedArray() ?: emptyArray()
            val descriptor = FileSaverDescriptor("Cockpit", "", *ext)
            val dir = target.parentFile?.let { LocalFileSystem.getInstance().refreshAndFindFileByIoFile(it) }
            result = FileChooserFactory.getInstance().createSaveFileDialog(descriptor, project)
                .save(dir, target.name)?.file?.path
        }
        return result
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

    private val skipDirs = setOf("node_modules", ".git", "bin", "obj", ".idea", ".gradle", "build", "dist")

    private fun findFiles(o: JsonObject): List<String> {
        val name = o["glob"].asString.substringAfterLast('/')
        val max = o["max"]?.asInt ?: 1
        val indexed = com.intellij.openapi.application.runReadAction {
            runCatching { FilenameIndex.getVirtualFilesByName(name, GlobalSearchScope.projectScope(project)).take(max).map { it.path } }
                .getOrDefault(emptyList())
        }
        if (indexed.isNotEmpty()) return indexed
        // Rider keeps its own file index on the backend, so the platform index can be empty: walk the folder.
        val root = project.basePath?.let { File(it) } ?: return emptyList()
        return root.walkTopDown().onEnter { it.name !in skipDirs }.filter { it.isFile && it.name == name }
            .take(max).map { it.path }.toList()
    }
}
