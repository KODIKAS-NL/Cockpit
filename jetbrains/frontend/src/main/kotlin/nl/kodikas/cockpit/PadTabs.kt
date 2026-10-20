package nl.kodikas.cockpit

import com.intellij.openapi.application.invokeLater
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorLocation
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.jcef.JBCefBrowser
import java.beans.PropertyChangeListener
import java.net.URLEncoder
import javax.swing.JComponent

/** The file a scratchpad board opens as: a virtual file that only carries the conversation key. */
class PadFile(val key: String, title: String) : LightVirtualFile("Scratchpad: $title")

/** A scratchpad board is an editor tab that shows the page the sidecar serves. */
object PadTabs {
    private val files = HashMap<String, PadFile>()

    fun open(project: Project, key: String, title: String) {
        CockpitFrontend.get(project).baseUrl.whenComplete { _, error ->
            if (error != null) return@whenComplete
            invokeLater {
                val file = files.getOrPut(key) { PadFile(key, title.removePrefix("Scratchpad: ").take(40)) }
                FileEditorManager.getInstance(project).openFile(file, true)
            }
        }
    }

    fun url(project: Project, key: String): String? =
        CockpitFrontend.get(project).baseUrl.getNow(null)?.replace("/?t=", "/pad?t=")?.plus("&key=" + URLEncoder.encode(key, "UTF-8"))
}

class PadEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile) = file is PadFile
    override fun createEditor(project: Project, file: VirtualFile): FileEditor = PadEditor(project, file as PadFile)
    override fun getEditorTypeId() = "cockpit-scratchpad"
    override fun getPolicy() = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

private class PadEditor(project: Project, private val pad: PadFile) : UserDataHolderBase(), FileEditor {
    private val browser = JBCefBrowser().also { b -> PadTabs.url(project, pad.key)?.let { b.loadURL(it) } }
    override fun getComponent(): JComponent = browser.component
    override fun getPreferredFocusedComponent(): JComponent = browser.component
    override fun getName() = "Scratchpad"
    override fun getFile(): VirtualFile = pad
    override fun setState(state: FileEditorState) {}
    override fun isModified() = false
    override fun isValid() = true
    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}
    override fun getCurrentLocation(): FileEditorLocation? = null
    override fun dispose() {
        browser.dispose()
    }
}
