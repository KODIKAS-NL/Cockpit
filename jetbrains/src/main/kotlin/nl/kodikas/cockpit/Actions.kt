package nl.kodikas.cockpit

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.wm.ToolWindowManager

/** An action that runs one of the `cockpitDaemon.*` commands of the sidecar (the ids of the VS Code manifest). */
abstract class CockpitAction(private val commandId: String, private val showWindow: Boolean = false) : AnAction(), DumbAware {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        if (showWindow) ToolWindowManager.getInstance(project).getToolWindow("Cockpit")?.activate(null)
        val sidecar = SidecarService.get(project)
        sidecar.start()
        sidecar.command(commandId)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun getActionUpdateThread() = com.intellij.openapi.actionSystem.ActionUpdateThread.BGT
}

class OpenCockpitAction : CockpitAction("cockpitDaemon.focusPrompt", showWindow = true)
class NewSessionAction : CockpitAction("cockpitDaemon.newSession", showWindow = true)
class ScratchpadAction : CockpitAction("cockpitDaemon.scratchpad")
class InterruptAction : CockpitAction("cockpitDaemon.interrupt")
class SessionsAction : CockpitAction("cockpitDaemon.openSessions", showWindow = true)
class SettingsFileAction : CockpitAction("cockpitDaemon.settings")
class LoginAction : CockpitAction("cockpitDaemon.login")
class LogoutAction : CockpitAction("cockpitDaemon.logout")
class RestartDaemonAction : CockpitAction("cockpitDaemon.daemon.restart")
class ShowDaemonLogAction : CockpitAction("cockpitDaemon.daemon.showLog")

class SettingsPageAction : AnAction(), DumbAware {
    override fun actionPerformed(e: AnActionEvent) {
        com.intellij.openapi.options.ShowSettingsUtil.getInstance().showSettingsDialog(e.project, CockpitSettings::class.java)
    }
}
