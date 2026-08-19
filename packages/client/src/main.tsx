import "@xterm/xterm/css/xterm.css";
import "material-symbols/outlined.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, Trans } from "react-i18next";
import { App } from "./App.js";
import { createCrashApi } from "./api/crash.js";
import { createFilesApi } from "./api/files.js";
import { createFsApi } from "./api/fs.js";
import { createGitApi } from "./api/git.js";
import { createReposApi } from "./api/repos.js";
import { createSearchApi } from "./api/search.js";
import i18n from "./i18n/index.js";
import { resolveToken, stripTokenFromSearch } from "./lib/token.js";
import { controlWsUrl, termWsUrl } from "./lib/url.js";
import { TerminalSession } from "./session/terminal-session.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { ControlClient } from "./ws/control.js";
import { openTermSocket } from "./ws/term.js";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found");
}
const root = createRoot(rootElement);

const token = resolveToken(window.location.search, window.sessionStorage);
// Do not leave the token in the URL (history / bookmarks)
window.history.replaceState(
  null,
  "",
  window.location.pathname +
    stripTokenFromSearch(window.location.search) +
    window.location.hash,
);

if (token === null) {
  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <main className="token-missing">
          <h1>zashiki</h1>
          <p>
            <Trans
              i18nKey="boot.tokenMissing"
              components={{ code: <code /> }}
            />
          </p>
        </main>
      </I18nextProvider>
    </StrictMode>,
  );
} else {
  // In development, connect from Vite (:5173) to the server on a different port
  const base: string =
    (import.meta.env.VITE_ZK_SERVER as string | undefined) ??
    window.location.origin;
  const control = new ControlClient({ url: controlWsUrl(base, token) });
  control.connect();
  const session = new TerminalSession({
    control,
    openTermSocket: (termId, handlers) =>
      openTermSocket(termWsUrl(base, termId, token), handlers),
  });
  const gitApi = createGitApi(base, token);
  const fsApi = createFsApi(base, token);
  const searchApi = createSearchApi(base, token);
  const filesApi = createFilesApi(base, token);
  const reposApi = createReposApi(base, token);
  const crashApi = createCrashApi(base, token);
  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary
          fallback={(error) => (
            <main className="app-crash" role="alert">
              <h1>zashiki</h1>
              <p>{i18n.t("boot.crashMessage")}</p>
              <pre className="app-crash-message">{error.message}</pre>
              <button
                type="button"
                className="app-crash-reload"
                onClick={() => window.location.reload()}
              >
                {i18n.t("boot.reload")}
              </button>
            </main>
          )}
        >
          <App
            control={control}
            session={session}
            gitApi={gitApi}
            fsApi={fsApi}
            searchApi={searchApi}
            filesApi={filesApi}
            reposApi={reposApi}
            crashApi={crashApi}
          />
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>,
  );
}
