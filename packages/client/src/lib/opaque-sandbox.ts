/**
 * The sandbox of every frame that runs content's own scripts (the dashboard, the HTML preview): an
 * opaque origin. Sandbox flags are fixed for the frame's lifetime while the document in it can
 * navigate, so this is the only form under which no document the frame ever holds can become
 * same-origin with the cockpit and reach the app's token, storage, or API.
 */
export const OPAQUE_SCRIPT_SANDBOX = "allow-scripts";
