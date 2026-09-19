import { describe, expect, it } from 'vitest';

import { AgentTranscriptMessage } from '../models/agentTranscriptMessage';

describe('AgentTranscriptMessage indexes', () => {
  it('declares one unambiguous index name for each field set', () => {
    const indexes = AgentTranscriptMessage.options.indexes ?? [];
    const names = indexes.map((index) => index.name);

    expect(new Set(names).size).toBe(names.length);
    expect(
      indexes.filter(
        (index) => JSON.stringify(index.fields) === JSON.stringify(['session_id', 'sequence']),
      ),
    ).toHaveLength(1);
  });
});
