/** The server's origin: the page's own, or in development the server's beside the Vite page. */
export function serverBase(): string {
  return (
    (import.meta.env.VITE_ZK_SERVER as string | undefined) ??
    window.location.origin
  );
}
