// Shared constants for the session image element. Kept free of the component
// import so the Markdown renderer (and its tests) do not have to pull a .vue
// module into scope just to know the tag name.

export const SESSION_IMAGE_TAG = 'obelisk-session-image';

// Fired from inside the session image element (composed, so it crosses the
// shadow boundary) once the image has either decoded or failed. The virtualized
// timeline uses it to tell real media growth apart from an estimate correction.
export const SESSION_IMAGE_SETTLED_EVENT = 'obelisk-session-image-settled';
