/**
 * The auto-import list against the real package.
 *
 * An auto-import that names a composable `@avsbhq/vue` does not export fails
 * at build time in the app, far from this list, with a message about an
 * unresolved import. So the list is checked against the package's actual
 * exports here: rename a composable upstream and this test goes red instead.
 *
 * Requires @avsbhq/vue to be built (the workspace link resolves to its dist),
 * which the package build order already covers: core, utils, browser, vue.
 */
import { describe, expect, it } from 'vitest';
import * as avsbVue from '@avsbhq/vue';
import { AVSB_VUE_AUTO_IMPORTS } from './autoImports';

const exported: Record<string, unknown> = avsbVue;

describe('AVSB_VUE_AUTO_IMPORTS', () => {
  it('names only functions that @avsbhq/vue really exports', () => {
    const missing = AVSB_VUE_AUTO_IMPORTS.filter((name) => typeof exported[name] !== 'function');

    expect(missing).toEqual([]);
  });

  it('covers every composable the package exports', () => {
    const composables = Object.keys(exported).filter(
      (name) => name.startsWith('use') && typeof exported[name] === 'function',
    );
    const uncovered = composables.filter(
      (name) => !AVSB_VUE_AUTO_IMPORTS.some((imported) => imported === name),
    );

    expect(uncovered).toEqual([]);
  });

  it('lists each name once', () => {
    expect(new Set(AVSB_VUE_AUTO_IMPORTS).size).toBe(AVSB_VUE_AUTO_IMPORTS.length);
  });

  it('leaves the provider and the plugin out, since the module installs one itself', () => {
    for (const name of ['AvsbProvider', 'AvsbPlugin', 'AvsbInjectionKey']) {
      expect(AVSB_VUE_AUTO_IMPORTS.some((imported) => imported === name)).toBe(false);
      // They are still real exports; the point is that they are not auto-imported.
      expect(exported[name]).toBeDefined();
    }
  });
});
