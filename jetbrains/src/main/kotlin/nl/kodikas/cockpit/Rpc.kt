package nl.kodikas.cockpit

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import java.io.BufferedReader
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Newline-delimited JSON-RPC with the sidecar (see src/sidecar/rpc.ts). A request has an `id` and
 * gets one reply; a notification has none. Handlers run on the reader thread's pool, never block it.
 */
class Rpc(private val input: BufferedReader, private val output: OutputStream, private val pool: (Runnable) -> Unit) {
    private val gson = Gson()
    private val seq = AtomicInteger()
    private val waiting = ConcurrentHashMap<Int, CompletableFuture<JsonElement>>()
    private val handlers = ConcurrentHashMap<String, (JsonElement) -> Any?>()

    fun on(method: String, handler: (JsonElement) -> Any?) {
        handlers[method] = handler
    }

    fun notify(method: String, params: Any? = null) {
        val msg = JsonObject().apply {
            addProperty("method", method)
            if (params != null) add("params", gson.toJsonTree(params))
        }
        write(msg)
    }

    fun request(method: String, params: Any? = null): CompletableFuture<JsonElement> {
        val id = seq.incrementAndGet()
        val future = CompletableFuture<JsonElement>()
        waiting[id] = future
        val msg = JsonObject().apply {
            addProperty("id", id)
            addProperty("method", method)
            if (params != null) add("params", gson.toJsonTree(params))
        }
        write(msg)
        return future
    }

    @Synchronized
    private fun write(msg: JsonObject) {
        output.write((gson.toJson(msg) + "\n").toByteArray(Charsets.UTF_8))
        output.flush()
    }

    /** Reads until the sidecar's stdout closes. */
    fun run() {
        while (true) {
            val line = input.readLine() ?: break
            if (line.isBlank()) continue
            val msg = try {
                gson.fromJson(line, JsonObject::class.java)
            } catch (_: Exception) {
                continue
            }
            dispatch(msg)
        }
        waiting.values.forEach { it.completeExceptionally(IllegalStateException("sidecar closed")) }
        waiting.clear()
    }

    private fun dispatch(msg: JsonObject) {
        val id = msg.get("id")?.takeIf { it.isJsonPrimitive }?.asInt
        val method = msg.get("method")?.takeIf { it.isJsonPrimitive }?.asString
        if (method == null) {
            val future = id?.let { waiting.remove(it) } ?: return
            val error = msg.get("error")
            if (error != null && !error.isJsonNull) future.completeExceptionally(RuntimeException(error.asString))
            else future.complete(msg.get("result") ?: JsonNull.INSTANCE)
            return
        }
        val handler = handlers[method]
        val params = msg.get("params") ?: JsonNull.INSTANCE
        pool {
            if (id == null) {
                runCatching { handler?.invoke(params) }
                return@pool
            }
            val reply = JsonObject().apply { addProperty("id", id) }
            if (handler == null) {
                reply.addProperty("error", "unknown method $method")
            } else {
                try {
                    val result = handler(params)
                    reply.add("result", if (result == null) JsonNull.INSTANCE else gson.toJsonTree(result))
                } catch (e: Exception) {
                    reply.addProperty("error", e.message ?: e.toString())
                }
            }
            write(reply)
        }
    }
}
