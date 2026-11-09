/** wait_for_comments in the relay: back in time, unpaired or not. */
import { expect, it } from 'bun:test';
import { waitForComments } from '../src/mcp.js';
import type { Relay } from '../src/relay.js';

it('returns "not paired, call again" within its limit when no tab pairs', async () => {
  const t = Date.now();
  const r = await waitForComments({ tools: [] } as unknown as Relay, { timeoutSec: 600 }, 1);
  expect(Date.now() - t).toBeLessThan(1500);
  expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ waiting: [], paired: false });
});

it('caps the tab wait and says "nothing new, call again"', async () => {
  let asked = 0;
  const relay = {
    tools: [{ name: 'wait_for_comments' }],
    call: async (_n: string, a: { timeoutSec: number }) => {
      asked = a.timeoutSec;
      return { content: [{ type: 'text', text: JSON.stringify({ waiting: [], timedOut: true }) }], isError: false };
    },
  } as unknown as Relay;
  const r = await waitForComments(relay, { timeoutSec: 600 });
  expect(asked).toBeLessThanOrEqual(45);
  expect((r.content[1] as { text: string }).text).toBe('Nothing new: call wait_for_comments again.');
});
