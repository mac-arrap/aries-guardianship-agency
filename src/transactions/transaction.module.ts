import { Module, HttpModule } from '@nestjs/common';
import { AgentModule } from 'aries-controller/agent/agent.module';
import { AgentGovernanceFactory } from 'aries-controller/controller/agent.governance.factory';
import { GlobalCacheModule } from '../app/global.cache.module';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { DataService } from './persistence/data.service';
import { TransactionMessageResponseFactory } from './messaging/transaction.message.response.factory';

/**
 *
 */
@Module({
    imports: [
        AgentModule,
        HttpModule,
        GlobalCacheModule,
    ],
    controllers: [TransactionController],
    providers: [
        AgentGovernanceFactory,
        TransactionService,
        DataService,
        TransactionMessageResponseFactory
    ],
})
export class TransactionModule {}
