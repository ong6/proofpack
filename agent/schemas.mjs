import { z } from 'zod';
const text = max => z.string().max(max);
const required = max => z.string().trim().min(1).max(max);
const visibility = z.enum(['internal', 'customer']);
const links = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(500);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const records = {
  charter: z.strictObject({ title: text(4000), customer: text(4000), objective: text(4000), owners: text(4000), startDate: z.union([date, z.literal('')]), endDate: z.union([date, z.literal('')]), internalNotes: text(4000), demo: z.boolean() }),
  criteria: z.strictObject({ name: required(200), metric: required(4000), baseline: required(4000), threshold: required(4000), owner: required(200), targetDate: date, visibility }),
  evidence: z.strictObject({ name: required(200), summary: required(4000), source: text(4000), owner: required(200), collectedAt: date, staleAfterDays: z.number().int().min(1).max(3650), criterionIds: links, visibility }),
  risks: z.strictObject({ name: required(200), detail: text(4000), owner: required(200), severity: z.enum(['low', 'medium', 'high']), status: z.enum(['open', 'mitigated', 'accepted', 'closed']), mitigation: text(4000), criterionIds: links, visibility }),
  decisions: z.strictObject({ name: required(200), detail: required(4000), owner: required(200), date, criterionIds: links, visibility }),
  checklist: z.strictObject({ name: required(200), detail: text(4000), owner: required(200), dueDate: date, done: z.boolean(), visibility }),
};
export const edit = z.union(Object.entries(records).map(([section, schema]) => z.strictObject({ section: z.literal(section), fields: schema.partial() })));
