package nl.kodikas.cockpit

import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.Color

/** The IDE colours as the `--vscode-*` variables the chat UI is written against. */
object ThemeCss {
    // Some theme colours are translucent (hover backgrounds); dropping the alpha turns them black.
    private fun hex(c: Color?): String? = c?.let {
        if (it.alpha == 255) String.format("#%02x%02x%02x", it.red, it.green, it.blue)
        else String.format("rgba(%d, %d, %d, %.3f)", it.red, it.green, it.blue, it.alpha / 255.0)
    }

    fun build(): String {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val fg = UIUtil.getLabelForeground()
        val bg = UIUtil.getPanelBackground()
        val editorBg = scheme.defaultBackground
        val dark = !JBColor.isBright()
        val border = JBColor.border()
        val focus = JBUI.CurrentTheme.Focus.focusColor()
        val link = JBUI.CurrentTheme.Link.Foreground.ENABLED
        val vars = linkedMapOf(
            "font-family" to "\"${UIUtil.getLabelFont().family}\", -apple-system, sans-serif",
            "font-size" to "${UIUtil.getLabelFont().size}px",
            "editor-font-family" to "\"${scheme.editorFontName}\", Menlo, monospace",
            "editor-font-size" to "${scheme.editorFontSize}px",
            "foreground" to hex(fg),
            "descriptionForeground" to hex(UIUtil.getContextHelpForeground()),
            "errorForeground" to hex(JBUI.CurrentTheme.Validator.errorBorderColor()),
            "focusBorder" to hex(focus),
            "panel-border" to hex(border),
            "widget-border" to hex(border),
            "sideBar-background" to hex(bg),
            "editor-background" to hex(editorBg),
            "editor-foreground" to hex(scheme.defaultForeground),
            "editorWidget-background" to hex(UIUtil.getPanelBackground()),
            "input-background" to hex(UIUtil.getTextFieldBackground()),
            "input-foreground" to hex(fg),
            "input-border" to hex(border),
            "button-background" to hex(JBUI.CurrentTheme.Button.defaultButtonColorStart()),
            "button-hoverBackground" to hex(JBUI.CurrentTheme.Button.defaultButtonColorEnd()),
            "button-foreground" to "#ffffff",
            "button-secondaryBackground" to hex(JBUI.CurrentTheme.Button.buttonColorStart()),
            "button-secondaryHoverBackground" to hex(JBUI.CurrentTheme.ActionButton.pressedBackground()),
            "button-secondaryForeground" to hex(fg),
            "badge-background" to hex(JBUI.CurrentTheme.Button.defaultButtonColorStart()),
            "badge-foreground" to "#ffffff",
            "toolbar-hoverBackground" to hex(JBUI.CurrentTheme.ActionButton.hoverBackground()),
            "dropdown-background" to hex(UIUtil.getTextFieldBackground()),
            "dropdown-foreground" to hex(fg),
            "dropdown-border" to hex(border),
            "editorWidget-border" to hex(border),
            "editorHoverWidget-background" to hex(UIUtil.getPanelBackground()),
            "editorHoverWidget-border" to hex(border),
            "menu-background" to hex(UIUtil.getPanelBackground()),
            "menu-border" to hex(border),
            "input-placeholderForeground" to hex(UIUtil.getContextHelpForeground()),
            "list-activeSelectionForeground" to hex(UIUtil.getListSelectionForeground(true)),
            "textCodeBlock-background" to hex(editorBg),
            "inputValidation-errorBorder" to hex(JBUI.CurrentTheme.Validator.errorBorderColor()),
            "inputValidation-warningBorder" to hex(JBUI.CurrentTheme.Validator.warningBorderColor()),
            "textLink-foreground" to hex(link),
            "list-hoverBackground" to hex(JBUI.CurrentTheme.List.Hover.background(true)),
            "list-activeSelectionBackground" to hex(JBUI.CurrentTheme.List.Selection.background(true)),
            "charts-red" to if (dark) "#f14c4c" else "#e51400",
            "charts-blue" to if (dark) "#3794ff" else "#1a85ff",
            "charts-yellow" to if (dark) "#cca700" else "#bf8803",
            "charts-green" to if (dark) "#89d185" else "#388a34",
            "charts-orange" to if (dark) "#d18616" else "#d18616",
            "charts-purple" to if (dark) "#b180d7" else "#652d90",
        )
        val body = vars.entries.filter { it.value != null }.joinToString("\n") { "  --vscode-${it.key}: ${it.value};" }
        return ":root {\n  color-scheme: ${if (dark) "dark" else "light"};\n$body\n}\nbody { background: ${hex(bg)}; color: ${hex(fg)}; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }"
    }
}
