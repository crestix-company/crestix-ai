import { z } from "zod";

export const FactSchema = z.object({
  statement: z.string().min(1),
  source_url: z.url().optional(),
});

export const SourceSchema = z.object({
  label: z.string().optional(),
  url: z.url(),
});

export const PreparationResultSchema = z.object({
  facts: z.array(FactSchema).default([]),
  hypotheses: z.array(z.string().min(1)).default([]),
  needs_confirmation: z.array(z.string().min(1)).default([]),
  clinic_summary: z.string().default(""),
  current_measures: z.array(z.string()).default([]),
  medical_services: z.array(z.string()).default([]),
  doctor: z.string().default(""),
  area: z.string().default(""),
  competitors: z.array(z.string()).default([]),
  seo: z.string().default(""),
  meo: z.string().default(""),
  portals: z.array(z.string()).default([]),
  sales_hypotheses: z.array(z.string()).default([]),
  proposal_candidates: z.array(z.string()).default([]),
  objections: z.array(z.string()).default([]),
  recommended_responses: z.array(z.string()).default([]),
  must_ask: z.array(z.string()).default([]),
  withdrawal_conditions: z.array(z.string()).default([]),
  key_points: z.array(z.string()).default([]),
  talk_script_markdown: z.string().min(1),
  sources: z.array(SourceSchema).default([]),
});

export type Fact = z.infer<typeof FactSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type PreparationResult = z.infer<typeof PreparationResultSchema>;
