import { z } from 'zod';
import { isIPv4 } from 'node:net';
export const isPrivateBindHost=(host:string)=>isIPv4(host)&&(host==='127.0.0.1'||/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host));
export class ServiceError extends Error {
  constructor(public status: number, public code: string, message = code) { super(message); }
}
export const purpose = z.enum(['LOGIN', 'PAYMENT', 'PASSWORD_RESET']);
export const lookupSchema = z.object({
  requestUid: z.string().min(1).max(128), attemptUid: z.string().min(1).max(128),
  providerUid: z.string().min(1).max(128), providerName: z.string().max(200).optional(),
  accountUid: z.string().min(1).max(128), targetEmail: z.email().max(254),
  purpose, ruleVersion: z.number().int().positive(), windowStartedAt: z.number().int().positive(),
  lookupDeadlineAt: z.number().int().positive(), otpValiditySeconds: z.number().int().min(1).max(3600).optional(),
  excludedSourceMessageRefs: z.array(z.string().max(255)).max(100).default([])
}).strict();
export type Lookup = z.infer<typeof lookupSchema>;
export const cancelSchema = z.object({
  requestUid:z.string().min(1).max(128),providerUid:z.string().min(1).max(128),accountUid:z.string().min(1).max(128),targetEmail:z.email().max(254),
  lookupDeadlineAt:z.number().int().positive(),commandUid:z.string().min(1).max(128),reason:z.enum(['MANUAL_OVERRIDE','DONE','CANCELLED','SUPERSEDED'])
}).strict();
export type Cancellation = z.infer<typeof cancelSchema>;
export const ruleSchema = z.object({
  providerUid: z.string().min(1).max(128), purpose, version: z.number().int().positive(),
  senders: z.array(z.email()).max(50).default([]), domains: z.array(z.string().regex(/^[a-z0-9.-]+$/i)).max(50).default([]),
  subjectMode: z.enum(['exact', 'contains']), subject: z.string().min(1).max(500),
  purposeMarkers: z.array(z.string().min(2).max(100)).min(1).max(20),
  pattern: z.string().min(1).max(2000), flags: z.string().regex(/^[imu]*$/).default('i'),
  source: z.enum(['body', 'subject', 'both']).default('body'),
  stripSpaces: z.boolean().default(false), stripHyphens: z.boolean().default(false),
  minLength: z.number().int().min(1).max(32).default(4), maxLength: z.number().int().min(1).max(32).default(32)
}).strict().refine(r => r.senders.length + r.domains.length > 0, 'Sender rule required')
  .refine(r => r.minLength <= r.maxLength, 'Invalid code length');
export type Rule = z.infer<typeof ruleSchema>;
export type Message = {ref: string; sender: string; subject: string; body: string; receivedAt: number; purpose?: string; expiresAt?: number};
export type Result = {outcome: 'FOUND'|'NOT_FOUND'|'AMBIGUOUS'|'SECURITY_ALERT'|'EMAIL_NOT_FOUND'; code?: string; sourceMessageRef?: string; receivedAt?: number; expiresAt?: number; expirySource?:string; purpose?: string};
export type Profile = {uid: string; email: string; directory: string; enabled: number; verified: number; revision: number};
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
