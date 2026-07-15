export interface ObsidianUiEnvironment {
  readonly document: Document;
  readonly portalRoot: HTMLElement;
  readonly window: Window;
}

export function createObsidianUiEnvironment(container: HTMLElement): ObsidianUiEnvironment {
  const ownerDocument = container.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) {
    throw new Error('The UI island owner document is not attached to a window.');
  }
  return {
    document: ownerDocument,
    portalRoot: ownerDocument.body,
    window: ownerWindow,
  };
}
