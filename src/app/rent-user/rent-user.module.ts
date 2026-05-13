import { Module, forwardRef } from '@nestjs/common'
import { RentUserService } from './rent-user.service'
import { RentUserController } from './rent-user.controller'
import { DbModule } from '~/db/db.module'
import { AuthModule } from '~/app/auth/auth.module'
import { UserModule } from '~/app/user/user.module'
import { MailModule } from '~/services/mail.module'
import { PayKeeperModule } from '~/app/paykeeper/paykeeper.module'

@Module({
  imports: [DbModule, AuthModule, UserModule, MailModule, forwardRef(() => PayKeeperModule)],
  controllers: [RentUserController],
  providers: [RentUserService],
  exports: [RentUserService],
})
export class RentUserModule {}
