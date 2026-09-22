import { describe, expect, it } from 'vitest';

import {
  extractProgressSummary,
  imageActivityResult,
  isToolFailureResult,
} from '../agent/agentServer/toolLoop';
import {
  buildTranscript,
  completedTranscriptSnapshot,
  findTranscriptBlockContent,
  hasLegacyDeferredContentIds,
  InvalidTranscriptCursorError,
  latestTranscriptTurn,
  markdownBoundaryPreview,
  paginateTranscript,
  previewTranscript,
  transcriptContentId,
  transcriptPageLimit,
} from '../agent/agentServer/transcript';

describe('Agent Chat progress summaries', () => {
  it('does not require a summary for routine tool activity', () => {
    expect(extractProgressSummary('')).toBeNull();
  });

  it('forwards only explicitly tagged progress text', () => {
    expect(extractProgressSummary('private scratch text')).toBeNull();
    expect(
      extractProgressSummary(
        'hidden prefix <progress_summary>I found the relevant files and will inspect the event flow next.</progress_summary> hidden suffix',
      ),
    ).toBe('I found the relevant files and will inspect the event flow next.');
  });

  it('normalizes one paragraph, strips nested markup, redacts secrets, and caps 150 words', () => {
    const longText = Array.from({ length: 270 }, () => 'observable').join(' ');
    const summary = extractProgressSummary(
      `<progress_summary>First line\n\n<unsafe>tag</unsafe> api_key=do-not-show ${longText}</progress_summary>`,
    );

    expect(summary).not.toContain('\n');
    expect(summary).not.toContain('do-not-show');
    expect(summary).toContain('api_key=[REDACTED]');
    expect(summary?.split(/\s+/)).toHaveLength(150);
    expect(summary?.endsWith('…')).toBe(true);
  });

  it('reconstructs paired tool input and output metadata for reopened chats', () => {
    const transcript = buildTranscript([
      { role: 'user', content: 'Inspect the project' },
      {
        role: 'assistant',
        content:
          '<progress_summary>I found the project root and will inspect its files next.</progress_summary>',
        tool_calls: [{ id: 'call-1', name: 'shell_script', arguments: { script: 'rg --files' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        tool_name: 'shell_script',
        content: 'TERMINAL OUTPUT:\nSources/App.swift',
      },
      { role: 'assistant', content: '<final_answer>Done.</final_answer>' },
    ]);

    const blocks = transcript[1].blocks ?? [];
    expect(blocks.map((block) => block.kind)).toEqual([
      'agentReasoning',
      'shellCommand',
      'terminalOutput',
      'finalAnswer',
    ]);
    expect(blocks[1]).toMatchObject({
      text: 'rg --files',
      activityId: 'call-1',
      activityPhase: 'started',
    });
    expect(blocks[2]).toMatchObject({
      activityId: 'call-1',
      activityPhase: 'completed',
    });
  });

  it('preserves tool invocations when the provider emits no assistant text', () => {
    const transcript = buildTranscript([
      { role: 'user', content: 'Inspect the project' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-empty', name: 'shell_script', arguments: { script: 'pwd' } }],
      },
    ]);

    expect(transcript[1].blocks).toEqual([
      expect.objectContaining({
        kind: 'shellCommand',
        text: 'pwd',
        activityId: 'call-empty',
        activityPhase: 'started',
      }),
    ]);
  });

  it('sanitizes persisted progress summaries before replaying them', () => {
    const transcript = buildTranscript([
      { role: 'user', content: 'Continue the task' },
      {
        role: 'assistant',
        content:
          '<progress_summary><b>Validated</b> the change. api_key=replayed-secret sk-abcdefghijklmnop</progress_summary>',
        tool_calls: [{ id: 'call-1', name: 'shell_script', arguments: { script: 'true' } }],
      },
    ]);

    const summary = transcript[1].blocks?.find((block) => block.kind === 'agentReasoning')?.text;
    expect(summary).toBe('Validated the change. api_key=[REDACTED] [REDACTED]');
    expect(summary).not.toContain('<b>');
    expect(summary).not.toContain('replayed-secret');
  });

  it('keeps image failure text, error metadata, and lifecycle phase consistent', () => {
    expect(imageActivityResult('Error generating image: provider unavailable')).toEqual({
      content: 'Error generating image: provider unavailable',
      isError: true,
      phase: 'failed',
    });
    expect(imageActivityResult('/tmp/render.png')).toEqual({
      content: 'Image saved to: /tmp/render.png',
      isError: false,
      phase: 'completed',
    });
  });

  it('recognizes supported text and structured tool failures case-insensitively', () => {
    expect(isToolFailureResult('error: provider unavailable')).toBe(true);
    expect(isToolFailureResult('ERROR generating image')).toBe(true);
    expect(isToolFailureResult('Command error: exit 2')).toBe(true);
    expect(isToolFailureResult('Command failed: exit 2')).toBe(true);
    expect(isToolFailureResult('{"ok":false,"error":"denied"}')).toBe(true);
    expect(isToolFailureResult('{"success":false}')).toBe(true);
    expect(isToolFailureResult('{"ok":true,"result":"Error handling was tested"}')).toBe(false);
    expect(isToolFailureResult('Successful result')).toBe(false);
  });
});

describe('Agent transcript pagination', () => {
  const transcript = buildTranscript(
    Array.from({ length: 8 }, (_, index) => [
      { role: 'user', content: `Question ${index}` },
      {
        role: 'assistant',
        content: `<progress_summary>Finding ${index}</progress_summary>`,
        tool_calls: [
          { id: `call-${index}`, name: 'shell_script', arguments: { script: `echo ${index}` } },
        ],
      },
      {
        role: 'tool',
        tool_name: 'shell_script',
        tool_call_id: `call-${index}`,
        content: `TERMINAL OUTPUT:\n${index}`,
      },
      { role: 'assistant', content: `<final_answer>Answer ${index}</final_answer>` },
    ]).flat(),
  );

  it('returns newest complete messages followed by the immediately preceding page', () => {
    const newest = paginateTranscript(transcript, 'session-a', 5);
    const older = paginateTranscript(transcript, 'session-a', 5, newest.pageInfo.startCursor);

    expect(newest.messages).toEqual(transcript.slice(-5));
    expect(older.messages).toEqual(transcript.slice(-10, -5));
    expect(new Set([...older.messages, ...newest.messages].map((message) => message.id)).size).toBe(
      10,
    );
    expect(
      newest.messages
        .flatMap((message) => message.blocks ?? [])
        .some((block) => block.kind === 'finalAnswer'),
    ).toBe(true);
  });

  it('keeps an older cursor stable when new turns are appended', () => {
    const newest = paginateTranscript(transcript, 'session-a', 4);
    const appended = [...transcript, { id: 'new-user', role: 'user' as const, text: 'New' }];
    expect(
      paginateTranscript(appended, 'session-a', 4, newest.pageInfo.startCursor).messages,
    ).toEqual(transcript.slice(-8, -4));
  });

  it('rejects malformed and cross-session cursors and caps limits', () => {
    const page = paginateTranscript(transcript, 'session-a', 4);
    expect(() => paginateTranscript(transcript, 'session-b', 4, page.pageInfo.startCursor)).toThrow(
      InvalidTranscriptCursorError,
    );
    expect(() => paginateTranscript(transcript, 'session-a', 4, 'not-a-cursor')).toThrow(
      InvalidTranscriptCursorError,
    );
    expect(transcriptPageLimit('500')).toBe(50);
    expect(() => transcriptPageLimit('bad')).toThrow(InvalidTranscriptCursorError);
  });

  it('rejects a cursor after earlier history is pruned or rewritten', () => {
    const page = paginateTranscript(transcript, 'session-a', 4);
    const pruned = transcript.slice(2);
    expect(() => paginateTranscript(pruned, 'session-a', 4, page.pageInfo.startCursor)).toThrow(
      InvalidTranscriptCursorError,
    );
  });

  it('loads the latest user and assistant turn without falling back past a trailing request', () => {
    const latest = latestTranscriptTurn(transcript, 'session-a');
    expect(latest.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    const latestBlocks = latest.messages[1].blocks ?? [];
    expect(latestBlocks[latestBlocks.length - 1]?.kind).toBe('finalAnswer');

    const interrupted = latestTranscriptTurn(
      [...transcript, { id: 'trailing-user', role: 'user', text: 'Are you there?' }],
      'session-a',
    );
    expect(interrupted.messages).toEqual([
      expect.objectContaining({ id: 'trailing-user', role: 'user', text: 'Are you there?' }),
    ]);
  });

  it('handles empty, user-only, and interrupted assistant histories deterministically', () => {
    expect(latestTranscriptTurn([], 'session-a').messages).toEqual([]);
    expect(
      latestTranscriptTurn([{ id: 'u', role: 'user', text: 'Pending' }], 'session-a').messages,
    ).toHaveLength(1);
    const interrupted = latestTranscriptTurn(
      [
        { id: 'u', role: 'user', text: 'Run it' },
        {
          id: 'a',
          role: 'assistant',
          text: 'Stopped',
          blocks: [
            {
              id: 'b',
              kind: 'shellCommand',
              text: 'long task',
              activityPhase: 'cancelled',
            },
          ],
        },
      ],
      'session-a',
    );
    expect(interrupted.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(interrupted.messages[1].blocks?.[0].activityPhase).toBe('cancelled');
  });

  it('serves and snapshots a newer unfinished tool turn instead of hiding it', () => {
    const messages = [
      {
        id: 'complete',
        role: 'assistant' as const,
        text: 'Complete answer',
        blocks: [{ id: 'final', kind: 'finalAnswer' as const, text: 'Complete answer' }],
      },
      { id: 'new-user', role: 'user' as const, text: 'Start another task' },
      {
        id: 'incomplete',
        role: 'assistant' as const,
        text: 'Running a tool',
        blocks: [{ id: 'tool', kind: 'shellCommand' as const, text: 'swift test' }],
      },
    ];

    expect(latestTranscriptTurn(messages, 'session-a').messages).toEqual(messages.slice(1));
    expect(completedTranscriptSnapshot(messages)).toEqual(messages);
  });

  it('returns boundary-safe metadata for oversized answers and tool output', () => {
    const fenced = `Intro\n\n\`\`\`swift\n${'x'.repeat(20_000)}\n\`\`\`\n\nConclusion`;
    const preview = markdownBoundaryPreview(fenced, 16_000);
    expect(preview).toBe('Intro');

    const result = previewTranscript([
      {
        id: 'assistant-large',
        role: 'assistant',
        text: fenced,
        blocks: [
          { id: 'tool-large', kind: 'terminalOutput', text: 'x'.repeat(14_000) },
          { id: 'final-large', kind: 'finalAnswer', text: fenced },
        ],
      },
    ]);
    expect(result[0].blocks?.[0]).toMatchObject({
      contentId: transcriptContentId({ kind: 'terminalOutput', text: 'x'.repeat(14_000) }),
      contentLength: 14_000,
      isContentTruncated: true,
    });
    expect(result[0].blocks?.[1]).toMatchObject({
      contentId: transcriptContentId({ kind: 'finalAnswer', text: fenced }),
      isContentTruncated: true,
      text: 'Intro',
    });
    expect(result[0].text).toBe('Intro');
  });

  it('does not resolve a stale content ID after positional blocks are renumbered', () => {
    const originalBlock = {
      id: 'block-5',
      kind: 'finalAnswer' as const,
      text: `Original\n\n${'a'.repeat(20_000)}`,
    };
    const replacementBlock = {
      id: 'block-5',
      kind: 'finalAnswer' as const,
      text: `Replacement\n\n${'b'.repeat(20_000)}`,
    };
    const oldContentId = previewTranscript([
      { id: 'assistant-old', role: 'assistant', text: originalBlock.text, blocks: [originalBlock] },
    ])[0].blocks?.[0].contentId;

    expect(oldContentId).toBe(transcriptContentId(originalBlock));
    expect(transcriptContentId(replacementBlock)).not.toBe(oldContentId);
    expect(findTranscriptBlockContent([replacementBlock], oldContentId!)).toBeNull();
    expect(findTranscriptBlockContent([originalBlock], oldContentId!)).toBe(originalBlock.text);
    expect(
      hasLegacyDeferredContentIds([
        {
          id: 'legacy',
          role: 'assistant',
          text: 'Preview',
          blocks: [
            {
              id: 'block-5',
              kind: 'finalAnswer',
              text: 'Preview',
              isContentTruncated: true,
              contentId: 'block-5',
            },
          ],
        },
      ]),
    ).toBe(true);
    expect(
      hasLegacyDeferredContentIds(
        previewTranscript([
          {
            id: 'safe',
            role: 'assistant',
            text: originalBlock.text,
            blocks: [originalBlock],
          },
        ]),
      ),
    ).toBe(false);
  });
});
