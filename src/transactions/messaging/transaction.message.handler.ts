import { CreditTransaction } from 'aries-controller/agent/messaging/credit.transaction';
import { Logger } from 'protocol-common/logger';
import { SecurityUtility } from 'protocol-common/security.utility';
import { ProtocolHttpService } from 'protocol-common/protocol.http.service';
import { AgentService } from 'aries-controller/agent/agent.service';
import { AgentTransaction } from '../persistence/agent.transaction';
import { DataService } from '../persistence/data.service';
import { IBasicMessageHandler } from './basic.message.handler';
import { TransactionMessageStatesEnum } from './transaction.message.states.enum';


export class TransactionMessageHandler implements IBasicMessageHandler {
    constructor(private readonly agentService: AgentService,
                private readonly agentId: string,
                private readonly adminApiKey: string,
                private readonly connectionId: string,
                private readonly dbAccessor: DataService,
                private readonly http: ProtocolHttpService) {
    }

    public async respond(message: any): Promise<boolean> {
        if (message.state === TransactionMessageStatesEnum.STARTED) {
            // TODO fix the credential ID problem.  Solution is to add more states and have this code in a later
            // state handler
            // TODO validation
            // TODO: theres possible collision here if two transactions came in at the same time
            const maxMerkleOrder: number = await this.dbAccessor.getMaxMerkelOrder();
            const record: AgentTransaction = new AgentTransaction();
            record.agent_id = this.agentId;
            record.transaction_id = message.id;
            record.event_date = message.transaction.eventDate;
            record.issuer_hash = message.transaction.fspHash;
            record.fsp_id = message.transaction.fspId;
            record.merkel_order = maxMerkleOrder + 1;
            record.merkel_hash = this.generateTransactionId(message.transaction.fspHash);
            record.credential_id = message.credentialId;
            record.transaction_date = message.transaction.date;
            record.type_id = message.transaction.typeId;
            record.subject_id = message.transaction.subjectId;
            record.amount = message.transaction.amount;
            record.transaction_details = message.transaction.eventJson;
            // TODO: what should we do on error
            await this.dbAccessor.saveTransaction(record);

            // TODO: eval -> not sure we really need to wait for this
            Logger.debug('replying \'accepted\' to transaction start message');
            await this.sendTransactionMessage(this.agentId, this.adminApiKey, this.connectionId, TransactionMessageStatesEnum.ACCEPTED,
                message.id, message.transaction).then();
        } else if (message.state === TransactionMessageStatesEnum.COMPLETED) {
            Logger.info(`transaction ${message.id as string} is complete`);
            // TODO: do we need to note transaction state?
        }
        return false;
    }


    private async sendTransactionMessage(agentId: string, adminApiKey: string, connectionId: string,
                                         state: string, id: string, eventJson: any): Promise<any> {
        /*
        const msg: CreditTransaction<any> = new CreditTransaction<any>({
            state,
            id,
            transaction: eventJson
        });
        return await this.agentService.sendBasicMessage(msg, connectionId);
        */
        const url = `http://${agentId}:${process.env.AGENT_ADMIN_PORT}/connections/${connectionId}/send-message`;
        const msg: CreditTransaction<any> = new CreditTransaction<any>({
            state,
            id,
            transaction: eventJson
        });
        const data = { content: JSON.stringify(msg) };
        const req: any = {
            method: 'POST',
            url,
            headers: {
                'x-api-key': adminApiKey,
            },
            data
        };

        Logger.debug(`sendTransactionMessage to ${connectionId}`, msg);
        const res = await this.http.requestWithRetry(req);
        Logger.debug(`${agentId} sendTransactionMessage results`, res.data);
        return res.data;
    }

    private generateTransactionId(hashableValue: string) : string {
        return SecurityUtility.hash32(hashableValue);
    }
}
