import type { GitFileEntry, RepoStatus } from "@zashiki/shared";
import { useTranslation } from "react-i18next";
import type { GitApi } from "../api/git.js";
import { codeClass, fileRowKey } from "./source-control-model.js";

export interface GitFileRowProps {
  api: GitApi;
  repo: RepoStatus;
  staged: boolean;
  file: GitFileEntry;
  copiedKey: string | null;
  run(action: Promise<void>): void;
  copy(text: string, rowKey: string): void;
}

/** One changed/staged file: status code, path (click to open), copy path, and stage/unstage. */
export function GitFileRow({
  api,
  repo,
  staged,
  file,
  copiedKey,
  run,
  copy,
}: GitFileRowProps) {
  const { t } = useTranslation();
  const rowKey = fileRowKey(repo.path, staged, file.code, file.path);
  return (
    <div className="git-file-row">
      <span className={codeClass(file.code)}>{file.code}</span>
      <button
        type="button"
        className="view-row git-file-name"
        title={file.path}
        onClick={() => run(api.open(repo.path, file.path))}
      >
        {file.path}
      </button>
      <span className="git-row-actions">
        <button
          type="button"
          aria-label={`copy ${file.path}`}
          title={t("common.copyAbsPath")}
          onClick={() => copy(`${repo.path}/${file.path}`, rowKey)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            content_copy
          </span>
        </button>
        {staged ? (
          <button
            type="button"
            aria-label={`unstage ${file.path}`}
            title="Unstage"
            onClick={() => run(api.unstage(repo.path, file.path))}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              remove
            </span>
          </button>
        ) : (
          <button
            type="button"
            aria-label={`stage ${file.path}`}
            title="Stage"
            onClick={() => run(api.stage(repo.path, file.path))}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              add
            </span>
          </button>
        )}
        {copiedKey === rowKey && (
          <span className="git-copied-popup" role="status">
            copied!
          </span>
        )}
      </span>
    </div>
  );
}
