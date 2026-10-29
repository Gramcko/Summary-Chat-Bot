import { z } from "zod";

/**
 * Provider configuration as returned to the browser.
 * Deliberately contains no key field of any kind: saved credentials are
 * masked by construction and cannot leak through this type. Reads only
 * report whether a key is saved.
 */
export const ProviderConfigPublic = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  baseUrl: z.url().max(500).nullable(),
  hasApiKey: z.boolean(),
});

/**
 * Write shape for provider configuration. Omit `apiKey` to keep the
 * currently saved key; a string replaces it; explicit null clears it.
 */
export const ProviderConfigUpdate = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  baseUrl: z.url().max(500).nullable().optional(),
  apiKey: z.string().min(1).max(500).nullable().optional(),
});

export type ProviderConfigPublic = z.infer<typeof ProviderConfigPublic>;
export type ProviderConfigUpdate = z.infer<typeof ProviderConfigUpdate>;
