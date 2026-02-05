import { Module } from '@nestjs/common'
import { DbModule } from '~/db/db.module'
import { ReservationModule } from '~/app/reservation/reservation.module'
import { PayKeeperController } from './paykeeper.controller'
import { PayKeeperService } from './paykeeper.service'

@Module({
  imports: [DbModule, ReservationModule],
  controllers: [PayKeeperController],
  providers: [PayKeeperService],
  exports: [PayKeeperService],
})
export class PayKeeperModule {}
