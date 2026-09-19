import { z } from "zod";

export const MaterialSlideSchema = z.object({
  title: z.string().min(1),
  purpose: z.string().default(""),
  bullets: z.array(z.string()).default([]),
  speaker_notes: z.string().default(""),
  sources: z.array(z.url()).default([]),
});

export const MaterialResultSchema = z.object({
  title: z.string().min(1),
  executive_summary: z.string().min(1),
  slides: z.array(MaterialSlideSchema).min(1),
  document_markdown: z.string().min(1),
});

export type MaterialSlide = z.infer<typeof MaterialSlideSchema>;
export type MaterialResult = z.infer<typeof MaterialResultSchema>;
