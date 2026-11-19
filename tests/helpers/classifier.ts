import type { Classification, Classifier, ClassifyInput } from '../../src/llm.js';

export type Hint = { ref: string; kind: 'CODE' | 'LINK'; value: string; purpose?: string };

// Codes carry a digit; preferring one keeps prose words like `Your` from winning the scan.
const firstCode = (body: string) =>
  body.match(/\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,8}\b/)?.[0] ?? body.match(/\b[A-Za-z0-9]{4,8}\b/)?.[0];

export function stubClassifier(hints: Hint[] = [], calls: { count: number } = { count: 0 }): Classifier {
  return {
    async classify(input: ClassifyInput): Promise<Classification | null> {
      calls.count++;
      for (const [index, message] of input.messages.entries()) {
        const hint = hints.find(h => h.ref === message.ref);
        if (hint) return { pick: index + 1, kind: hint.kind, value: hint.value, purpose: hint.purpose ?? input.purpose, reason: 'stub' };
      }
      for (const [index, message] of input.messages.entries()) {
        if (hints.some(h => h.ref === message.ref)) continue;
        const value = firstCode(message.body);
        if (value) return { pick: index + 1, kind: 'CODE', value, purpose: input.purpose, reason: 'stub' };
      }
      return null;
    }
  };
}
