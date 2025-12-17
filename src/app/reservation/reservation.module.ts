// src/app/reservation/reservation.module.ts
import { Module } from '@nestjs/common'
import { ReservationController } from './reservation.controller'
import { ReservationService } from './reservation.service'
import { OAuthModule } from '~/services'
import { OfferModule } from '~/app/offer/offer.module' // твой уже существующий
import { AuthModule } from '~/app/auth/auth.module'
import { UserModule } from '~/app/user/user.module'
import { MailModule } from '~/services/mail.module'

@Module({
  imports: [OfferModule, OAuthModule, AuthModule, UserModule, MailModule],
  controllers: [ReservationController],
  providers: [ReservationService],
})
export class ReservationModule {}
