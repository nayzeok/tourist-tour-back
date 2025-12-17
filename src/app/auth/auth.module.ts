import { forwardRef, Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { ConfigModule, ConfigService, ConfigType } from '@nestjs/config'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { UserModule } from '~/app/user/user.module'
import { MailModule } from '~/services/mail.module'
import { JwtAuthGuard } from '~/guards/jwt-auth.guard'
import authConfig from '~/config/auth.config'

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => UserModule),
    MailModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<ConfigType<typeof authConfig>>('auth')
        const secret = auth?.jwtSecret ?? 'dev-secret-change-me'
        const expiresIn = auth?.accessTokenTtl ?? '7d'
        return {
          secret,
          signOptions: { expiresIn },
        }
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
