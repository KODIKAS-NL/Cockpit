package nl.kodikas.cockpit

import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.ProjectManager
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel
import java.io.File
import java.util.Locale
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Settings > Tools > Cockpit for Claude Code. The form is built from the settings the manifest declares
 * (package.json, the same list VS Code shows), and saved to ~/.cockpit/jetbrains-settings.json, the file the sidecar reads.
 * Settings that are lists or objects are edited in the file (Tools > Cockpit > Open Settings File).
 */
class CockpitSettings : Configurable {
    private class Field(val key: String, val default: JsonElement?, val read: () -> JsonElement?, val write: (JsonElement?) -> Unit)

    private val gson = GsonBuilder().setPrettyPrinting().create()
    private val file = File(System.getProperty("user.home"), ".cockpit/jetbrains-settings.json")
    private val fields = ArrayList<Field>()
    private var panel: JComponent? = null

    override fun getDisplayName() = "Cockpit for Claude Code"

    private fun sidecarDir(): File? =
        PluginManagerCore.getPlugin(PluginId.getId("nl.kodikas.cockpit"))?.pluginPath?.resolve("sidecar")?.toFile()

    private fun readObject(f: File): JsonObject =
        runCatching { JsonParser.parseString(f.readText()).asJsonObject }.getOrDefault(JsonObject())

    private fun strings(): Map<String, String> {
        val dir = sidecarDir() ?: return emptyMap()
        val en = readObject(File(dir, "package.nls.json"))
        val pt = if (Locale.getDefault().language == "pt") readObject(File(dir, "package.nls.pt-br.json")) else JsonObject()
        return en.entrySet().associate { it.key to (pt.get(it.key)?.takeIf { v -> v.isJsonPrimitive }?.asString ?: it.value.asString) }
    }

    private fun humanize(key: String): String =
        key.replace(Regex("([a-z0-9])([A-Z])"), "$1 $2").lowercase().replaceFirstChar { it.uppercase() }

    override fun createComponent(): JComponent {
        fields.clear()
        val manifest = sidecarDir()?.let { readObject(File(it, "package.json")) }
        val props = manifest?.getAsJsonObject("contributes")?.getAsJsonObject("configuration")?.getAsJsonObject("properties")
        val nls = strings()
        val saved = readObject(file)
        val p = panel {
            if (props == null) row { label("The settings list was not found in the plugin.") }
            else for ((full, def) in props.entrySet()) {
                if (!full.startsWith("cockpitDaemon.")) continue
                val key = full.removePrefix("cockpitDaemon.")
                val d = def.asJsonObject
                val type = d.get("type")?.takeIf { it.isJsonPrimitive }?.asString
                val default = d.get("default")
                val current = saved.get(key) ?: default
                val text = d.get("description")?.asString?.let { Regex("^%(.+)%$").find(it)?.let { m -> nls[m.groupValues[1]] } ?: it } ?: ""
                val title = humanize(key)
                when {
                    type == "boolean" -> row {
                        val box = checkBox(title).comment(text, 70).component
                        box.isSelected = current?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false
                        fields += Field(key, default, { com.google.gson.JsonPrimitive(box.isSelected) }, { v -> box.isSelected = v?.asBoolean ?: false })
                    }
                    type == "string" && d.has("enum") -> row(title) {
                        val values = d.getAsJsonArray("enum").map { it.asString }
                        val combo = comboBox(values).comment(text, 70).component
                        combo.selectedItem = current?.asString
                        fields += Field(key, default, { com.google.gson.JsonPrimitive(combo.selectedItem as String) }, { v -> combo.selectedItem = v?.asString })
                    }
                    type == "string" || type == "number" || type == "integer" -> row(title) {
                        val number = type != "string"
                        val tf = textField().columns(40).comment(text, 70).component
                        tf.text = current?.takeIf { it.isJsonPrimitive }?.asString ?: ""
                        fields += Field(key, default, {
                            val s = tf.text
                            if (number) s.toDoubleOrNull()?.let { n -> com.google.gson.JsonPrimitive(if (n % 1.0 == 0.0) n.toLong() else n) } else com.google.gson.JsonPrimitive(s)
                        }, { v -> tf.text = v?.takeIf { it.isJsonPrimitive }?.asString ?: "" })
                    }
                }
            }
        }
        panel = p
        return JBScrollPane(p, JBScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED, JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER).also { it.border = null }
    }

    /** What the file would hold after Apply: the values that differ from the defaults. */
    private fun target(): JsonObject {
        val out = readObject(file)
        for (f in fields) {
            val v = f.read()
            if (v == null || v == f.default) out.remove(f.key) else out.add(f.key, v)
        }
        return out
    }

    override fun isModified(): Boolean = fields.isNotEmpty() && target() != readObject(file)

    override fun apply() {
        file.parentFile.mkdirs()
        file.writeText(gson.toJson(target()) + "\n")
        for (p in ProjectManager.getInstance().openProjects) SidecarService.get(p).send("settingsFileChanged")
    }

    override fun reset() {
        val saved = readObject(file)
        for (f in fields) f.write(saved.get(f.key) ?: f.default)
    }
}
