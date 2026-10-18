import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';

// All named exports from the barrel
import * as rootBarrel from './index';
import {
  createMockClient,
  TestData,
  recordEvaluations,
  createTestDatafile,
  createTestContext,
  createMultiTestContext,
} from './index';
// The React surface lives on its own entry (`@avsbhq/test/react`) so the
// root barrel stays loadable without React installed.
import { AvsbTestProvider, useAvsbTestClient } from './react';

describe('barrel — all exports present', () => {
  it('createMockClient is a function', () => {
    expect(typeof createMockClient).toBe('function');
  });

  it('AvsbTestProvider is a function (React component)', () => {
    expect(typeof AvsbTestProvider).toBe('function');
  });

  it('useAvsbTestClient is a function', () => {
    expect(typeof useAvsbTestClient).toBe('function');
  });

  it('TestData.flag is a static factory method', () => {
    expect(typeof TestData.flag).toBe('function');
  });

  it('recordEvaluations is a function', () => {
    expect(typeof recordEvaluations).toBe('function');
  });

  it('createTestDatafile is a function', () => {
    expect(typeof createTestDatafile).toBe('function');
  });

  it('createTestContext is a function', () => {
    expect(typeof createTestContext).toBe('function');
  });

  it('createMultiTestContext is a function', () => {
    expect(typeof createMultiTestContext).toBe('function');
  });

  it('keeps the React provider OFF the root barrel', () => {
    // The regression this guards: `AvsbTestProvider` sat on the root, so
    // `import { createMockClient } from '@avsbhq/test'` pulled React into the
    // module graph. With React absent that import does not resolve at all, so
    // "React is an optional peer" was false for every Vue, Svelte and plain
    // Node consumer. Re-adding it here would silently undo that.
    expect('AvsbTestProvider' in rootBarrel).toBe(false);
    expect('useAvsbTestClient' in rootBarrel).toBe(false);
  });

  it('keeps the React-free precedence helper ON the root barrel', () => {
    // `resolveTestClient` is what a hand-written wrapper needs, and it
    // touches no React, so moving it would have been an over-correction.
    expect(typeof rootBarrel.resolveTestClient).toBe('function');
  });
});

describe('barrel — integration smoke', () => {
  it('createMockClient + TestData.flag together produce consistent values', () => {
    const entry = TestData.flag('promo')
      .booleanFlag()
      .variationForUser('alice', true)
      .fallthroughVariation(false)
      .build();

    const client = createMockClient({
      flags: { [entry.key]: entry.fallthroughValue },
      context: createTestContext({ key: 'alice' }),
    });

    // alice doesn't get per-user treatment through flags map (just fallthrough)
    const flag = client.getBoolFlag('promo', false);
    expect(flag.exists()).toBe(true);
  });

  it('recordEvaluations works with a client from createMockClient', () => {
    const client = createMockClient({ flags: { exp: 'treatment' } });
    const recorder = recordEvaluations(client);

    client.getStringFlag('exp', 'control');

    expect(() => recorder.toHaveEvaluated('exp').withValue('treatment')).not.toThrow();
    recorder.stop();
  });

  it('AvsbTestProvider renders and provides a client to children', () => {
    function Consumer(): React.ReactElement {
      const c = useAvsbTestClient();
      return <span>{c.getBoolFlag('smoke', false).source}</span>;
    }

    const { container } = render(
      <AvsbTestProvider options={{ flags: { smoke: true } }}>
        <Consumer />
      </AvsbTestProvider>,
    );
    expect(container.textContent).toBe('rule');
  });
});
