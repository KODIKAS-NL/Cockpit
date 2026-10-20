package nl.kodikas.cockpit

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.ex.ToolWindowManagerListener

/** Tells the sidecar what the editor is doing: selection, open documents, the tool window, the settings file. */
class EditorEvents : ProjectActivity {
    override suspend fun execute(project: Project) {
        val sidecar = SidecarService.get(project)
        val bus = project.messageBus.connect(sidecar)

        fun docs() = FileEditorManager.getInstance(project).openFiles.map { it.path }
        bus.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun fileOpened(source: FileEditorManager, file: VirtualFile) = sidecar.send("docs", mapOf("open" to docs()))
            override fun fileClosed(source: FileEditorManager, file: VirtualFile) = sidecar.send("docs", mapOf("open" to docs()))
        })

        bus.subscribe(ToolWindowManagerListener.TOPIC, object : ToolWindowManagerListener {
            override fun stateChanged(toolWindowManager: ToolWindowManager) {
                val visible = toolWindowManager.getToolWindow("Cockpit")?.isVisible ?: false
                sidecar.send("sidebarVisible", mapOf("visible" to visible))
            }
        })

        EditorFactory.getInstance().eventMulticaster.addSelectionListener(object : SelectionListener {
            override fun selectionChanged(e: SelectionEvent) {
                if (e.editor.project != project) return
                val file = FileEditorManager.getInstance(project).selectedFiles.firstOrNull() ?: return
                val doc = e.editor.document
                val range = e.newRange
                if (range.isEmpty) return sidecar.send("selection", null)
                val rel = ProjectPaths.relative(project, file.path)
                val end = doc.getLineNumber(range.endOffset)
                sidecar.send(
                    "selection",
                    mapOf(
                        "path" to rel,
                        "startLine" to doc.getLineNumber(range.startOffset) + 1,
                        "endLine" to end + 1,
                        "endChar" to range.endOffset - doc.getLineStartOffset(end),
                        "docKey" to file.path,
                    ),
                )
            }
        }, sidecar)

        // The settings file is edited as a normal file; saving it applies the change.
        ApplicationManager.getApplication().messageBus.connect(sidecar).subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                if (events.any { it.path.endsWith("/.cockpit/jetbrains-settings.json") }) sidecar.send("settingsFileChanged")
            }
        })
    }
}
