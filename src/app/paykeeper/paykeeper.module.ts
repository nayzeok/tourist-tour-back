import { Module, forwardRef } from '@nestjs/common'
import { DbModule } from '~/db/db.module'
import { ReservationModule } from '~/app/reservation/reservation.module'
import { PayKeeperController } from './paykeeper.controller'
import { PayKeeperService } from './paykeeper.service'
import { RentProgModule } from '~/app/rentprog/rentprog.module'

@Module({
  imports: [DbModule, ReservationModule, forwardRef(() => RentProgModule)],
  controllers: [PayKeeperController],
  providers: [PayKeeperService],
  exports: [PayKeeperService],
})
export class PayKeeperModule {}
