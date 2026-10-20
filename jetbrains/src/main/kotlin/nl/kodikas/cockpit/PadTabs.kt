package nl.kodikas.cockpit

import com.intellij.openapi.application.invokeLater
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import java.net.URLEncoder

/** A scratchpad board is a closeable tab of the Cockpit tool window that shows the page the sidecar serves. */
object PadTabs {
    fun open(project: Project, key: String, title: String) {
        val sidecar = SidecarService.get(project)
        sidecar.baseUrl.whenComplete { base, error ->
            if (error != null) return@whenComplete
            invokeLater {
                val window = ToolWindowManager.getInstance(project).getToolWindow("Cockpit") ?: return@invokeLater
                val tabName = "Scratchpad: $title".take(40)
                val existing = window.contentManager.contents.firstOrNull { it.getUserData(KEY) == key }
                if (existing != null) {
                    window.contentManager.setSelectedContent(existing)
                } else {
                    val browser = JBCefBrowser()
                    val content = ContentFactory.getInstance().createContent(browser.component, tabName, false)
                    content.putUserData(KEY, key)
                    content.isCloseable = true
                    content.setDisposer(browser)
                    window.contentManager.addContent(content)
                    window.contentManager.setSelectedContent(content)
                    browser.loadURL(base.replace("/?t=", "/pad?t=") + "&key=" + URLEncoder.encode(key, "UTF-8"))
                }
                window.activate(null)
            }
        }
    }

    private val KEY = com.intellij.openapi.util.Key.create<String>("cockpit.pad.key")
}
