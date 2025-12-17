import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'

import { LoggerModule } from 'nestjs-pino'
import { randomUUID } from 'crypto'
import { DbModule } from './db/db.module'
import redisConfig from './config/redis.config'
import oauthConfig from './config/oauth.config'
import authConfig from './config/auth.config'
import mailConfig from './config/mail.config'
import { CitiesModule } from '~/app/cities/cities.module'
import { HttpModule } from '@nestjs/axios'
import { MailModule, OAuthModule } from '~/services'
import { SearchModule } from '~/app/search/search.module'
import { OfferModule } from './app/offer/offer.module'
import { RedisModule } from '~/redis/redis.module'
import { ReservationModule } from '~/app/reservation/reservation.module'
import { AuthModule } from '~/app/auth/auth.module'
import { UserModule } from '~/app/user/user.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [redisConfig, oauthConfig, authConfig, mailConfig],
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProduction = config.get<string>('NODE_ENV') === 'production'

        return {
          pinoHttp: {
            name: 'backend',
            level: config.get<string>('APP_LOG_LEVEL', 'info'),
            autoLogging: false,
            ...(isProduction
              ? {}
              : {
                  transport: {
                    target: 'pino-pretty',
                    options: { colorize: true },
                  },
                }),

            redact: ['req'],
            genReqId: (req) => req.headers['x-request-id'] ?? randomUUID(),
          },
        }
      },
    }),

    HttpModule,
    RedisModule,
    DbModule,
    OAuthModule,
    MailModule,
    CitiesModule,
    SearchModule,
    OfferModule,
    ReservationModule,
    UserModule,
    AuthModule,
  ],

  controllers: [],
  providers: [],
})
export class AppModule {}
