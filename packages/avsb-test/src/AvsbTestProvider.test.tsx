import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { AvsbTestProvider, useAvsbTestClient } from './AvsbTestProvider'
import { createMockClient } from './createMockClient'

// Consumer component that reads a flag via the test context
function FlagConsumer({ flagKey }: { flagKey: string }): React.ReactElement {
  const client = useAvsbTestClient()
  const flag = client.getBoolFlag(flagKey, false)
  return <span data-testid="flag-value">{String(flag.value)}</span>
}

// Consumer that reads a string flag
function StringFlagConsumer({ flagKey }: { flagKey: string }): React.ReactElement {
  const client = useAvsbTestClient()
  const flag = client.getStringFlag(flagKey, 'default')
  return <span data-testid="string-flag">{flag.value}</span>
}

describe('AvsbTestProvider — rendering', () => {
  it('renders children without error', () => {
    const { container } = render(
      <AvsbTestProvider options={{ flags: { 'test-flag': true } }}>
        <div data-testid="child">hello</div>
      </AvsbTestProvider>
    )
    expect(container.querySelector('[data-testid="child"]')).not.toBeNull()
  })

  it('provides mock client so child can read flag values', () => {
    render(
      <AvsbTestProvider options={{ flags: { 'show-promo': true } }}>
        <FlagConsumer flagKey="show-promo" />
      </AvsbTestProvider>
    )
    expect(screen.getByTestId('flag-value').textContent).toBe('true')
  })

  it('provides false for absent flags', () => {
    render(
      <AvsbTestProvider>
        <FlagConsumer flagKey="missing-flag" />
      </AvsbTestProvider>
    )
    expect(screen.getByTestId('flag-value').textContent).toBe('false')
  })
})

describe('AvsbTestProvider — pre-created client', () => {
  it('accepts an externally created MockClient', () => {
    const client = createMockClient({ flags: { 'hero': 'variant-b' } })
    render(
      <AvsbTestProvider client={client}>
        <StringFlagConsumer flagKey="hero" />
      </AvsbTestProvider>
    )
    expect(screen.getByTestId('string-flag').textContent).toBe('variant-b')
  })

  it('uses the pre-created client so test can call _setFlag to update it', () => {
    const client = createMockClient({ flags: { 'theme': 'light' } })

    const { rerender } = render(
      <AvsbTestProvider client={client}>
        <StringFlagConsumer flagKey="theme" />
      </AvsbTestProvider>
    )
    expect(screen.getByTestId('string-flag').textContent).toBe('light')

    // Mutate via test API and force re-render
    client._setFlag('theme', 'dark')
    rerender(
      <AvsbTestProvider client={client}>
        <StringFlagConsumer flagKey="theme" />
      </AvsbTestProvider>
    )
    expect(screen.getByTestId('string-flag').textContent).toBe('dark')
  })
})

describe('useAvsbTestClient — error boundary', () => {
  it('throws when used outside a provider', () => {
    // Suppress expected console.error from React
    const originalError = console.error
    console.error = () => {}

    expect(() => {
      render(<FlagConsumer flagKey="some-flag" />)
    }).toThrow(/no MockClient found/)

    console.error = originalError
  })
})

describe('AvsbTestProvider — context isolation', () => {
  it('nested providers provide independent clients', () => {
    const outerClient = createMockClient({ flags: { 'x': 'outer' } })
    const innerClient = createMockClient({ flags: { 'x': 'inner' } })

    function OuterConsumer(): React.ReactElement {
      const client = useAvsbTestClient()
      return <span data-testid="outer">{client.getStringFlag('x', '').value}</span>
    }

    function InnerConsumer(): React.ReactElement {
      const client = useAvsbTestClient()
      return <span data-testid="inner">{client.getStringFlag('x', '').value}</span>
    }

    render(
      <AvsbTestProvider client={outerClient}>
        <OuterConsumer />
        <AvsbTestProvider client={innerClient}>
          <InnerConsumer />
        </AvsbTestProvider>
      </AvsbTestProvider>
    )

    expect(screen.getByTestId('outer').textContent).toBe('outer')
    expect(screen.getByTestId('inner').textContent).toBe('inner')
  })
})
