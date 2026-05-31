import { useEffect, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");

/** Self-contained ticking clock. Owns its interval so the rest of the app
 *  never re-renders on the second. */
export function Clock() {
  const [time, setTime] = useState("");
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, []);
  return <span className="gr-v num">{time}</span>;
}
