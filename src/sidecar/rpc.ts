// Newline-delimited JSON-RPC between the sidecar and the IDE plugin, over stdio.
// A request has an `id` and gets one reply; a notification has none. Either side can send both.
import type { Readable, Writable } from 'node:stream';

export type RpcHandler = (params: any) => unknown | Promise<unknown>;

export class RpcPeer {
  private seq = 0;
  private readonly waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly handlers = new Map<string, RpcHandler>();
  private buffer = '';

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.onData(chunk));
    input.on('close', () => {
      for (const w of this.waiting.values()) w.reject(new Error('rpc closed'));
      this.waiting.clear();
    });
  }

  /** Handles a request or notification from the peer. */
  on(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  private write(msg: unknown): void {
    this.output.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.dispatch(JSON.parse(line));
      } catch {
        /* not JSON: ignore */
      }
    }
  }

  private dispatch(msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: string }): void {
    if (msg.method === undefined) {
      const w = msg.id === undefined ? undefined : this.waiting.get(msg.id);
      if (!w || msg.id === undefined) return;
      this.waiting.delete(msg.id);
      if (msg.error !== undefined) w.reject(new Error(msg.error));
      else w.resolve(msg.result);
      return;
    }
    const handler = this.handlers.get(msg.method);
    if (msg.id === undefined) {
      if (handler) void Promise.resolve(handler(msg.params)).catch(() => undefined);
      return;
    }
    const id = msg.id;
    if (!handler) {
      this.write({ id, error: `unknown method ${msg.method}` });
      return;
    }
    Promise.resolve(handler(msg.params)).then(
      (result) => this.write({ id, result: result ?? null }),
      (e) => this.write({ id, error: String(e instanceof Error ? e.message : e) }),
    );
  }
}
