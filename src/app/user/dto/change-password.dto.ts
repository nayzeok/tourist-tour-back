import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(6),
    newPassword: z
      .string()
      .min(8)
      .refine((value) => /[a-zA-Z]/.test(value) && /\d/.test(value), {
        message: 'Password must contain letters and numbers',
      }),
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must differ from the current password',
    path: ['newPassword'],
  })

export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
