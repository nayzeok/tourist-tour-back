import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

export const RequestPasswordSchema = z.object({
  email: z.string().email(),
})

export class RequestPasswordDto extends createZodDto(RequestPasswordSchema) {}
