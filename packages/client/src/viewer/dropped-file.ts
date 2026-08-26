/** Whether the drag carries OS files (as opposed to an in-page drag such as tab reordering). */
export function dragCarriesFiles(dataTransfer: DataTransfer | null): boolean {
  return (
    dataTransfer !== null && Array.from(dataTransfer.types).includes("Files")
  );
}

/** The OS files a drop carries, or [] when it carries none. */
export function droppedFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dragCarriesFiles(dataTransfer)) return [];
  return Array.from((dataTransfer as DataTransfer).files);
}
