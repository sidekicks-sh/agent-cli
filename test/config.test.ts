import { describe, expect, it } from 'bun:test'

import { readConfig } from '../src/config'

describe('config validation', () => {
  it('applies defaults and keeps custom as default backend', () => {
    const config = readConfig({})

    expect(config.agent).toBe('custom')
    expect(config.pollIntervalSeconds).toBe(10)
    expect(config.logBatchSize).toBe(20)
  })

  it('rejects invalid backend values', () => {
    expect(() =>
      readConfig({
        SIDEKICK_AGENT: 'invalid-backend',
      }),
    ).toThrow('Invalid environment config')
  })

  it('rejects non-positive integer polling config', () => {
    expect(() =>
      readConfig({
        SIDEKICK_POLL_INTERVAL: '0',
      }),
    ).toThrow('SIDEKICK_POLL_INTERVAL must be a positive integer')
  })
})
