import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
})

export class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}
