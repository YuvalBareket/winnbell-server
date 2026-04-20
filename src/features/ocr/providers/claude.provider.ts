// TODO: Claude Haiku Vision provider — drop-in upgrade from Tesseract
// To activate: set OCR_PROVIDER=claude in .env and npm install @anthropic-ai/sdk
// Cost: ~$0.0003–0.0005 per image vs $0 for Tesseract but much higher accuracy
//
// import Anthropic from '@anthropic-ai/sdk';
// import type { OcrProvider, OcrExpected, OcrValidationResult } from '../ocr.types.js';
//
// export class ClaudeProvider implements OcrProvider {
//   private client = new Anthropic();
//
//   async validate(imageUrl: string, expected: OcrExpected): Promise<OcrValidationResult> {
//     const response = await fetch(imageUrl);
//     const buffer = Buffer.from(await response.arrayBuffer());
//     const base64 = buffer.toString('base64');
//     const mediaType = 'image/jpeg'; // detect from URL/headers if needed
//
//     const message = await this.client.messages.create({
//       model: 'claude-haiku-4-5-20251001',
//       max_tokens: 256,
//       messages: [{
//         role: 'user',
//         content: [
//           { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
//           { type: 'text', text: `You are a receipt validator. The user submitted:
// - Identifier: ${expected.identifier}
// - Amount: ${expected.amount}
// - Date: ${expected.date ?? 'not provided'}
//
// Look at this image and respond ONLY with valid JSON (no markdown):
// {"isReceipt":bool,"identifierFound":bool,"amountMatches":bool,"dateMatches":bool|null,"confidence":"high"|"medium"|"low"}` }
//         ],
//       }],
//     });
//
//     const content = message.content[0];
//     if (content.type !== 'text') throw new Error('Unexpected Claude response type');
//     return JSON.parse(content.text) as OcrValidationResult;
//   }
// }

export {};
