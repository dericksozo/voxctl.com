import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort error boundary. In a packaged app the webview has no dev overlay,
 * so an uncaught render error would otherwise unmount the whole tree and leave a
 * blank window. This catches that and shows a recoverable message instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("VOXCTL render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: 32,
            textAlign: "center",
            font: "13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
            color: "#0c0d0f",
            background: "#e9ebee",
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "0.2em" }}>VOXCTL</div>
          <div style={{ color: "#5c6268" }}>Something went wrong while rendering the interface.</div>
          {import.meta.env.DEV ? (
            <pre
              style={{
                maxWidth: 640,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                textAlign: "left",
                color: "#d80077",
                background: "rgba(255,255,255,0.6)",
                padding: 12,
                borderRadius: 6,
              }}
            >
              {this.state.error.message}
            </pre>
          ) : null}
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{
              font: "inherit",
              padding: "8px 14px",
              cursor: "pointer",
              background: "rgba(255,255,255,0.7)",
              border: "1px solid rgba(16,20,26,0.16)",
              borderRadius: 6,
            }}
          >
            RETRY
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
