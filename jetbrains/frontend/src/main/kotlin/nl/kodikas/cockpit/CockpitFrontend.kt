@file:Suppress("UnstableApiUsage")

package nl.kodikas.cockpit

import com.intellij.ide.ui.LafManagerListener
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.invokeLater
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ex.ToolWindowManagerListener
import com.intellij.platform.project.projectId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CompletableFuture

/**
 * The window side of Cockpit: asks the backend for the sidecar, reaches it (directly when it runs
 * on this machine, through an SSH tunnel when the backend is a remote host) and keeps the page's
 * theme and the tool window state in step with this IDE.
 */
@Service(Service.Level.PROJECT)
class CockpitFrontend(private val project: Project, private val scope: CoroutineScope) : Disposable {
    private val log = logger<CockpitFrontend>()
    private var tunnel: Process? = null
    private var started = false

    /** `http://127.0.0.1:<port>/?t=<token>` as this window can reach it. */
    val baseUrl = CompletableFuture<String>()

    @Synchronized
    fun start() {
        if (started) return
        started = true
        scope.launch(Dispatchers.IO) {
            try {
                val info = CockpitRpcApi.getInstance().start(project.projectId(), ThemeCss.build())
                if (info.error != null) return@launch fail(info.error!!)
                val port = reach(info.port) ?: return@launch fail("Could not reach the Cockpit sidecar on the backend")
                baseUrl.complete("http://127.0.0.1:$port/?t=${info.token}")
                listen()
            } catch (e: Exception) {
                fail(e.message ?: e.toString())
            }
        }
    }

    fun command(id: String) {
        start()
        scope.launch(Dispatchers.IO) { CockpitRpcApi.getInstance().command(project.projectId(), id) }
    }

    private fun listen() {
        val bus = ApplicationManager.getApplication().messageBus.connect(this)
        val push = Runnable {
            val css = ThemeCss.build()
            scope.launch(Dispatchers.IO) { CockpitRpcApi.getInstance().theme(project.projectId(), css) }
        }
        bus.subscribe(LafManagerListener.TOPIC, LafManagerListener { invokeLater { push.run() } })
        bus.subscribe(EditorColorsManager.TOPIC, EditorColorsListener { invokeLater { push.run() } })
        project.messageBus.connect(this).subscribe(ToolWindowManagerListener.TOPIC, object : ToolWindowManagerListener {
            override fun stateChanged(toolWindowManager: com.intellij.openapi.wm.ToolWindowManager) {
                val visible = toolWindowManager.getToolWindow("Cockpit")?.isVisible ?: false
                scope.launch(Dispatchers.IO) { CockpitRpcApi.getInstance().sidebarVisible(project.projectId(), visible) }
            }
        })
        scope.launch(Dispatchers.IO) {
            CockpitRpcApi.getInstance().padRequests(project.projectId()).collect { PadTabs.open(project, it.key, it.title) }
        }
    }

    /** The local port that leads to the sidecar's [port]: the port itself when it is open here, else an SSH tunnel. */
    private suspend fun reach(port: Int): Int? = withContext(Dispatchers.IO) {
        if (open(port)) return@withContext port
        val host = sshHost() ?: return@withContext null
        val local = ServerSocket(0).use { it.localPort }
        log.info("Opening an SSH tunnel to $host (sidecar port $port) on local port $local")
        val p = ProcessBuilder("ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-L", "$local:127.0.0.1:$port", host)
            .redirectErrorStream(true).start()
        tunnel = p
        ApplicationManager.getApplication().executeOnPooledThread { p.inputStream.bufferedReader().forEachLine { log.info("[ssh] $it") } }
        repeat(50) {
            if (open(local)) return@withContext local
            if (!p.isAlive) return@withContext null
            Thread.sleep(200)
        }
        null
    }

    private fun open(port: Int) = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 300); true }
    } catch (_: Exception) {
        false
    }

    private fun sshHost(): String? {
        val props = PropertiesComponent.getInstance()
        props.getValue("cockpit.sshHost")?.takeIf { it.isNotBlank() }?.let { return it }
        System.getenv("COCKPIT_SSH_HOST")?.takeIf { it.isNotBlank() }?.let { return it }
        var host: String? = null
        ApplicationManager.getApplication().invokeAndWait {
            host = Messages.showInputDialog(
                project,
                "The Cockpit sidecar runs on the remote host. Enter the SSH host (as in ~/.ssh/config) to tunnel to it:",
                "Cockpit", null,
            )
        }
        host?.takeIf { it.isNotBlank() }?.also { props.setValue("cockpit.sshHost", it) }
        return host?.takeIf { it.isNotBlank() }
    }

    private fun fail(message: String) {
        log.warn(message)
        baseUrl.completeExceptionally(IllegalStateException(message))
    }

    override fun dispose() {
        tunnel?.destroy()
    }

    companion object {
        fun get(project: Project): CockpitFrontend = project.service()
    }
}
