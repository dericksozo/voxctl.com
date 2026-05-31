import { useEffect, useRef } from "react";
import { listen, type Event } from "@tauri-apps/api/event";

/** Subscribe to a backend event for the lifetime of the component.
 *  The callback is kept in a ref so re-renders don't churn the listener. */
export function useTauriEvent<T>(name: string, handler: (payload: T) => void) {
  const cb = useRef(handler);
  cb.current = handler;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<T>(name, (e: Event<T>) => cb.current(e.payload)).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [name]);
}
