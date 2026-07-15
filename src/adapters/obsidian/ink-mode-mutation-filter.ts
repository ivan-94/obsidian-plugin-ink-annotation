const INK_SURFACE_SELECTOR = '.inkstone-ink-surface';

/** Prevents plugin-owned Canvas/status DOM writes from recursively scheduling Ink reconciliation. */
export function shouldReconcileInkMutations(mutations: readonly MutationRecord[]): boolean {
  return mutations.some((mutation) => {
    const target =
      mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
    if (target !== null && target.closest(INK_SURFACE_SELECTOR) !== null) return false;

    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return (
      changedNodes.length === 0 ||
      changedNodes.some((node) => {
        if (node instanceof Element) {
          return !(
            node.matches(INK_SURFACE_SELECTOR) || node.closest(INK_SURFACE_SELECTOR) !== null
          );
        }
        return (
          node.parentElement === null || node.parentElement.closest(INK_SURFACE_SELECTOR) === null
        );
      })
    );
  });
}
