import { z } from "zod";

export const PasswordPolicy = z.string().min(12).max(200);

export const SetupStatus = z.object({
  needsSetup: z.boolean(),
});

export const CreateAdminRequest = z.object({
  password: PasswordPolicy,
});

/**
 * Recovery codes are returned exactly once, at setup. Only their hashes
 * are stored; losing them means recovering through the server-side CLI.
 */
export const CreateAdminResponse = z.object({
  recoveryCodes: z.array(z.string().min(1).max(100)).length(10),
});

export const LoginRequest = z.object({
  password: z.string().min(1).max(200),
});

export const RecoverRequest = z.object({
  recoveryCode: z.string().min(1).max(100),
  newPassword: PasswordPolicy,
});

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: PasswordPolicy,
});

export const OkResponse = z.object({
  ok: z.literal(true),
});

export type PasswordPolicy = z.infer<typeof PasswordPolicy>;
export type SetupStatus = z.infer<typeof SetupStatus>;
export type CreateAdminRequest = z.infer<typeof CreateAdminRequest>;
export type CreateAdminResponse = z.infer<typeof CreateAdminResponse>;
export type LoginRequest = z.infer<typeof LoginRequest>;
export type RecoverRequest = z.infer<typeof RecoverRequest>;
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
export type OkResponse = z.infer<typeof OkResponse>;
