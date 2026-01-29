import { Module } from '@nestjs/common'
import { DbModule } from '~/db/db.module'
import { PayKeeperController } from './paykeeper.controller'
import { PayKeeperService } from './paykeeper.service'

@Module({
  imports: [DbModule],
  controllers: [PayKeeperController],
  providers: [PayKeeperService],
  exports: [PayKeeperService],
})
export class PayKeeperModule {}
