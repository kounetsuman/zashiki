import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A boundary that catches uncaught exceptions during render and swaps in a fallback.
 *
 * Background: a single terminal's (TerminalView) render exception once propagated
 * to the root and left the whole app rendering empty. To localize this, the
 * fallback is made pluggable so a boundary can be placed around each child tree.
 * The fallback receives the current error and a reset that clears the boundary's
 * state and remounts the children.
 *
 * React error boundaries can only be implemented as classes, so this alone is a class.
 */
interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    const { fallback } = this.props;
    return typeof fallback === "function"
      ? fallback(error, this.reset)
      : fallback;
  }
}
