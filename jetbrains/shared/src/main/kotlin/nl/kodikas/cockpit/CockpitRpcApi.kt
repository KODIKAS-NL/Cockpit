@file:Suppress("UnstableApiUsage")

package nl.kodikas.cockpit

import com.intellij.platform.project.ProjectId
import com.intellij.platform.rpc.RemoteApiProviderService
import fleet.rpc.RemoteApi
import fleet.rpc.Rpc
import fleet.rpc.remoteApiDescriptor
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable

/** Where the sidecar listens, on the machine that runs the backend. */
@Serializable
data class SidecarInfoDto(val port: Int = 0, val token: String = "", val error: String? = null)

/** A scratchpad board the sidecar wants shown as an editor tab. */
@Serializable
data class PadRequestDto(val key: String, val title: String)

/** The frontend (tool window, browser) talking to the backend (the sidecar and the editor). */
@Rpc
interface CockpitRpcApi : RemoteApi<Unit> {
    companion object {
        suspend fun getInstance(): CockpitRpcApi = RemoteApiProviderService.resolve(remoteApiDescriptor<CockpitRpcApi>())
    }

    /** Starts the sidecar for the project (once) and returns where it listens. */
    suspend fun start(projectId: ProjectId, theme: String): SidecarInfoDto
    suspend fun command(projectId: ProjectId, id: String)
    suspend fun theme(projectId: ProjectId, css: String)
    suspend fun sidebarVisible(projectId: ProjectId, visible: Boolean)
    suspend fun padRequests(projectId: ProjectId): Flow<PadRequestDto>
}
