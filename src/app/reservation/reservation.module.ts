// src/app/reservation/reservation.module.ts
import { Module } from '@nestjs/common'
import { ReservationController } from './reservation.controller'
import { ReservationService } from './reservation.service'
import { OAuthModule } from '~/services'
import { OfferModule } from '~/app/offer/offer.module'
import { AuthModule } from '~/app/auth/auth.module'
import { UserModule } from '~/app/user/user.module'
import { MailModule } from '~/services/mail.module'
import { RedisModule } from '~/redis/redis.module'

@Module({
  imports: [OfferModule, OAuthModule, AuthModule, UserModule, MailModule, RedisModule],
  controllers: [ReservationController],
  providers: [ReservationService],
  exports: [ReservationService],
})
export class ReservationModule {}
