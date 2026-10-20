package nl.kodikas.cockpit

import com.intellij.openapi.diagnostic.logger
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
        val sidecar = CockpitFrontend.get(project)
        sidecar.start()
        for ((title, view) in listOf("Chat" to "sidebar", "Hub" to "hub")) {
            val browser = JBCefBrowser()
            toolWindow.contentManager.addContent(factory.createContent(browser.component, title, false).also { it.setDisposer(browser) })
            browser.jbCefClient.addLoadHandler(object : org.cef.handler.CefLoadHandlerAdapter() {
                override fun onLoadError(b: org.cef.browser.CefBrowser?, f: org.cef.browser.CefFrame?, code: org.cef.handler.CefLoadHandler.ErrorCode?, text: String?, url: String?) {
                    logger<CockpitToolWindowFactory>().warn("Cockpit page failed to load ($view): $code $text $url")
                }
            }, browser.cefBrowser)
            sidecar.baseUrl.whenComplete { base, error ->
                if (error != null) {
                    browser.loadHTML("<body style='font-family:sans-serif'><h3>Cockpit could not start</h3><p>${error.message}</p></body>")
                } else {
                    logger<CockpitToolWindowFactory>().info("Cockpit loading $view")
                    browser.loadURL("$base&view=$view")
                }
            }
        }
    }
}
