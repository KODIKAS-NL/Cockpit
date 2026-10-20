package nl.kodikas.cockpit

import com.intellij.codeInsight.editorActions.CopyPastePreProcessor
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.RawText
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.project.ProjectManager
import com.intellij.psi.PsiFile

/** Tells the sidecar what was copied and where from, so pasting it into the prompt becomes a reference pill. */
class CopyAsReference : CopyPastePreProcessor {
    override fun preprocessOnCopy(file: PsiFile?, startOffsets: IntArray, endOffsets: IntArray, text: String): String? {
        val psi = file ?: return null
        if (startOffsets.size != 1 || text.isBlank()) return null
        val project = psi.project
        val doc = psi.viewProvider.document ?: return null
        val vf = FileDocumentManager.getInstance().getFile(doc) ?: return null
        val startLine = doc.getLineNumber(startOffsets[0]) + 1
        val endLine = doc.getLineNumber(endOffsets[0]) + 1
        val endChar = endOffsets[0] - doc.getLineStartOffset(doc.getLineNumber(endOffsets[0]))
        val rel = ProjectPaths.relative(project, vf.path)
        SidecarService.get(project).send("copySource", mapOf("text" to text, "ref" to buildRef(rel, startLine, endLine, endChar)))
        return null
    }

    override fun preprocessOnPaste(project: Project?, file: PsiFile?, editor: Editor?, text: String?, rawText: RawText?): String = text ?: ""

    private fun buildRef(rel: String, start: Int, endLine: Int, endChar: Int): String {
        val end = if (endLine > start && endChar == 0) endLine - 1 else endLine
        return "@$rel#L$start${if (end > start) "-$end" else ""}"
    }
}

object ProjectPaths {
    /** The folder the chat treats as the workspace: Rider's solution folder, not always the platform's base path. */
    fun root(project: Project): String? =
        (project.guessProjectDir()?.path ?: project.basePath)?.trimEnd('/')

    fun relative(project: Project, path: String): String {
        val root = root(project) ?: return path
        return if (path.startsWith("$root/")) path.removePrefix("$root/") else path
    }
}
