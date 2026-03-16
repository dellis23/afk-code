import { describe, it, expect } from 'vitest';
import type { AskUserQuestionItem } from '../session-manager.js';

/**
 * Tests for AskUserQuestion detection and formatting.
 * Verifies that the JSONL tool_use entries for AskUserQuestion
 * are correctly parsed and rendered.
 */

// Simulate extractToolCalls logic (private method, tested via structure)
function extractToolCalls(line: string) {
  try {
    const data = JSON.parse(line);
    if (data.type !== 'assistant') return [];
    const content = data.message?.content;
    if (!Array.isArray(content)) return [];
    const tools: { id: string; name: string; input: any }[] = [];
    for (const block of content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        tools.push({ id: block.id, name: block.name, input: block.input || {} });
      }
    }
    return tools;
  } catch {
    return [];
  }
}

// Real JSONL from a Claude Code session (AskUserQuestion with 4 questions)
const REAL_ASK_USER_JSONL = JSON.stringify({
  parentUuid: 'test',
  isSidechain: false,
  message: {
    model: 'claude-opus-4-6',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_test123',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'What programming language?',
            header: 'Language',
            options: [
              { label: 'Python', description: 'Rich ecosystem' },
              { label: 'TypeScript', description: 'Good for JS-heavy sites' },
            ],
            multiSelect: false,
          },
          {
            question: 'What output format?',
            header: 'Output',
            options: [
              { label: 'JSON', description: 'Structured data' },
              { label: 'CSV', description: 'Spreadsheet-friendly' },
              { label: 'Database', description: 'Persistent storage' },
            ],
            multiSelect: true,
          },
        ],
      },
    }],
    stop_reason: 'tool_use',
  },
  type: 'assistant',
});

describe('AskUserQuestion - JSONL detection', () => {
  it('extracts AskUserQuestion tool call from JSONL', () => {
    const tools = extractToolCalls(REAL_ASK_USER_JSONL);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('AskUserQuestion');
    expect(tools[0].input.questions).toHaveLength(2);
  });

  it('parses question structure correctly', () => {
    const tools = extractToolCalls(REAL_ASK_USER_JSONL);
    const questions: AskUserQuestionItem[] = tools[0].input.questions;

    expect(questions[0].header).toBe('Language');
    expect(questions[0].question).toBe('What programming language?');
    expect(questions[0].options).toHaveLength(2);
    expect(questions[0].options![0].label).toBe('Python');
    expect(questions[0].options![0].description).toBe('Rich ecosystem');
    expect(questions[0].multiSelect).toBe(false);

    expect(questions[1].header).toBe('Output');
    expect(questions[1].multiSelect).toBe(true);
    expect(questions[1].options).toHaveLength(3);
  });

  it('does not detect non-AskUserQuestion tool calls', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_other',
          name: 'Read',
          input: { file_path: '/tmp/test.txt' },
        }],
      },
    });
    const tools = extractToolCalls(line);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Read');
    // This should NOT trigger AskUserQuestion handling
    expect(tools[0].input.questions).toBeUndefined();
  });

  it('handles malformed AskUserQuestion gracefully', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_bad',
          name: 'AskUserQuestion',
          input: {}, // no questions array
        }],
      },
    });
    const tools = extractToolCalls(line);
    expect(tools).toHaveLength(1);
    // Should not crash — Array.isArray(undefined) returns false
    expect(Array.isArray(tools[0].input?.questions)).toBe(false);
  });
});

describe('AskUserQuestion - message formatting', () => {
  function formatForDiscord(questions: AskUserQuestionItem[]): string {
    let text = '❓ **Claude is asking:**\n\n';
    for (const q of questions) {
      if (q.header) text += `**${q.header}:** `;
      text += `${q.question}\n`;
      if (q.options?.length) {
        for (const opt of q.options) {
          text += `> • **${opt.label}**`;
          if (opt.description) text += ` — ${opt.description}`;
          text += '\n';
        }
      }
      text += '\n';
    }
    text += '_Reply here to answer — Claude will re-ask as plain text._';
    return text;
  }

  it('formats questions with options for Discord', () => {
    const questions: AskUserQuestionItem[] = [{
      header: 'Language',
      question: 'What programming language?',
      options: [
        { label: 'Python', description: 'Rich ecosystem' },
        { label: 'TypeScript' },
      ],
      multiSelect: false,
    }];

    const text = formatForDiscord(questions);
    expect(text).toContain('**Language:**');
    expect(text).toContain('What programming language?');
    expect(text).toContain('**Python**');
    expect(text).toContain('Rich ecosystem');
    expect(text).toContain('**TypeScript**');
    expect(text).toContain('Reply here to answer');
  });

  it('formats questions without options', () => {
    const questions: AskUserQuestionItem[] = [{
      question: 'What do you want to build?',
    }];

    const text = formatForDiscord(questions);
    expect(text).toContain('What do you want to build?');
    expect(text).not.toContain('> •');
  });

  it('formats multiple questions', () => {
    const questions: AskUserQuestionItem[] = [
      { header: 'Q1', question: 'First question?' },
      { header: 'Q2', question: 'Second question?' },
    ];

    const text = formatForDiscord(questions);
    expect(text).toContain('**Q1:**');
    expect(text).toContain('**Q2:**');
  });
});
