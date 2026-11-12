import { afterEach, describe, expect, test } from 'bun:test';
import { sqliteHandle } from '../../database';
import { createPerson } from '../memory/people';
import { evaluateToolCall } from './evaluate';

const created: string[] = [];

afterEach(() => {
  for (const id of created.splice(0)) sqliteHandle.query('DELETE FROM agent_people WHERE id = ?').run(id);
});

const summaryOf = (input: Record<string, unknown>) => evaluateToolCall('mcp__codiby-code__send_message', input).cls.summary;

describe('send_message approvals and the people directory', () => {
  test('name the saved person for a WhatsApp number or a Telegram chat id, however it is written', () => {
    created.push(createPerson({ name: 'Ana López', relation: 'hermana', handles: { whatsapp: ['+52 1 555 000 9999'], telegram: ['7770001'] } }).id);
    expect(summaryOf({ to: '5215550009999@s.whatsapp.net', text: 'hola' })).toBe('Send a message to Ana López <5215550009999@s.whatsapp.net>: hola');
    expect(summaryOf({ to: '5215550009999', text: 'hola' })).toBe('Send a message to Ana López <5215550009999>: hola');
    expect(summaryOf({ to: '7770001', text: 'hola' })).toBe('Send a message to Ana López <7770001>: hola');
    // Nobody saved with it: the address alone.
    expect(summaryOf({ to: '5215550008888@s.whatsapp.net', text: 'hola' })).toBe('Send a message to 5215550008888@s.whatsapp.net: hola');
  });

  test('the rule target stays the bare address', () => {
    created.push(createPerson({ name: 'Bob', handles: { whatsapp: ['5215550007777'] } }).id);
    const { cls } = evaluateToolCall('mcp__codiby-code__send_message', { to: '5215550007777@s.whatsapp.net', text: 'x' });
    expect(cls.summary).toContain('Bob <5215550007777@s.whatsapp.net>');
    expect(cls.target).toBe('5215550007777@s.whatsapp.net');
  });
});
