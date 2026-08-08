/**
 * Tiny typed event emitter.
 *
 * Deliberately not the callback-bag pattern: listeners survive disconnect and
 * reconnect, so a session instance can be reused without silently going deaf.
 */

export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

export class Emitter<EventMap extends Record<string, unknown>> {
  private listeners = new Map<keyof EventMap, Set<Listener<never>>>();

  on<K extends keyof EventMap>(
    event: K,
    listener: Listener<EventMap[K]>,
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      this.listeners.get(event)?.delete(listener as Listener<never>);
    };
  }

  once<K extends keyof EventMap>(
    event: K,
    listener: Listener<EventMap[K]>,
  ): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy so a listener that unsubscribes mid-emit doesn't skip its neighbour.
    for (const listener of [...set]) {
      try {
        (listener as Listener<EventMap[K]>)(payload);
      } catch (e) {
        // A throwing listener must not tear down the session.
        console.warn("[react-native-realtime-voice] listener threw:", e);
      }
    }
  }

  removeAllListeners(event?: keyof EventMap): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }
}
