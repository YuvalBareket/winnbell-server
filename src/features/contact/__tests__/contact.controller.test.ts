/**
 * QA Tests — submitContactMessage (contact.controller.ts)
 *
 * Covers:
 *   happy path        — trims fields, sends the support email, 200
 *   honeypot          — hidden "website" field filled -> fake success, NOTHING sent
 *   validation        — name/email/topic/message rules -> 400, email never called
 *   send failure      — email service throws -> 500 friendly message
 */

const mockSend = jest.fn();

jest.mock('../../../shared/email/email.service.js', () => ({
  sendContactMessageEmail: (...args: unknown[]) => mockSend(...args),
}));

import { submitContactMessage, CONTACT_TOPICS } from '../contact.controller';
import type { Request, Response } from 'express';

const run = async (body: Record<string, unknown>) => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { json, status } as unknown as Response;
  await submitContactMessage({ body } as Request, res);
  return { json, status };
};

const validBody = {
  fullName: '  Jane Doe  ',
  email: '  JANE@Example.com ',
  topic: CONTACT_TOPICS[0],
  message: '  Hello, I need help with my entry.  ',
};

beforeEach(() => jest.clearAllMocks());

describe('submitContactMessage', () => {
  test('sends the support email with trimmed/normalized fields and returns success', async () => {
    mockSend.mockResolvedValueOnce(undefined);
    const { json, status } = await run(validBody);
    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ success: true });
    expect(mockSend).toHaveBeenCalledWith({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      topic: CONTACT_TOPICS[0],
      message: 'Hello, I need help with my entry.',
    });
  });

  test('honeypot filled -> fake success, nothing sent', async () => {
    const { json, status } = await run({ ...validBody, website: 'http://spam.example' });
    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ success: true });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each([
    ['missing name', { ...validBody, fullName: '  ' }],
    ['name too long', { ...validBody, fullName: 'x'.repeat(101) }],
    ['bad email', { ...validBody, email: 'not-an-email' }],
    ['unknown topic', { ...validBody, topic: 'Hacked topic' }],
    ['missing message', { ...validBody, message: '' }],
    ['message too long', { ...validBody, message: 'x'.repeat(2001) }],
  ])('%s -> 400, email never called', async (_label, body) => {
    const { status } = await run(body);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('email service failure -> 500 with a friendly message', async () => {
    mockSend.mockRejectedValueOnce(new Error('smtp down'));
    const { status } = await run(validBody);
    expect(status).toHaveBeenCalledWith(500);
  });
});
