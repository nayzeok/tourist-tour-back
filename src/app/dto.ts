import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

export const HelloDto = z.object({
  message: z.string(),
})

export class HelloDtoClassSwagger extends createZodDto(HelloDto) {}
