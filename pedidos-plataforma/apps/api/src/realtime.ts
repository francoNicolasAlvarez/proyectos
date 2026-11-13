import type { Realtime } from './notifications';

/**
 * Difusión en memoria dentro de un proceso. Con varias instancias del servidor hay que reemplazarla por
 * Redis pub/sub (misma interfaz): cada instancia reenvía a sus propios clientes conectados.
 */
export class InMemoryHub implements Realtime {
  private readonly subs = new Map<string, Set<(message: Record<string, unknown>) => void>>();

  subscribe(channel: string, fn: (message: Record<string, unknown>) => void): () => void {
    let set = this.subs.get(channel);
    if (!set) { set = new Set(); this.subs.set(channel, set); }
    set.add(fn);
    return () => { set?.delete(fn); if (set && set.size === 0) this.subs.delete(channel); };
  }

  publish(channel: string, message: Record<string, unknown>): void {
    for (const fn of [...(this.subs.get(channel) ?? [])]) {
      try { fn(message); } catch { /* un cliente roto no afecta a los demás */ }
    }
  }

  subscriberCount(channel: string): number { return this.subs.get(channel)?.size ?? 0; }
}
