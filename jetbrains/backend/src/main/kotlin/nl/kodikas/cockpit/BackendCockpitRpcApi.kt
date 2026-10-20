@file:Suppress("UnstableApiUsage")

package nl.kodikas.cockpit

import com.intellij.platform.project.ProjectId
import com.intellij.platform.project.findProjectOrNull
import com.intellij.platform.rpc.backend.RemoteApiProvider
import fleet.rpc.remoteApiDescriptor
import kotlinx.coroutines.future.await

internal class BackendRpcApiProvider : RemoteApiProvider {
    override fun RemoteApiProvider.Sink.remoteApis() {
        remoteApi(remoteApiDescriptor<CockpitRpcApi>()) { BackendCockpitRpcApi() }
    }
}

class BackendCockpitRpcApi : CockpitRpcApi {
    override suspend fun start(projectId: ProjectId, theme: String): SidecarInfoDto {
        val project = projectId.findProjectOrNull() ?: return SidecarInfoDto(error = "Project not found")
        val sidecar = SidecarService.get(project)
        sidecar.start(theme)
        return try {
            val url = sidecar.baseUrl.await()
            val m = Regex("""127\.0\.0\.1:(\d+)/\?t=(.+)""").find(url) ?: return SidecarInfoDto(error = "Unexpected sidecar url")
            SidecarInfoDto(port = m.groupValues[1].toInt(), token = m.groupValues[2])
        } catch (e: Exception) {
            SidecarInfoDto(error = e.message ?: e.toString())
        }
    }

    override suspend fun command(projectId: ProjectId, id: String) {
        val project = projectId.findProjectOrNull() ?: return
        SidecarService.get(project).run { start(); command(id) }
    }

    override suspend fun theme(projectId: ProjectId, css: String) {
        SidecarService.get(projectId.findProjectOrNull() ?: return).pushTheme(css)
    }

    override suspend fun padRequests(projectId: ProjectId): kotlinx.coroutines.flow.Flow<PadRequestDto> {
        val project = projectId.findProjectOrNull() ?: return kotlinx.coroutines.flow.emptyFlow()
        return SidecarService.get(project).pads
    }

    override suspend fun sidebarVisible(projectId: ProjectId, visible: Boolean) {
        SidecarService.get(projectId.findProjectOrNull() ?: return).send("sidebarVisible", mapOf("visible" to visible))
    }
}
