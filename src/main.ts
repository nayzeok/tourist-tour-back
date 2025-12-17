import { NestFactory } from '@nestjs/core'
import { AppModule } from '~/app.module'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { ConfigService, ConfigType } from '@nestjs/config'
import fastifyCookie from '@fastify/cookie'
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify'
import fastifyHelmet from '@fastify/helmet'
import { randomUUID } from 'crypto'
import { ZodValidationPipe } from 'nestjs-zod'
import { cleanupOpenApiDoc } from 'nestjs-zod'
import authConfig from '~/config/auth.config'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      genReqId: () => randomUUID(),
    }),
    {
      bufferLogs: true,
    },
  )

  await app.register(fastifyHelmet)

  const configService = app.get(ConfigService)

  const nodeEnv = configService.get<string>('NODE_ENV')
  const auth = configService.get<ConfigType<typeof authConfig>>('auth')

  await app.register(fastifyCookie, {
    parseOptions: {
      domain: auth?.cookieDomain,
      path: '/',
      httpOnly: true,
      maxAge: auth ? Math.floor(auth.cookieMaxAgeMs / 1000) : 60 * 60 * 24 * 7, // 7 дней в секундах
      secure: auth?.cookieSecure ?? nodeEnv === 'production',
      sameSite: auth?.cookieSameSite ?? 'lax',
      signed: false,
    },
  })

  if (configService.get<string>('NODE_ENV') !== 'production') {
    const options = new DocumentBuilder()
      .setTitle('travel')
      .setVersion('1.0')
      .build()

    const document = SwaggerModule.createDocument(app, options)

    // Настраиваем Swagger
    SwaggerModule.setup('api', app, cleanupOpenApiDoc(document))
  }

  // Глобальный пайп для валидации через Zod
  app.useGlobalPipes(new ZodValidationPipe())

  app.enableCors({
    origin: true,
    methods: ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'GET'],
    credentials: true,
  })

  // app.enableCors({
  //   origin: ['https://tourist-tours.ru'],
  //   methods: ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'GET'],
  //   credentials: true,
  // })

  app.enableShutdownHooks()
  // app.useLogger(['error', 'warn'])

  await app.listen(configService.getOrThrow<number>('PORT'), '0.0.0.0', () => {
    console.log(
      `Worker ${process.pid} started, listening on port ${configService.getOrThrow<number>('PORT')}
___________________________________________________________________________________________
    `,
    )
  })
}

bootstrap()
