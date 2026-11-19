import "@xterm/xterm/css/xterm.css";
import "material-symbols/outlined.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, Trans } from "react-i18next";
import { App } from "./App.js";
import { createCockpitTerminalsApi } from "./api/cockpit-terminals.js";
import { createCrashApi } from "./api/crash.js";
import { createDashboardApi } from "./api/dashboard.js";
import { createFilesApi } from "./api/files.js";
import { createFilesListApi } from "./api/files-list.js";
import { createFsApi } from "./api/fs.js";
import { createGitApi } from "./api/git.js";
import { createReposApi } from "./api/repos.js";
import { createSearchApi } from "./api/search.js";
import i18n from "./i18n/index.js";
import {
  createTauriPopOutApi,
  popOutCockpitTerminalId,
  popOutSupported,
  popOutUrl,
} from "./lib/pop-out.js";
import { serverBase } from "./lib/server-base.js";
import { resolveToken, stripTokenFromSearch } from "./lib/token.js";
import { controlWsUrl, termWsUrl } from "./lib/url.js";
import { PopOutAwareSession } from "./session/pop-out-aware-session.js";
import { TerminalSession } from "./session/terminal-session.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { PopOutApp } from "./ui/PopOutApp.js";
import { ControlClient } from "./ws/control.js";
import { openTermSocket } from "./ws/term.js";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found");
}
const root = createRoot(rootElement);

const token = resolveToken(window.location.search, window.sessionStorage);
const popOutOf = popOutCockpitTerminalId(window.location.search);
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
  const base = serverBase();
  const control = new ControlClient({ url: controlWsUrl(base, token) });
  control.connect();
  const terminalSession = new TerminalSession({
    control,
    openTermSocket: (termId, handlers) =>
      openTermSocket(termWsUrl(base, termId, token), handlers),
  });
  const popOut = popOutSupported()
    ? createTauriPopOutApi((id) => popOutUrl(window.location, id, token))
    : undefined;
  const gitApi = createGitApi(base, token);
  const fsApi = createFsApi(base, token);
  const searchApi = createSearchApi(base, token);
  const filesApi = createFilesApi(base, token);
  const filesListApi = createFilesListApi(base, token);
  const reposApi = createReposApi(base, token);
  const crashApi = createCrashApi(base, token);
  const dashboardApi = createDashboardApi(base, token);
  const cockpitTerminalsApi = createCockpitTerminalsApi(base, token);
  if (popOutOf !== null) terminalSession.select(popOutOf);
  const returnToMain = (): void => {
    if (popOutOf === null) return;
    if (popOut === undefined) window.close();
    else void popOut.close(popOutOf).catch(() => window.close());
  };
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
          {popOutOf !== null ? (
            <PopOutApp
              control={control}
              session={terminalSession}
              cockpitTerminalId={popOutOf}
              onReturn={returnToMain}
            />
          ) : (
            <App
              control={control}
              session={new PopOutAwareSession(terminalSession)}
              gitApi={gitApi}
              fsApi={fsApi}
              searchApi={searchApi}
              filesApi={filesApi}
              filesListApi={filesListApi}
              reposApi={reposApi}
              crashApi={crashApi}
              dashboardApi={dashboardApi}
              cockpitTerminalsApi={cockpitTerminalsApi}
              popOut={popOut}
            />
          )}
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>,
  );
}
