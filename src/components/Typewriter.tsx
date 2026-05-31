import { useEffect, useState } from "react";

/** Types out `text` when `run` is true; renders it instantly otherwise.
 *  Local-only state so the typing animation never re-renders ancestors. */
export function Typewriter({
  text,
  run,
  speed = 12,
  caret,
}: {
  text: string;
  run: boolean;
  speed?: number;
  caret?: boolean;
}) {
  const [out, setOut] = useState(run ? "" : text);
  useEffect(() => {
    if (!run) {
      setOut(text);
      return;
    }
    setOut("");
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setOut(text.slice(0, i));
      if (i >= text.length) clearInterval(iv);
    }, speed);
    return () => clearInterval(iv);
  }, [text, run, speed]);
  return (
    <>
      {out}
      {caret ? <span className="caret">█</span> : null}
    </>
  );
}
