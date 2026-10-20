package nl.kodikas.cockpit

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import javax.swing.JLabel

/** The Cockpit tool window: two browser tabs (Chat, Hub) that show pages served by the sidecar. */
class CockpitToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        if (!JBCefApp.isSupported()) {
            toolWindow.contentManager.addContent(factory.createContent(JLabel("The embedded browser (JCEF) is not available in this IDE."), "", false))
            return
        }
        val sidecar = SidecarService.get(project)
        sidecar.start()
        for ((title, view) in listOf("Chat" to "sidebar", "Hub" to "hub")) {
            val browser = JBCefBrowser()
            toolWindow.contentManager.addContent(factory.createContent(browser.component, title, false).also { it.setDisposer(browser) })
            sidecar.baseUrl.thenAccept { base -> browser.loadURL("$base&view=$view") }
        }
    }
}
