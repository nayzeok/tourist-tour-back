import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

export const RegisterSchema = z.object({
  email: z.string().trim().email(),
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(3).optional(),
  password: z.string().min(8),
})

export class RegisterDto extends createZodDto(RegisterSchema) {}
