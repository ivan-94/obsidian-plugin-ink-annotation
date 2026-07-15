// @vitest-environment jsdom

import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { createPreactIsland } from './mount-preact-island';
import { createObsidianUiEnvironment, type ObsidianUiEnvironment } from './obsidian-ui-environment';
import { PortalRoot } from './portal-root';

describe('Obsidian UI environment', () => {
  afterEach(() => document.body.replaceChildren());

  it('portals into the island owner document and removes the portal on unmount', async () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const ownerDocument = iframe.contentDocument;
    const ownerWindow = iframe.contentWindow;
    if (ownerDocument === null || ownerWindow === null) throw new Error('Missing iframe document.');
    const container = ownerDocument.createElement('div');
    ownerDocument.body.append(container);
    const environment = createObsidianUiEnvironment(container);
    const island = createPreactIsland(PortalProbe);

    expect(environment.document).toBe(ownerDocument);
    expect(environment.window).toBe(ownerWindow);
    expect(environment.portalRoot).toBe(ownerDocument.body);

    await act(() => island.mount(container, { environment }));
    expect(ownerDocument.body.querySelector('[data-portal-probe]')).not.toBeNull();
    expect(document.body.querySelector('[data-portal-probe]')).toBeNull();

    await act(() => island.unmount());
    expect(ownerDocument.body.querySelector('[data-portal-probe]')).toBeNull();
  });
});

function PortalProbe({ environment }: { readonly environment: ObsidianUiEnvironment }) {
  return (
    <PortalRoot environment={environment}>
      <button data-portal-probe type="button">
        Portal action
      </button>
    </PortalRoot>
  );
}
